// `zsh` client for CLAUDE_CODE_SHELL. Claude Code spawns it exactly like the
// real shell: argv = [path, "-c", S]. When S is the Bash tool's command
// template and a warm pod-shelld is reachable, the command runs in a pre-started
// /bin/zsh that already sourced the snapshot; otherwise this execs /bin/zsh
// unchanged. libSystem only.
#include <errno.h>
#include <fcntl.h>
#include <libproc.h>
#include <pthread/qos.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/param.h>
#include <sys/proc_info.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/uio.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

#include "proto.h"

extern char **environ;
extern int sandbox_check(pid_t pid, const char *operation, int type, ...);

static const char *real_shell(void) {
  const char *s = getenv("POD_NATIVE_BASH_REAL_SHELL");
  return s && *s == '/' ? s : "/bin/zsh";
}

static void passthrough(int argc, char **argv) {
  (void)argc;
  const char *real = real_shell();
  argv[0] = (char *)real;
  execv(real, argv);
  fprintf(stderr, "zsh: cannot exec %s: %s\n", real, strerror(errno));
  _exit(127);
}

// ---------------------------------------------------------------- template parser

#define SNAP_TAIL " 2>/dev/null || true"
#define PRE_TAIL                                                                                       \
  " && setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL 2>/dev/null || true && "                              \
  "{ \\builtin unalias -- 'unsetenv'; \\builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true"
// Optional prelude parts Claude Code inserts between the snapshot and setopt. They only
// derive env from env, so running them when the warm shell boots is equivalent.
#define PART_TMPDIR " && { [ -n \"${TMPDIR:-}\" ] || export TMPDIR="
#define PART_PATH " && export PATH=\"${PATH:+$PATH:}\""
#define PART_BUN " && export BUN_OPTIONS=\"--smol${BUN_OPTIONS:+ $BUN_OPTIONS}\""

struct buf {
  char *p;
  size_t n, cap;
};

static int bput(struct buf *b, const char *s, size_t n) {
  if (b->n + n + 1 > b->cap) {
    size_t cap = (b->cap ? b->cap * 2 : 256) + n;
    char *p = realloc(b->p, cap);
    if (!p) return -1;
    b->p = p;
    b->cap = cap;
  }
  memcpy(b->p + b->n, s, n);
  b->n += n;
  b->p[b->n] = 0;
  return 0;
}

static int bare_char(unsigned char c) {
  return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || strchr("_-./=:@%+,", c);
}

// Parses one word in Claude Code's quoting: a bare safe word, or '...' segments
// joined by '"'"' for literal single quotes. Returns the end pointer or NULL.
static const char *word(const char *s, struct buf *out) {
  out->n = 0;
  if (*s == '\'') {
    for (;;) {
      const char *q = strchr(s + 1, '\'');
      if (!q) return NULL;
      if (bput(out, s + 1, q - s - 1)) return NULL;
      s = q + 1;
      if (strncmp(s, "\"'\"'", 4) == 0) {
        if (bput(out, "'", 1)) return NULL;
        s += 3;  // now at the opening quote of the next segment
        continue;
      }
      return s;
    }
  }
  const char *b = s;
  while (*s && bare_char((unsigned char)*s)) s++;
  if (s == b || bput(out, b, s - b)) return NULL;
  return s;
}

struct req {
  struct buf spre, cmd, cwdfile;
  uint32_t flavor;
};

static int parse(const char *s, struct req *r) {
  struct buf snap = {0};
  if (strncmp(s, "source ", 7)) return -1;
  const char *p = word(s + 7, &snap);
  if (!p || strncmp(p, SNAP_TAIL, strlen(SNAP_TAIL))) goto bad;
  p += strlen(SNAP_TAIL);
  for (;;) {
    if (!strncmp(p, PART_TMPDIR, strlen(PART_TMPDIR))) {
      p = word(p + strlen(PART_TMPDIR), &snap);
      if (!p || strncmp(p, "; }", 3)) goto bad;
      p += 3;
    } else if (!strncmp(p, PART_PATH, strlen(PART_PATH))) {
      p = word(p + strlen(PART_PATH), &snap);
      if (!p) goto bad;
    } else if (!strncmp(p, PART_BUN, strlen(PART_BUN))) {
      p += strlen(PART_BUN);
    } else {
      break;
    }
  }
  free(snap.p);
  if (strncmp(p, PRE_TAIL, strlen(PRE_TAIL))) return -1;
  p += strlen(PRE_TAIL);
  if (bput(&r->spre, s, p - s)) return -1;
  if (strncmp(p, " && eval ", 9)) return -1;
  p = word(p + 9, &r->cmd);
  if (!p) return -1;
  if (strncmp(p, " < /dev/null && pwd -P >| ", 26) == 0) {
    r->flavor = PNB_FLAVOR_DEVNULL;
    p += 26;
  } else if (strncmp(p, " && pwd -P >| ", 14) == 0) {
    r->flavor = PNB_FLAVOR_RAW;
    p += 14;
  } else {
    return -1;
  }
  p = word(p, &r->cwdfile);
  if (!p || *p) return -1;
  // NUL bytes cannot appear (argv); the daemon appends a sentinel to keep trailing newlines.
  return 0;
bad:
  free(snap.p);
  return -1;
}

