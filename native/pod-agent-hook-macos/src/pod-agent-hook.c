// Fork-only (Pod): Claude Code's managed status hook as one process, no shell. Same contract as
// claude-hook.sh (src/main/claude/hook-script.ts): "{}" on stdout, the hook JSON from stdin (trailing
// newlines stripped, as $(cat) does), the pane's metadata and the agent process POSTed to the
// runtime's hook server, spooled when the server can't be reached.
// `pod-agent-hook statusline` is claude-statusline.sh (src/main/claude/statusline-script.ts) the
// same way: nothing on stdout, the payload's rate limits POSTed at most once per pane per interval.
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <libproc.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/sysctl.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>

#define MAX_PAYLOAD (16 * 1024 * 1024)
#define SPOOL_CAP 5242880L

typedef struct { char *data; size_t len, cap; } buf_t;

static void buf_put(buf_t *b, const char *s, size_t n) {
  if (b->len + n + 1 > b->cap) {
    size_t cap = b->cap ? b->cap : 4096;
    while (b->len + n + 1 > cap) cap *= 2;
    char *next = realloc(b->data, cap);
    if (!next) exit(0);
    b->data = next; b->cap = cap;
  }
  memcpy(b->data + b->len, s, n);
  b->len += n;
  b->data[b->len] = 0;
}
static void buf_str(buf_t *b, const char *s) { buf_put(b, s, strlen(s)); }

static const char *env(const char *name) {
  const char *v = getenv(name);
  return v ? v : "";
}

// The endpoint file's KEY=value lines override the environment, as `. "$ORCA_AGENT_HOOK_ENDPOINT"` does.
static char ep_port[64], ep_token[512], ep_env[128], ep_version[64], ep_transport[64];
static const char *port, *token, *hook_env, *version, *transport;

static void read_endpoint_file(void) {
  port = env("ORCA_AGENT_HOOK_PORT"); token = env("ORCA_AGENT_HOOK_TOKEN");
  hook_env = env("ORCA_AGENT_HOOK_ENV"); version = env("ORCA_AGENT_HOOK_VERSION");
  transport = env("ORCA_AGENT_HOOK_TRANSPORT");
  const char *path = env("ORCA_AGENT_HOOK_ENDPOINT");
  if (!*path || access(path, R_OK) != 0) return;
  transport = "";  // unset ORCA_AGENT_HOOK_TRANSPORT
  FILE *f = fopen(path, "r");
  if (!f) return;
  char line[1024];
  while (fgets(line, sizeof line, f)) {
    line[strcspn(line, "\r\n")] = 0;
    char *eq = strchr(line, '=');
    if (!eq) continue;
    *eq = 0;
    const char *key = line, *value = eq + 1;
    struct { const char *key; char *dst; size_t size; const char **ptr; } slots[] = {
      {"ORCA_AGENT_HOOK_PORT", ep_port, sizeof ep_port, &port},
      {"ORCA_AGENT_HOOK_TOKEN", ep_token, sizeof ep_token, &token},
      {"ORCA_AGENT_HOOK_ENV", ep_env, sizeof ep_env, &hook_env},
      {"ORCA_AGENT_HOOK_VERSION", ep_version, sizeof ep_version, &version},
      {"ORCA_AGENT_HOOK_TRANSPORT", ep_transport, sizeof ep_transport, &transport},
    };
    for (size_t i = 0; i < sizeof slots / sizeof slots[0]; i++) {
      if (strcmp(key, slots[i].key) == 0 && strlen(value) < slots[i].size) {
        strcpy(slots[i].dst, value);
        *slots[i].ptr = slots[i].dst;
      }
    }
  }
  fclose(f);
}

// The agent: Claude Code, which runs this hook directly (exec form) or through `sh -c`.
static pid_t agent_pid(void) {
  pid_t pid = getppid();
  char name[2 * MAXCOMLEN + 1] = {0};
  if (proc_name(pid, name, sizeof name) > 0 &&
      (!strcmp(name, "sh") || !strcmp(name, "bash") || !strcmp(name, "zsh") || !strcmp(name, "dash"))) {
    struct proc_bsdinfo info;
    if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof info) == sizeof info) pid = (pid_t)info.pbi_ppid;
  }
  return pid;
}