// ---------------------------------------------------------------- daemon socket

static int sock_path(char *out, size_t n, const char *key) {
  const char *t = getenv("TMPDIR");
  if (!t || *t != '/') t = "/tmp/";
  size_t tl = strlen(t);
  int r = snprintf(out, n, "%s%spod-shelld-%u/%s.sock", t, t[tl - 1] == '/' ? "" : "/", getuid(), key);
  return r > 0 && (size_t)r < n && (size_t)r < sizeof(((struct sockaddr_un *)0)->sun_path) ? 0 : -1;
}

static void spawn_daemon(const char *self, const char *key, const char *path) {
  char d[PATH_MAX];
  snprintf(d, sizeof d, "%s", self);
  char *slash = strrchr(d, '/');
  if (!slash) return;
  snprintf(slash + 1, sizeof d - (slash + 1 - d), "pod-shelld");
  if (access(d, X_OK)) return;
  sigset_t all, old;
  sigfillset(&all);
  sigprocmask(SIG_BLOCK, &all, &old);
  pid_t c = fork();
  if (c == 0) {
    // Double fork: the daemon must not be our descendant (Claude Code tree-kills those)
    // nor share our process group or session.
    if (fork() == 0) {
      setsid();
      int nul = open("/dev/null", O_RDWR);
      dup2(nul, 0);
      dup2(nul, 1);
      dup2(nul, 2);
      for (int fd = 3; fd < 256; fd++) close(fd);
      for (int s = 1; s < NSIG; s++) signal(s, SIG_DFL);
      sigset_t none;
      sigemptyset(&none);
      sigprocmask(SIG_SETMASK, &none, NULL);
      char *av[] = {d, (char *)key, (char *)path, NULL};
      execv(d, av);
      _exit(127);
    }
    _exit(0);
  }
  if (c > 0) waitpid(c, NULL, 0);
  sigprocmask(SIG_SETMASK, &old, NULL);
}

// ---------------------------------------------------------------- signals

static volatile sig_atomic_t g_sock = -1, g_pending;
static const int relayed[] = {SIGTERM, SIGINT, SIGHUP, SIGQUIT, SIGUSR1, SIGUSR2};
static struct sigaction g_old[NSIG];

static void on_sig(int s) {
  int e = errno;
  g_pending = s;
  if (g_sock >= 0) {
    unsigned char m[2] = {'S', (unsigned char)s};
    (void)write(g_sock, m, 2);
  }
  errno = e;
}

static void install(void) {
  struct sigaction sa = {0};
  sa.sa_handler = on_sig;
  sigemptyset(&sa.sa_mask);
  for (size_t i = 0; i < sizeof relayed / sizeof *relayed; i++) sigaction(relayed[i], &sa, &g_old[relayed[i]]);
}

static void restore(void) {
  for (size_t i = 0; i < sizeof relayed / sizeof *relayed; i++) sigaction(relayed[i], &g_old[relayed[i]], NULL);
}

static void die_like(int st) {
  if (WIFSIGNALED(st)) {
    int s = WTERMSIG(st);
    signal(s, SIG_DFL);
    sigset_t m;
    sigemptyset(&m);
    sigaddset(&m, s);
    sigprocmask(SIG_UNBLOCK, &m, NULL);
    kill(getpid(), s);
    _exit(128 + s);
  }
  _exit(WIFEXITED(st) ? WEXITSTATUS(st) : 1);
}

// ---------------------------------------------------------------- warm path

static int only_std_fds(void) {
  struct proc_fdinfo fds[64];
  int n = proc_pidinfo(getpid(), PROC_PIDLISTFDS, 0, fds, sizeof fds);
  if (n <= 0) return 0;
  for (int i = 0; i < n / (int)PROC_PIDLISTFD_SIZE; i++)
    if (fds[i].proc_fd > 2) return 0;
  return 1;
}

static int put_blob(struct buf *m, const void *p, uint32_t n) {
  return bput(m, (const char *)&n, sizeof n) || bput(m, p, n);
}