// `{"pid":N,"platform":"darwin","startTime":"<TZ=UTC0 LC_ALL=C ps -o lstart=>"}`, or "".
static void agent_process(char *out, size_t size) {
  out[0] = 0;
  if (!*env("ORCA_PANE_KEY")) return;
  pid_t pid = agent_pid();
  struct kinfo_proc kp;
  size_t len = sizeof kp;
  int mib[4] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, pid};
  if (sysctl(mib, 4, &kp, &len, NULL, 0) != 0 || len == 0) return;
  time_t start = kp.kp_proc.p_starttime.tv_sec;
  struct tm tm;
  gmtime_r(&start, &tm);
  char when[64];
  strftime(when, sizeof when, "%a %b %e %H:%M:%S %Y", &tm);
  snprintf(out, size, "{\"pid\":%d,\"platform\":\"darwin\",\"startTime\":\"%s\"}", (int)pid, when);
}

static void base64(buf_t *out, const unsigned char *in, size_t n) {
  static const char t[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (size_t i = 0; i < n; i += 3) {
    unsigned v = in[i] << 16 | (i + 1 < n ? in[i + 1] << 8 : 0) | (i + 2 < n ? in[i + 2] : 0);
    char q[4] = {t[v >> 18 & 63], t[v >> 12 & 63], i + 1 < n ? t[v >> 6 & 63] : '=', i + 2 < n ? t[v & 63] : '='};
    buf_put(out, q, 4);
  }
}

static void urlencode(buf_t *out, const char *s, size_t n) {
  for (size_t i = 0; i < n; i++) {
    unsigned char c = (unsigned char)s[i];
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '.' || c == '_' || c == '~') {
      buf_put(out, (char *)&c, 1);
    } else if (c == ' ') {
      buf_put(out, "+", 1);  // as curl --data-urlencode
    } else {
      char hex[4];
      snprintf(hex, sizeof hex, "%%%02X", c);
      buf_put(out, hex, 3);
    }
  }
}

static int wait_fd(int fd, short events, long deadline_ms) {
  struct timeval now;
  gettimeofday(&now, NULL);
  long left = deadline_ms - (now.tv_sec * 1000L + now.tv_usec / 1000);
  if (left <= 0) return 0;
  struct pollfd p = {fd, events, 0};
  return poll(&p, 1, (int)left) > 0;
}

static long now_ms(void) {
  struct timeval now;
  gettimeofday(&now, NULL);
  return now.tv_sec * 1000L + now.tv_usec / 1000;
}

// One POST to 127.0.0.1; 0 when the server answered (any status, as curl -sS without -f).
static int post(const char *path_part, const buf_t *headers, const buf_t *body) {
  long start = now_ms();
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) return -1;
  fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK);
  struct sockaddr_in sa = {.sin_family = AF_INET, .sin_port = htons((unsigned short)atoi(port))};
  sa.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  if (connect(fd, (struct sockaddr *)&sa, sizeof sa) != 0) {
    if (errno != EINPROGRESS || !wait_fd(fd, POLLOUT, start + 500)) { close(fd); return -1; }
    int err = 0; socklen_t el = sizeof err;
    if (getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &el) != 0 || err) { close(fd); return -1; }
  }
  buf_t req = {0};
  char line[256];
  snprintf(line, sizeof line, "POST %s HTTP/1.1\r\nHost: 127.0.0.1:%s\r\nUser-Agent: pod-agent-hook/1\r\nAccept: */*\r\n", path_part, port);
  buf_str(&req, line);
  buf_put(&req, headers->data, headers->len);
  snprintf(line, sizeof line, "Content-Length: %zu\r\nConnection: close\r\n\r\n", body->len);
  buf_str(&req, line);
  buf_put(&req, body->data, body->len);
  size_t sent = 0;
  long deadline = start + 1500;
  while (sent < req.len) {
    ssize_t n = write(fd, req.data + sent, req.len - sent);
    if (n > 0) { sent += (size_t)n; continue; }
    if (n < 0 && errno == EAGAIN && wait_fd(fd, POLLOUT, deadline)) continue;
    close(fd); free(req.data); return -1;
  }
  free(req.data);
  char reply[512];
  int answered = -1;
  while (wait_fd(fd, POLLIN, deadline)) {
    ssize_t n = read(fd, reply, sizeof reply);
    if (n > 0) { answered = 0; if (memmem(reply, (size_t)n, "\r\n\r\n", 4)) break; continue; }
    break;
  }
  close(fd);
  return answered;
}