static void try_warm(const char *self, const char *s) {
  const char *off = getenv("POD_NATIVE_BASH");
  if (off && !strcmp(off, "0")) return;
  const char *key = getenv("POD_SHELLD_ID");
  if (!key || !*key) key = getenv("CLAUDE_PID");
  if (!key || !*key || strlen(key) > 32 || strchr(key, '/')) return;
  // Claude Code's sandbox wraps the shell: the warm shells live outside it, so never route.
  if (sandbox_check(getpid(), NULL, 0)) return;

  struct req r = {0};
  if (parse(s, &r)) return;

  struct stat o1, o2, cw;
  if (fstat(1, &o1) || fstat(2, &o2) || !S_ISREG(o1.st_mode) || o1.st_dev != o2.st_dev || o1.st_ino != o2.st_ino) return;
  int fl = fcntl(1, F_GETFL);
  if (fl != fcntl(2, F_GETFL) || lseek(1, 0, SEEK_CUR) != lseek(2, 0, SEEK_CUR)) return;
  if (!only_std_fds()) return;
  char outpath[MAXPATHLEN], cwd[MAXPATHLEN];
  if (fcntl(1, F_GETPATH, outpath) || !getcwd(cwd, sizeof cwd) || stat(".", &cw)) return;

  char spath[sizeof(((struct sockaddr_un *)0)->sun_path)];
  if (sock_path(spath, sizeof spath, key)) return;
  int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) return;
  int one = 1;
  setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof one);
  struct sockaddr_un a = {.sun_family = AF_UNIX};
  memcpy(a.sun_path, spath, strlen(spath) + 1);
  if (connect(fd, (struct sockaddr *)&a, sizeof a)) {
    close(fd);
    if (errno == ENOENT || errno == ECONNREFUSED) spawn_daemon(self, key, spath);
    return;
  }

  struct pnb_fixed fx = {0};
  fx.flavor = r.flavor;
  mode_t um = umask(0);
  umask(um);
  fx.umask = um;
  fx.qos = (int32_t)qos_class_self();
  errno = 0;
  fx.nice = getpriority(PRIO_PROCESS, 0);
  sigset_t cur;
  sigprocmask(SIG_BLOCK, NULL, &cur);
  fx.sigmask = (uint32_t)cur;
  for (int sg = 1; sg < 32; sg++) {
    struct sigaction sa;
    if (sigaction(sg, NULL, &sa) == 0 && sa.sa_handler == SIG_IGN) fx.sigign |= 1u << sg;
  }
  fx.cwd_dev = cw.st_dev;
  fx.cwd_ino = cw.st_ino;
  fx.out_dev = o1.st_dev;
  fx.out_ino = o1.st_ino;
  fx.out_flags = fl;

  struct buf m = {0};
  uint32_t hdr[2] = {PNB_MAGIC, 0};
  struct buf env = {0};
  for (char **e = environ; *e; e++)
    if (bput(&env, *e, strlen(*e) + 1)) return;
  if (bput(&m, (const char *)hdr, sizeof hdr) || bput(&m, (const char *)&fx, sizeof fx) ||
      put_blob(&m, r.spre.p, r.spre.n) || put_blob(&m, r.cmd.p, r.cmd.n) || put_blob(&m, r.cwdfile.p, r.cwdfile.n) ||
      put_blob(&m, outpath, strlen(outpath)) || put_blob(&m, cwd, strlen(cwd)) || put_blob(&m, env.p, env.n))
    return;
  ((uint32_t *)m.p)[1] = (uint32_t)(m.n - sizeof hdr);

  g_sock = fd;
  install();
  for (size_t done = 0; done < m.n;) {
    ssize_t w = write(fd, m.p + done, m.n - done);
    if (w < 0 && errno == EINTR) continue;
    if (w <= 0) goto fallback;
    done += w;
  }
  for (;;) {
    unsigned char c;
    ssize_t n = read(fd, &c, 1);
    if (n < 0 && errno == EINTR) continue;
    if (n != 1) {
      // The daemon crashed after taking the request. The command may already be running,
      // so never fall back here: a second run would repeat its side effects.
      static const char msg[] = "pod-native-bash: warm shell daemon lost the command\n";
      (void)write(2, msg, sizeof msg - 1);
      _exit(1);
    }
    if (c == 'M') goto fallback;
    if (c == 'X') {
      int32_t st;
      size_t got = 0;
      while (got < sizeof st) {
        ssize_t k = read(fd, (char *)&st + got, sizeof st - got);
        if (k < 0 && errno == EINTR) continue;
        if (k <= 0) _exit(1);
        got += k;
      }
      die_like(st);
    }
  }
fallback:
  g_sock = -1;
  close(fd);
  restore();
  if (g_pending) {
    // A kill signal arrived before the daemon took the command: honor it like the shell would.
    signal(g_pending, SIG_DFL);
    raise(g_pending);
  }
}

int main(int argc, char **argv) {
  if (argc == 3 && !strcmp(argv[1], "-c")) try_warm(argv[0], argv[2]);
  passthrough(argc, argv);
  return 127;
}