static void json_escape(buf_t *out, const char *s) {
  for (; *s; s++) {
    unsigned char c = (unsigned char)*s;
    if (c == '\\') buf_str(out, "\\\\");
    else if (c == '"') buf_str(out, "\\\"");
    else if (c < 0x20 || c == 0x7f) buf_str(out, " ");
    else buf_put(out, (char *)&c, 1);
  }
}

// The spool the runtime replays at its next start (claude-hook.sh spool_hook_event).
static void spool(const buf_t *payload, const char *process) {
  if (strstr(payload->data, "\"PreToolUse\"") || strstr(payload->data, "\"PostToolUse\"") ||
      strstr(payload->data, "\"PostToolUseFailure\""))
    return;
  const char *endpoint = env("ORCA_AGENT_HOOK_ENDPOINT"), *pane = env("ORCA_PANE_KEY");
  if (!*endpoint || !*pane || access(endpoint, R_OK) != 0) return;
  char dir[4096];
  const char *slash = strrchr(endpoint, '/');
  size_t base = slash ? (size_t)(slash - endpoint) : 0;
  if (base + 7 >= sizeof dir) return;
  memcpy(dir, endpoint, base);
  strcpy(dir + base, "/spool");
  if (mkdir(dir, 0777) != 0 && errno != EEXIST) return;
  chmod(dir, 0700);
  size_t plen = strlen(pane);
  const char *tail = plen > 36 ? pane + plen - 36 : pane;
  char id[40];
  size_t i = 0;
  for (; tail[i] && i < 36; i++) id[i] = (tail[i] == '/' || tail[i] == ':') ? '_' : tail[i];
  id[i] = 0;
  char file[4200];
  snprintf(file, sizeof file, "%s/pane-%s.jsonl", dir, id);
  struct stat st;
  if (stat(file, &st) == 0 && S_ISREG(st.st_mode) && (time(NULL) - st.st_mtime) / 86400 > 7) {
    int fd = open(file, O_WRONLY | O_TRUNC);
    if (fd >= 0) close(fd);
    st.st_size = 0;
  } else if (stat(file, &st) != 0) {
    st.st_size = 0;
  }
  if (st.st_size >= SPOOL_CAP) return;
  buf_t line = {0};
  char num[32];
  buf_str(&line, "\n{\"paneKey\":\""); json_escape(&line, pane);
  buf_str(&line, "\",\"tabId\":\""); json_escape(&line, env("ORCA_TAB_ID"));
  buf_str(&line, "\",\"worktreeId\":\""); json_escape(&line, env("ORCA_WORKTREE_ID"));
  buf_str(&line, "\",\"env\":\""); json_escape(&line, env("ORCA_AGENT_HOOK_ENV"));
  buf_str(&line, "\",\"version\":\""); json_escape(&line, env("ORCA_AGENT_HOOK_VERSION"));
  buf_str(&line, "\",\"launchToken\":\""); json_escape(&line, env("ORCA_AGENT_LAUNCH_TOKEN"));
  buf_str(&line, "\",\"source\":\"claude\",\"receivedAt\":");
  snprintf(num, sizeof num, "%ld", (long)time(NULL) * 1000L);
  buf_str(&line, num);
  buf_str(&line, ",\"agentProcess\":\""); json_escape(&line, process);
  buf_str(&line, "\",\"payload\":");
  buf_put(&line, payload->data, payload->len);
  buf_str(&line, "}\n");
  int fd = open(file, O_WRONLY | O_CREAT | O_APPEND, 0644);
  if (fd >= 0) {
    ssize_t ignored = write(fd, line.data, line.len);
    (void)ignored;
    close(fd);
    chmod(file, 0600);
  }
  free(line.data);
}

// src/shared/claude-statusline-rate-limits.ts
#define STATUSLINE_PATH "/statusline/claude"
#define STATUSLINE_MIN_POST_INTERVAL_SECONDS 15

// The shell's canonical decimal (0, or no leading zero) of at most 15 digits, as the script's
// `case 0|[1-9]|[1-9][0-9]*` and length checks take it; -1 otherwise.
static long long canonical_decimal(const char *s, size_t n) {
  if (n == 0 || n > 15 || (s[0] == '0' && n > 1)) return -1;
  long long v = 0;
  for (size_t i = 0; i < n; i++) {
    if (s[i] < '0' || s[i] > '9') return -1;
    v = v * 10 + (s[i] - '0');
  }
  return v;
}

// The payload clock: the digits after the first "total_duration_ms" and its colon, in seconds.
static long long payload_seconds(const buf_t *payload) {
  const char *key = memmem(payload->data, payload->len, "\"total_duration_ms\"", 19);
  if (!key) return -1;
  const char *p = key + 19, *end = payload->data + payload->len;
  const char *colon = memchr(p, ':', (size_t)(end - p));
  if (colon) p = colon + 1;  // `${x#*:}` leaves x as it is without a colon
  while (p < end && (*p == ' ' || (*p >= '\t' && *p <= '\r'))) p++;
  const char *digits = p;
  while (p < end && *p >= '0' && *p <= '9') p++;
  long long ms = canonical_decimal(digits, (size_t)(p - digits));
  return ms < 0 ? -1 : ms / 1000;
}

static int statusline_main(void) {
  buf_t payload = {0};
  char chunk[65536];
  ssize_t n;
  while ((n = read(0, chunk, sizeof chunk)) > 0) {
    if (payload.len + (size_t)n > MAX_PAYLOAD) break;
    buf_put(&payload, chunk, (size_t)n);
  }
  // The script's read loop: every line, and one trailing newline gone.
  if (payload.len && payload.data[payload.len - 1] == '\n') payload.data[--payload.len] = 0;
  if (!payload.len || *env("CLAUDE_JOB_DIR")) return 0;
  if (!memmem(payload.data, payload.len, "\"rate_limits\"", 13)) return 0;
  read_endpoint_file();
  const char *pane = env("ORCA_PANE_KEY");
  if (!*port || !*token || !*pane) return 0;

  // The stable leaf UUID; a numeric (pre-migration, tab-local) leaf id gets its safe tab id first.
  char pane_id[1024];
  const char *colon = strrchr(pane, ':');
  const char *leaf = colon ? colon + 1 : pane;
  size_t tab_len = colon ? (size_t)(colon - pane) : strlen(pane);
  int numeric = *leaf != 0, safe_tab = tab_len != 0;
  for (const char *c = leaf; *c; c++) numeric &= *c >= '0' && *c <= '9';
  for (size_t i = 0; i < tab_len; i++) {
    char c = pane[i];
    safe_tab &= (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-';
  }
  if (numeric && safe_tab) {
    snprintf(pane_id, sizeof pane_id, "%.*s_%s", (int)tab_len, pane, leaf);
  } else {
    snprintf(pane_id, sizeof pane_id, "%s", leaf);
  }
  const char *tmp = *env("TMPDIR") ? env("TMPDIR") : "/tmp";
  char stamp[4096];
  snprintf(stamp, sizeof stamp, "%s/orca-claude-statusline-last-%s", tmp, pane_id);

  long long now = payload_seconds(&payload);
  if (now < 0) now = (long long)time(NULL);
  struct stat st;
  if (stat(stamp, &st) == 0 && S_ISREG(st.st_mode)) {
    char last[64] = {0};
    int fd = open(stamp, O_RDONLY);
    if (fd >= 0) {
      ssize_t got = read(fd, last, sizeof last - 1);
      close(fd);
      last[got > 0 ? got : 0] = 0;
      last[strcspn(last, "\n")] = 0;
      long long then = canonical_decimal(last, strlen(last));
      if (then >= 0 && now - then >= 0 && now - then < STATUSLINE_MIN_POST_INTERVAL_SECONDS) return 0;
    }
  }
  int fd = open(stamp, O_WRONLY | O_CREAT | O_TRUNC, 0666);
  if (fd >= 0) {
    char text[32];
    int len = snprintf(text, sizeof text, "%lld", now);
    ssize_t ignored = write(fd, text, (size_t)len);
    (void)ignored;
    close(fd);
  }

  buf_t headers = {0}, body = {0};
  buf_str(&headers, "Content-Type: application/x-www-form-urlencoded\r\nX-Orca-Agent-Hook-Token: ");
  buf_str(&headers, token);
  buf_str(&headers, "\r\n");
  struct { const char *key; const char *value; size_t len; } form[] = {
    {"paneKey", pane, strlen(pane)}, {"configDir", env("CLAUDE_CONFIG_DIR"), strlen(env("CLAUDE_CONFIG_DIR"))},
    {"env", hook_env, strlen(hook_env)}, {"version", version, strlen(version)}, {"payload", payload.data, payload.len},
  };
  for (size_t i = 0; i < sizeof form / sizeof form[0]; i++) {
    if (i) buf_str(&body, "&");
    buf_str(&body, form[i].key); buf_str(&body, "=");
    urlencode(&body, form[i].value, form[i].len);
  }
  post(STATUSLINE_PATH, &headers, &body);
  return 0;
}

int main(int argc, char **argv) {
  if (argc > 1 && !strcmp(argv[1], "statusline")) return statusline_main();
  // Why: Claude-compatible permission hooks fail closed on empty stdout (#14818).
  ssize_t ignored = write(1, "{}\n", 3);
  (void)ignored;
  buf_t payload = {0};
  char chunk[65536];
  ssize_t n;
  while ((n = read(0, chunk, sizeof chunk)) > 0) {
    if (payload.len + (size_t)n > MAX_PAYLOAD) break;
    buf_put(&payload, chunk, (size_t)n);
  }
  while (payload.len && payload.data[payload.len - 1] == '\n') payload.data[--payload.len] = 0;
  if (!payload.len) return 0;
  if (*env("GROK_HOOK_EVENT") || *env("DEVIN_PROJECT_DIR") || *env("CLAUDE_JOB_DIR")) return 0;
  // A claude that got Pod's hooks with its launch (pod-agent-launcher sets POD_CLAUDE_SETTINGS_PID)
  // reports through those, which call this with --launch; settings.json's older entry stays silent.
  if (*env("POD_CLAUDE_SETTINGS_PID") && !(argc > 1 && !strcmp(argv[1], "--launch"))) return 0;
  char process[256];
  agent_process(process, sizeof process);
  read_endpoint_file();
  const char *pane = env("ORCA_PANE_KEY");
  if (!*port || !*token || !*pane) { spool(&payload, process); return 0; }
  buf_t headers = {0}, body = {0};
  if (!strcmp(transport, "raw-json-v1")) {
    buf_t meta = {0};
    const char *fields[] = {pane, env("ORCA_TAB_ID"), env("ORCA_AGENT_LAUNCH_TOKEN"), env("ORCA_WORKTREE_ID"), hook_env, version};
    for (int i = 0; i < 6; i++) { if (i) buf_put(&meta, "\037", 1); buf_str(&meta, fields[i]); }
    buf_str(&headers, "Content-Type: application/json\r\nX-Orca-Agent-Hook-Token: ");
    buf_str(&headers, token);
    buf_str(&headers, "\r\nX-Orca-Agent-Hook-Meta-Encoding: base64\r\nX-Orca-Agent-Hook-Meta: ");
    base64(&headers, (unsigned char *)meta.data, meta.len);
    buf_str(&headers, "\r\nX-Orca-Agent-Process: ");
    buf_str(&headers, process);
    buf_str(&headers, "\r\n");
    buf_put(&body, payload.data, payload.len);
  } else {
    buf_str(&headers, "Content-Type: application/x-www-form-urlencoded\r\nX-Orca-Agent-Hook-Token: ");
    buf_str(&headers, token);
    buf_str(&headers, "\r\n");
    struct { const char *key; const char *value; } form[] = {
      {"paneKey", pane}, {"tabId", env("ORCA_TAB_ID")}, {"launchToken", env("ORCA_AGENT_LAUNCH_TOKEN")},
      {"worktreeId", env("ORCA_WORKTREE_ID")}, {"env", hook_env}, {"version", version}, {"agentProcess", process},
    };
    for (size_t i = 0; i < sizeof form / sizeof form[0]; i++) {
      if (i) buf_str(&body, "&");
      buf_str(&body, form[i].key); buf_str(&body, "=");
      urlencode(&body, form[i].value, strlen(form[i].value));
    }
    buf_str(&body, "&payload=");
    urlencode(&body, payload.data, payload.len);
  }
  if (post("/hook/claude", &headers, &body) != 0) spool(&payload, process);
  return 0;
}
