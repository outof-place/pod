// Fork-only (Pod): the lazy MCP shim Pod copies beside its managed hooks and wraps chosen stdio
// MCP servers of ~/.claude.json in (src/main/pod/mcp-lazy). Built in afterPack
// (product/mcp-lazy/install-mcp-lazy.cjs) into Contents/Resources/bin, signed with no entitlements:
// dyld strips DYLD_* from its environment, so servers started through it don't get them.
/*
 * mcp-lazy: start a stdio MCP server only when a session first uses it.
 *
 *     mcp-lazy <name> <command> [args...]
 *     mcp-lazy <name> -- <command> [args...]
 *
 * Claude Code starts every stdio MCP server with every session, and most sessions never call
 * most servers. This sits in the server's place. The handshake (`server/discover`, which Claude
 * Code 2.1.296 probes first, and `initialize`) and the list requests (tools, prompts, resources,
 * resource templates) are answered from a manifest of what the real server answered before,
 * byte for byte except the request id; so are ping and logging/setLevel once recorded (before
 * that they get `{}` here). The real server starts at the first other request. It
 * gets the session's own initialize and queued notifications, and from then on every frame
 * passes both ways unchanged: the server's notifications and requests (sampling, elicitation,
 * roots), cancellations, and request ids as the session and the server chose them.
 *
 * The manifest is one file per server identity: the name, the command resolved on PATH, the
 * args, and for the binary and every absolute file argument its real path, size, mtime, inode
 * and nearest package.json (sha256). An upgrade changes the identity: that session runs the
 * server from the start, as without this, and records a new manifest. The server's version is
 * part of the recorded initialize answer. A server started later is checked against it, and
 * against the recorded tools/list. A difference drops the manifest, and the session gets
 * notifications/tools/list_changed. The session's own list requests refresh it.
 *
 * A server that can't start (no binary, an exit, no initialize answer within
 * MCP_LAZY_START_TIMEOUT seconds, 60 by default) answers the requests that waited for it with a
 * JSON-RPC error, never a hang. The next request tries again. When the session closes stdin,
 * the server's stdin is closed. Its process group gets SIGTERM 3 s later (SIGKILL 2 s after
 * that) or as soon as the server exits. SIGTERM or SIGINT to this process does the same at once.
 *
 * Files: MCP_LAZY_CACHE (default ~/Library/Caches/mcp-lazy, 0700, manifests 0600) and
 * MCP_LAZY_LOG (default ~/Library/Logs/mcp-lazy.log, one or two lines per session, rotated at
 * 1 MB). MCP_LAZY_DEBUG=1 also logs the start of every session frame.
 *
 * One file, libSystem only (kqueue, posix_spawn, CommonCrypto).
 */
#include <CommonCrypto/CommonDigest.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <signal.h>
#include <spawn.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/event.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

extern char **environ;

/* ---------- buffers ---------- */

typedef struct {
    char *p;
    size_t len, cap;
} buf;

static void die_oom(void) {
    static const char m[] = "mcp-lazy: out of memory\n";
    write(2, m, sizeof m - 1);
    _exit(70);
}

static void buf_reserve(buf *b, size_t extra) {
    if (b->len + extra + 1 <= b->cap) return;
    size_t cap = b->cap ? b->cap : 256;
    while (cap < b->len + extra + 1) cap *= 2;
    char *p = realloc(b->p, cap);
    if (!p) die_oom();
    b->p = p;
    b->cap = cap;
}

static void buf_add(buf *b, const char *s, size_t n) {
    buf_reserve(b, n);
    memcpy(b->p + b->len, s, n);
    b->len += n;
    b->p[b->len] = 0;
}

static void buf_str(buf *b, const char *s) { buf_add(b, s, strlen(s)); }

static void buf_fmt(buf *b, const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    char tmp[512];
    int n = vsnprintf(tmp, sizeof tmp, fmt, ap);
    va_end(ap);
    if (n > 0) buf_add(b, tmp, (size_t)n < sizeof tmp ? (size_t)n : sizeof tmp - 1);
}

static void buf_consume(buf *b, size_t n) {
    memmove(b->p, b->p + n, b->len - n);
    b->len -= n;
    if (b->p) b->p[b->len] = 0;
}

static char *dup_n(const char *s, size_t n) {
    char *p = malloc(n + 1);
    if (!p) die_oom();
    memcpy(p, s, n);
    p[n] = 0;
    return p;
}

/* ---------- JSON text: spans of top-level members, so ids are spliced, never re-encoded ---------- */

typedef struct {
    size_t s, e; /* [s, e) in the text; s == e when absent */
} span;

static size_t ws(const char *s, size_t n, size_t i) {
    while (i < n && (s[i] == ' ' || s[i] == '\t' || s[i] == '\r' || s[i] == '\n')) i++;
    return i;
}

static size_t string_end(const char *s, size_t n, size_t i) { /* s[i] == '"' */
    for (i++; i < n; i++) {
        if (s[i] == '\\') i++;
        else if (s[i] == '"') return i + 1;
    }
    return n;
}

static size_t value_end(const char *s, size_t n, size_t i) {
    if (i >= n) return n;
    if (s[i] == '"') return string_end(s, n, i);
    if (s[i] == '{' || s[i] == '[') {
        int depth = 0;
        while (i < n) {
            char c = s[i];
            if (c == '"') {
                i = string_end(s, n, i);
                continue;
            }
            if (c == '{' || c == '[') depth++;
            else if (c == '}' || c == ']') {
                if (--depth == 0) return i + 1;
            }
            i++;
        }
        return n;
    }
    while (i < n && s[i] != ',' && s[i] != '}' && s[i] != ']' && s[i] != ' ' && s[i] != '\t' && s[i] != '\r' &&
           s[i] != '\n')
        i++;
    return i;
}

/* Walks the members of the object at s[*i] ('{' already passed when *i > 0 and inside): returns 1
 * with the raw key (with quotes) and value spans, 0 at the end. */
static int next_member(const char *s, size_t n, size_t *i, span *key, span *val) {
    size_t j = ws(s, n, *i);
    if (j < n && s[j] == ',') j = ws(s, n, j + 1);
    if (j >= n || s[j] != '"') return 0;
    key->s = j;
    key->e = string_end(s, n, j);
    j = ws(s, n, key->e);
    if (j >= n || s[j] != ':') return 0;
    j = ws(s, n, j + 1);
    val->s = j;
    val->e = value_end(s, n, j);
    *i = val->e;
    return 1;
}

static int key_is(const char *s, span k, const char *name) {
    size_t l = strlen(name);
    return k.e - k.s == l + 2 && memcmp(s + k.s + 1, name, l) == 0;
}

static int key_ends_with(const char *s, span k, const char *suffix) {
    size_t l = strlen(suffix);
    return k.e - k.s >= l + 2 && memcmp(s + k.e - 1 - l, suffix, l) == 0;
}

/* The value span of member `name` of the object text s, or an empty span. */
static span member(const char *s, size_t n, const char *name) {
    span none = {0, 0}, k, v;
    size_t i = ws(s, n, 0);
    if (i >= n || s[i] != '{') return none;
    i++;
    while (next_member(s, n, &i, &k, &v))
        if (key_is(s, k, name)) return v;
    return none;
}

static int is_object(const char *s, size_t n) {
    size_t i = ws(s, n, 0);
    return i < n && s[i] == '{';
}

static int span_eq(const char *s, span v, const char *lit) {
    size_t l = strlen(lit);
    return v.e > v.s && v.e - v.s == l && memcmp(s + v.s, lit, l) == 0;
}

/* `line` with its id replaced by the JSON text `id`. */
static void with_id(buf *out, const char *line, size_t n, const char *id, size_t idn) {
    span v = member(line, n, "id");
    out->len = 0;
    buf_reserve(out, n + idn);
    if (v.e <= v.s) {
        buf_add(out, line, n);
        return;
    }
    buf_add(out, line, v.s);
    buf_add(out, id, idn);
    buf_add(out, line + v.e, n - v.e);
}

/* JSON text without whitespace outside strings. */
static void compact(buf *o, const char *s, size_t i, size_t e) {
    while (i < e) {
        char c = s[i];
        if (c == '"') {
            size_t j = string_end(s, e, i);
            buf_add(o, s + i, j - i);
            i = j;
        } else {
            if (!(c == ' ' || c == '\t' || c == '\r' || c == '\n')) buf_add(o, &c, 1);
            i++;
        }
    }
}

/* A request's params as the manifest knows them: compact, without the client's name and version
 * (`clientInfo`, and `_meta` members ending in it), which change with every client release and
 * don't change an answer. Absent params read as {}. */
static void norm_params(buf *o, const char *s, span p) {
    if (p.e <= p.s) {
        buf_str(o, "{}");
        return;
    }
    if (s[p.s] != '{') {
        compact(o, s, p.s, p.e);
        return;
    }
    const char *obj = s + p.s;
    size_t n = p.e - p.s, i = 1;
    span k, v;
    int first = 1;
    buf_str(o, "{");
    while (next_member(obj, n, &i, &k, &v)) {
        if (key_is(obj, k, "clientInfo")) continue;
        buf val = {0};
        if (key_is(obj, k, "_meta") && obj[v.s] == '{') {
            size_t j = 1;
            span mk, mv;
            int mfirst = 1;
            const char *m = obj + v.s;
            size_t mn = v.e - v.s;
            buf_str(&val, "{");
            while (next_member(m, mn, &j, &mk, &mv)) {
                if (key_ends_with(m, mk, "clientInfo")) continue;
                if (!mfirst) buf_str(&val, ",");
                mfirst = 0;
                buf_add(&val, m + mk.s, mk.e - mk.s);
                buf_str(&val, ":");
                compact(&val, m, mv.s, mv.e);
            }
            buf_str(&val, "}");
            if (mfirst) {
                free(val.p);
                continue;
            }
        } else {
            compact(&val, obj, v.s, v.e);
        }
        if (!first) buf_str(o, ",");
        first = 0;
        buf_add(o, obj + k.s, k.e - k.s);
        buf_str(o, ":");
        buf_add(o, val.p, val.len);
        free(val.p);
    }
    buf_str(o, "}");
}

/* ---------- logging ---------- */

static const char *g_name = "?";
static char g_log[PATH_MAX];

static void logf_(const char *fmt, ...) {
    if (!g_log[0]) return;
    struct stat st;
    if (stat(g_log, &st) == 0 && st.st_size > (1 << 20)) {
        char old[PATH_MAX + 4];
        snprintf(old, sizeof old, "%s.1", g_log);
        rename(g_log, old);
    }
    int fd = open(g_log, O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC, 0644);
    if (fd < 0) return;
    char line[1024], when[32];
    time_t now = time(NULL);
    struct tm tm;
    localtime_r(&now, &tm);
    strftime(when, sizeof when, "%Y-%m-%d %H:%M:%S", &tm);
    int n = snprintf(line, sizeof line, "%s [%s %d] ", when, g_name, (int)getpid());
    va_list ap;
    va_start(ap, fmt);
    n += vsnprintf(line + n, sizeof line - (size_t)n - 1, fmt, ap);
    va_end(ap);
    if (n > (int)sizeof line - 2) n = (int)sizeof line - 2;
    line[n++] = '\n';
    write(fd, line, (size_t)n);
    close(fd);
}

/* ---------- identity and manifest ---------- */

static void sha256_hex(const void *data, size_t n, char out[65]) {
    unsigned char d[CC_SHA256_DIGEST_LENGTH];
    CC_SHA256(data, (CC_LONG)n, d);
    for (int i = 0; i < CC_SHA256_DIGEST_LENGTH; i++) snprintf(out + 2 * i, 3, "%02x", d[i]);
}

static int read_file(const char *path, buf *out) {
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    if (fd < 0) return -1;
    char tmp[65536];
    ssize_t r;
    while ((r = read(fd, tmp, sizeof tmp)) > 0) buf_add(out, tmp, (size_t)r);
    close(fd);
    return r < 0 ? -1 : 0;
}

/* `command` as execvp would find it on PATH. */
static int resolve(const char *command, char out[PATH_MAX]) {
    if (strchr(command, '/')) {
        snprintf(out, PATH_MAX, "%s", command);
        return access(out, X_OK) == 0 ? 0 : -1;
    }
    const char *path = getenv("PATH");
    if (!path) path = "/usr/bin:/bin";
    while (*path) {
        const char *end = strchr(path, ':');
        size_t l = end ? (size_t)(end - path) : strlen(path);
        snprintf(out, PATH_MAX, "%.*s/%s", (int)l, l ? path : ".", command);
        struct stat st;
        if (stat(out, &st) == 0 && S_ISREG(st.st_mode) && access(out, X_OK) == 0) return 0;
        path += l + (end ? 1 : 0);
    }
    return -1;
}

static void identify_file(buf *id, const char *path) {
    char real[PATH_MAX];
    struct stat st;
    if (!realpath(path, real) || stat(real, &st) != 0) {
        buf_fmt(id, "%s\tmissing\n", path);
        return;
    }
    buf_fmt(id, "%s\t%s\t%lld\t%ld.%09ld\t%llu", path, real, (long long)st.st_size, (long)st.st_mtimespec.tv_sec,
            (long)st.st_mtimespec.tv_nsec, (unsigned long long)st.st_ino);
    char dir[PATH_MAX];
    snprintf(dir, sizeof dir, "%s", real);
    for (int up = 0; up < 5; up++) {
        char *slash = strrchr(dir, '/');
        if (!slash || slash == dir) break;
        *slash = 0;
        char pkg[PATH_MAX + 16];
        snprintf(pkg, sizeof pkg, "%s/package.json", dir);
        buf content = {0};
        if (read_file(pkg, &content) == 0) {
            char hex[65];
            sha256_hex(content.p ? content.p : "", content.len, hex);
            buf_fmt(id, "\t%s", hex);
            free(content.p);
            break;
        }
        free(content.p);
    }
    buf_str(id, "\n");
}

static void server_key(char out[33], int argc, char **argv) { /* argv[0] = command */
    buf id = {0};
    buf_fmt(&id, "mcp-lazy 1\n%s\n", g_name);
    for (int i = 0; i < argc; i++) {
        buf_str(&id, argv[i]);
        buf_str(&id, "\n");
    }
    char exe[PATH_MAX];
    if (resolve(argv[0], exe) == 0) identify_file(&id, exe);
    else buf_fmt(&id, "%s\tunresolved\n", argv[0]);
    for (int i = 1; i < argc; i++) {
        struct stat st;
        if (argv[i][0] == '/' && stat(argv[i], &st) == 0 && S_ISREG(st.st_mode)) identify_file(&id, argv[i]);
    }
    char hex[65];
    sha256_hex(id.p, id.len, hex);
    memcpy(out, hex, 32);
    out[32] = 0;
    free(id.p);
}

typedef struct {
    char *key, *answer;
} entry;

static struct {
    char dir[PATH_MAX], path[PATH_MAX];
    entry *e;
    size_t n, cap;
} cache;

static const char *cache_lookup(const char *key) {
    for (size_t i = 0; i < cache.n; i++)
        if (strcmp(cache.e[i].key, key) == 0) return cache.e[i].answer;
    return NULL;
}

static void cache_load(void) {
    buf f = {0};
    if (read_file(cache.path, &f) != 0 || !f.p) {
        free(f.p);
        return;
    }
    char *line = f.p, *key = NULL;
    if (strncmp(line, "mcp-lazy-manifest 1\n", 20) != 0) {
        free(f.p);
        return;
    }
    while (line && *line) {
        char *nl = strchr(line, '\n');
        if (nl) *nl = 0;
        if (line[0] == 'K' && line[1] == '\t') key = line + 2;
        else if (line[0] == 'A' && line[1] == '\t' && key) {
            if (cache.n == cache.cap) {
                cache.cap = cache.cap ? cache.cap * 2 : 8;
                cache.e = realloc(cache.e, cache.cap * sizeof(entry));
                if (!cache.e) die_oom();
            }
            cache.e[cache.n].key = strdup(key);
            cache.e[cache.n].answer = strdup(line + 2);
            cache.n++;
            key = NULL;
        }
        line = nl ? nl + 1 : NULL;
    }
    free(f.p);
}

static void mkdirs(const char *dir) {
    char p[PATH_MAX];
    snprintf(p, sizeof p, "%s", dir);
    for (char *s = p + 1; *s; s++) {
        if (*s == '/') {
            *s = 0;
            mkdir(p, 0700);
            *s = '/';
        }
    }
    mkdir(p, 0700);
}

static void cache_save(void) {
    mkdirs(cache.dir);
    char tmp[PATH_MAX + 16];
    snprintf(tmp, sizeof tmp, "%s/.tmp-XXXXXX", cache.dir);
    int fd = mkstemp(tmp);
    if (fd < 0) return;
    buf out = {0};
    buf_str(&out, "mcp-lazy-manifest 1\n");
    for (size_t i = 0; i < cache.n; i++) {
        buf_str(&out, "K\t");
        buf_str(&out, cache.e[i].key);
        buf_str(&out, "\nA\t");
        buf_str(&out, cache.e[i].answer);
        buf_str(&out, "\n");
    }
    int ok = 1;
    for (size_t off = 0; off < out.len;) {
        ssize_t w = write(fd, out.p + off, out.len - off);
        if (w <= 0) {
            ok = 0;
            break;
        }
        off += (size_t)w;
    }
    fchmod(fd, 0600);
    close(fd);
    free(out.p);
    if (ok) rename(tmp, cache.path);
    else unlink(tmp);
}

static void cache_record(const char *key, const char *answer, size_t n) {
    for (size_t i = 0; i < cache.n; i++)
        if (strcmp(cache.e[i].key, key) == 0) {
            if (strlen(cache.e[i].answer) == n && memcmp(cache.e[i].answer, answer, n) == 0) return;
            free(cache.e[i].answer);
            cache.e[i].answer = dup_n(answer, n);
            cache_save();
            return;
        }
    if (cache.n == cache.cap) {
        cache.cap = cache.cap ? cache.cap * 2 : 8;
        cache.e = realloc(cache.e, cache.cap * sizeof(entry));
        if (!cache.e) die_oom();
    }
    cache.e[cache.n].key = strdup(key);
    cache.e[cache.n].answer = dup_n(answer, n);
    cache.n++;
    cache_save();
}

static void cache_drop(void) {
    for (size_t i = 0; i < cache.n; i++) {
        free(cache.e[i].key);
        free(cache.e[i].answer);
    }
    cache.n = 0;
    unlink(cache.path);
}

/* ---------- the proxy ---------- */

enum { IDLE, STARTING, RUNNING }; /* no server; waiting for its initialize answer; the session's */

/* Answered from the manifest; a miss starts the server. */
static const char *CACHED[] = {"server/discover", "initialize", "tools/list", "prompts/list", "resources/list",
                               "resources/templates/list", NULL};
/* Recorded too, but answered here when the manifest doesn't have them (`{}`, as the spec asks). */
static const char *LOCAL[] = {"ping", "logging/setLevel", NULL};

static struct {
    int argc;
    char **argv; /* the real server's command line */
    int kq;
    int state;
    pid_t pid;
    int in_fd, out_fd; /* the server's stdin (we write), stdout (we read); -1 when closed */
    int exited, out_eof, status;
    buf from_session, from_server; /* partial lines */
    buf to_session, to_server;      /* pending writes */
    int session_eof, stopping;
    char private_id[32];    /* "mcp-lazy-<hex>" */
    char *init_line;        /* the session's initialize, replayed to a server started later */
    char *init_key;
    char **replay;          /* session notifications (and requests answered here) for the start */
    size_t nreplay;
    char **pending;         /* session frames that arrived while the server was starting */
    size_t npending;
    struct {
        char *id, *key;
    } rec[64];              /* request id -> manifest key, for answers worth recording */
    size_t nrec;
    int tools_check;        /* a private tools/list is out */
    double start_timeout;
    struct timespec started_at;
    int debug;
    int read_paused_server, read_paused_session;
    int writing_session, writing_server; /* EVFILT_WRITE registered */
    int stdin_flags, stdout_flags;
} S;

#define TIMER_START 1
#define TIMER_STOP 2
#define HIGH_WATER (8u << 20)
#define LOW_WATER (1u << 20)

static void kev(uintptr_t ident, int16_t filter, uint16_t flags, uint32_t fflags, intptr_t data) {
    struct kevent ev;
    EV_SET(&ev, ident, filter, flags, fflags, data, NULL);
    kevent(S.kq, &ev, 1, NULL, 0, NULL);
}

static void set_nonblock(int fd) { fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK); }

static void flush_fd(int fd, buf *b, int is_session) {
    while (b->len) {
        ssize_t w = write(fd, b->p, b->len);
        if (w > 0) {
            buf_consume(b, (size_t)w);
            continue;
        }
        if (w < 0 && errno == EINTR) continue;
        if (w < 0 && errno == EAGAIN) {
            int *writing = is_session ? &S.writing_session : &S.writing_server;
            if (!*writing) kev((uintptr_t)fd, EVFILT_WRITE, EV_ADD | EV_ENABLE, 0, 0);
            *writing = 1;
            break;
        }
        b->len = 0; /* the reader is gone */
        if (!is_session && S.in_fd >= 0) {
            close(S.in_fd);
            S.in_fd = -1;
        }
        break;
    }
    int *writing = is_session ? &S.writing_session : &S.writing_server;
    if (!b->len && *writing) {
        kev((uintptr_t)fd, EVFILT_WRITE, EV_DELETE, 0, 0);
        *writing = 0;
    }
    /* flow control: stop reading the other side while this side is far behind */
    if (is_session) {
        if (b->len > HIGH_WATER && !S.read_paused_server && S.out_fd >= 0) {
            kev((uintptr_t)S.out_fd, EVFILT_READ, EV_DISABLE, 0, 0);
            S.read_paused_server = 1;
        } else if (b->len < LOW_WATER && S.read_paused_server && S.out_fd >= 0) {
            kev((uintptr_t)S.out_fd, EVFILT_READ, EV_ENABLE, 0, 0);
            S.read_paused_server = 0;
        }
    } else {
        if (b->len > HIGH_WATER && !S.read_paused_session) {
            kev(0, EVFILT_READ, EV_DISABLE, 0, 0);
            S.read_paused_session = 1;
        } else if (b->len < LOW_WATER && S.read_paused_session) {
            kev(0, EVFILT_READ, EV_ENABLE, 0, 0);
            S.read_paused_session = 0;
        }
    }
}

static void to_session(const char *s, size_t n) {
    buf_add(&S.to_session, s, n);
    buf_add(&S.to_session, "\n", 1);
    flush_fd(1, &S.to_session, 1);
}

static void to_server(const char *s, size_t n) {
    if (S.in_fd < 0) return;
    buf_add(&S.to_server, s, n);
    buf_add(&S.to_server, "\n", 1);
    flush_fd(S.in_fd, &S.to_server, 0);
}

static void reply_result(const char *id, size_t idn, const char *result) {
    buf b = {0};
    buf_str(&b, "{\"jsonrpc\":\"2.0\",\"id\":");
    buf_add(&b, id, idn);
    buf_str(&b, ",\"result\":");
    buf_str(&b, result);
    buf_str(&b, "}");
    to_session(b.p, b.len);
    free(b.p);
}

static void reply_error(const char *id, size_t idn, const char *message) {
    buf b = {0};
    buf_str(&b, "{\"jsonrpc\":\"2.0\",\"id\":");
    buf_add(&b, id, idn);
    buf_str(&b, ",\"error\":{\"code\":-32603,\"message\":\"");
    for (const char *m = message; *m; m++) {
        if (*m == '"' || *m == '\\') buf_add(&b, "\\", 1);
        buf_add(&b, m, 1);
    }
    buf_str(&b, "\"}}");
    to_session(b.p, b.len);
    free(b.p);
}

static double ms_since(struct timespec t0) {
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return (double)(t.tv_sec - t0.tv_sec) * 1e3 + (double)(t.tv_nsec - t0.tv_nsec) / 1e6;
}

static void request_key(buf *k, const char *line, size_t n, span method) {
    buf_add(k, line + method.s + 1, method.e - method.s - 2);
    buf_str(k, "\t");
    norm_params(k, line, member(line, n, "params"));
}

static int in_list(const char **list, const char *line, span m) {
    for (int i = 0; list[i]; i++) {
        size_t l = strlen(list[i]);
        if (m.e - m.s == l + 2 && line[m.s] == '"' && memcmp(line + m.s + 1, list[i], l) == 0) return 1;
    }
    return 0;
}

static int cached_method(const char *line, span m) { return in_list(CACHED, line, m); }

static int private_id_is(const char *line, span id, const char *suffix) {
    char want[64];
    snprintf(want, sizeof want, "\"%s%s\"", S.private_id, suffix);
    return span_eq(line, id, want);
}

/* The server runs in its own process group (its pid), so whatever it started goes with it. Only
 * the group: a reaped pid may already belong to someone else. */
static void kill_group(int sig) {
    if (S.pid > 0) killpg(S.pid, sig);
}

static void close_server_fds(void) {
    S.writing_server = 0;
    if (S.in_fd >= 0) close(S.in_fd);
    if (S.out_fd >= 0) close(S.out_fd);
    S.in_fd = S.out_fd = -1;
    S.to_server.len = 0;
    S.from_server.len = 0;
}

static int spawn_server(char *err, size_t errn) {
    int in[2], out[2];
    if (pipe(in) != 0 || pipe(out) != 0) {
        snprintf(err, errn, "pipe: %s", strerror(errno));
        return -1;
    }
    for (int i = 0; i < 2; i++) {
        fcntl(in[i], F_SETFD, FD_CLOEXEC);
        fcntl(out[i], F_SETFD, FD_CLOEXEC);
    }
    posix_spawn_file_actions_t fa;
    posix_spawnattr_t at;
    posix_spawn_file_actions_init(&fa);
    posix_spawn_file_actions_adddup2(&fa, in[0], 0);
    posix_spawn_file_actions_adddup2(&fa, out[1], 1);
    posix_spawn_file_actions_addinherit_np(&fa, 2);
    posix_spawnattr_init(&at);
    sigset_t none, all;
    sigemptyset(&none);
    sigfillset(&all);
    posix_spawnattr_setsigmask(&at, &none);
    posix_spawnattr_setsigdefault(&at, &all);
    posix_spawnattr_setpgroup(&at, 0);
    posix_spawnattr_setflags(&at, POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF |
                                      POSIX_SPAWN_CLOEXEC_DEFAULT);
    pid_t pid;
    int rc = posix_spawnp(&pid, S.argv[0], &fa, &at, S.argv, environ);
    posix_spawn_file_actions_destroy(&fa);
    posix_spawnattr_destroy(&at);
    close(in[0]);
    close(out[1]);
    if (rc != 0) {
        close(in[1]);
        close(out[0]);
        snprintf(err, errn, "%s: %s", S.argv[0], strerror(rc));
        return -1;
    }
    S.pid = pid;
    S.in_fd = in[1];
    S.out_fd = out[0];
    S.exited = S.out_eof = 0;
    set_nonblock(S.in_fd);
    set_nonblock(S.out_fd);
    kev((uintptr_t)S.out_fd, EVFILT_READ, EV_ADD, 0, 0);
    kev((uintptr_t)pid, EVFILT_PROC, EV_ADD | EV_ONESHOT, NOTE_EXIT, 0);
    return 0;
}

static void watch(const char *line, size_t n, span method, span id) {
    if (!(cached_method(line, method) || in_list(LOCAL, line, method)) || id.e <= id.s || S.nrec >= sizeof S.rec / sizeof S.rec[0]) return;
    buf k = {0};
    request_key(&k, line, n, method);
    S.rec[S.nrec].id = dup_n(line + id.s, id.e - id.s);
    S.rec[S.nrec].key = k.p;
    S.nrec++;
}

static void forward(const char *line, size_t n) {
    if (is_object(line, n)) {
        span method = member(line, n, "method"), id = member(line, n, "id");
        watch(line, n, method, id);
    }
    to_server(line, n);
}

static void start_failed(const char *reason) {
    char msg[256];
    snprintf(msg, sizeof msg, "mcp-lazy: %s did not start (%s); the next call tries again", g_name, reason);
    logf_("start failed: %s", reason);
    kev(TIMER_START, EVFILT_TIMER, EV_DELETE, 0, 0);
    kill_group(SIGKILL);
    if (S.pid > 0 && !S.exited) waitpid(S.pid, NULL, 0);
    close_server_fds();
    S.pid = 0;
    S.state = IDLE;
    for (size_t i = 0; i < S.npending; i++) {
        const char *l = S.pending[i];
        size_t n = strlen(l);
        if (is_object(l, n)) {
            span method = member(l, n, "method"), id = member(l, n, "id");
            if (method.e > method.s && id.e > id.s) reply_error(l + id.s, id.e - id.s, msg);
        }
        free(S.pending[i]);
    }
    S.npending = 0;
}

static void server_ready(const char *line, size_t n) {
    kev(TIMER_START, EVFILT_TIMER, EV_DELETE, 0, 0);
    S.state = RUNNING;
    const char *cached = S.init_key ? cache_lookup(S.init_key) : NULL;
    if (cached) {
        span a = member(line, n, "result"), b = member(cached, strlen(cached), "result");
        if (a.e - a.s != b.e - b.s || memcmp(line + a.s, cached + b.s, a.e - a.s) != 0) {
            logf_("initialize differs from the manifest: dropped");
            cache_drop();
        }
    }
    buf b = {0};
    for (size_t i = 0; i < S.nreplay; i++) {
        const char *l = S.replay[i];
        size_t ln = strlen(l);
        span id = member(l, ln, "id");
        if (id.e > id.s) {
            char rid[64];
            int rn = snprintf(rid, sizeof rid, "\"%s-replay-%zu\"", S.private_id, i + 1);
            with_id(&b, l, ln, rid, (size_t)rn);
            to_server(b.p, b.len);
        } else {
            to_server(l, ln);
        }
        free(S.replay[i]);
    }
    S.nreplay = 0;
    if (cache_lookup("tools/list\t{}")) {
        b.len = 0;
        buf_fmt(&b, "{\"jsonrpc\":\"2.0\",\"id\":\"%s-tools\",\"method\":\"tools/list\",\"params\":{}}", S.private_id);
        to_server(b.p, b.len);
        S.tools_check = 1;
    }
    free(b.p);
    logf_("started on first use in %.0f ms", ms_since(S.started_at));
    for (size_t i = 0; i < S.npending; i++) {
        forward(S.pending[i], strlen(S.pending[i]));
        free(S.pending[i]);
    }
    S.npending = 0;
}

/* Starts the real server for a lazy session. Returns 0 when it runs or is starting. */
static int start(const char *trigger, size_t n) {
    char err[256];
    clock_gettime(CLOCK_MONOTONIC, &S.started_at);
    if (spawn_server(err, sizeof err) != 0) {
        char msg[400];
        snprintf(msg, sizeof msg, "mcp-lazy: %s could not start: %s", g_name, err);
        logf_("start failed: %s", err);
        if (is_object(trigger, n)) {
            span method = member(trigger, n, "method"), id = member(trigger, n, "id");
            if (method.e > method.s && id.e > id.s) reply_error(trigger + id.s, id.e - id.s, msg);
        }
        return -1;
    }
    if (!S.init_line) {
        /* nothing was answered from the manifest that the server must know about */
        S.state = RUNNING;
        logf_("started before the handshake");
        forward(trigger, n);
        return 0;
    }
    S.state = STARTING;
    buf b = {0};
    char rid[64];
    int rn = snprintf(rid, sizeof rid, "\"%s-init\"", S.private_id);
    with_id(&b, S.init_line, strlen(S.init_line), rid, (size_t)rn);
    to_server(b.p, b.len);
    free(b.p);
    S.pending = realloc(S.pending, (S.npending + 1) * sizeof(char *));
    if (!S.pending) die_oom();
    S.pending[S.npending++] = dup_n(trigger, n);
    kev(TIMER_START, EVFILT_TIMER, EV_ADD | EV_ONESHOT, 0, (intptr_t)(S.start_timeout * 1000));
    return 0;
}

static void keep(char ***list, size_t *n, const char *line, size_t len) {
    *list = realloc(*list, (*n + 1) * sizeof(char *));
    if (!*list) die_oom();
    (*list)[(*n)++] = dup_n(line, len);
}

/* A session frame before the real server runs. 1 when answered or kept here. */
static int handle_lazy(const char *line, size_t n, span method, span id) {
    int has_id = id.e > id.s;
    if (method.e <= method.s) return 0;
    if (has_id && cached_method(line, method)) {
        buf k = {0};
        request_key(&k, line, n, method);
        const char *answer = cache_lookup(k.p);
        if (!answer) {
            free(k.p);
            return 0;
        }
        if (span_eq(line, method, "\"initialize\"")) {
            free(S.init_line);
            free(S.init_key);
            S.init_line = dup_n(line, n);
            S.init_key = k.p;
        } else {
            free(k.p);
        }
        buf out = {0};
        with_id(&out, answer, strlen(answer), line + id.s, id.e - id.s);
        to_session(out.p, out.len);
        free(out.p);
        return 1;
    }
    int ping = span_eq(line, method, "\"ping\"");
    if (has_id && (ping || (S.init_line && span_eq(line, method, "\"logging/setLevel\"")))) {
        if (!ping) keep(&S.replay, &S.nreplay, line, n);
        buf k = {0};
        request_key(&k, line, n, method);
        const char *answer = cache_lookup(k.p);
        free(k.p);
        if (answer) {
            buf out = {0};
            with_id(&out, answer, strlen(answer), line + id.s, id.e - id.s);
            to_session(out.p, out.len);
            free(out.p);
        } else {
            reply_result(line + id.s, id.e - id.s, "{}");
        }
        return 1;
    }
    if (!has_id && S.init_line) {
        if (!span_eq(line, method, "\"notifications/cancelled\"")) keep(&S.replay, &S.nreplay, line, n);
        return 1;
    }
    return 0;
}

static void on_session_line(const char *line, size_t n) {
    if (S.debug) logf_("session: %.200s", line);
    if (S.state == STARTING) {
        keep(&S.pending, &S.npending, line, n);
        return;
    }
    if (S.state == IDLE) {
        if (is_object(line, n)) {
            span method = member(line, n, "method"), id = member(line, n, "id");
            if (handle_lazy(line, n, method, id)) return;
        }
        start(line, n);
        return;
    }
    forward(line, n);
}

static void on_server_line(const char *line, size_t n) {
    int mine = memmem(line, n, S.private_id, strlen(S.private_id)) != NULL;
    if (mine || S.nrec) {
        span id = is_object(line, n) ? member(line, n, "id") : (span){0, 0};
        if (mine && id.e > id.s) {
            if (S.state == STARTING && private_id_is(line, id, "-init")) {
                server_ready(line, n);
                return;
            }
            if (private_id_is(line, id, "-tools")) {
                S.tools_check = 0;
                const char *cached = cache_lookup("tools/list\t{}");
                if (cached) {
                    span a = member(line, n, "result"), b = member(cached, strlen(cached), "result");
                    if (a.e - a.s != b.e - b.s || memcmp(line + a.s, cached + b.s, a.e - a.s) != 0) {
                        logf_("tools/list differs from the manifest: dropped, session told");
                        cache_drop();
                        static const char note[] = "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/tools/list_changed\"}";
                        to_session(note, sizeof note - 1);
                    }
                }
                return;
            }
            char prefix[40];
            int pn = snprintf(prefix, sizeof prefix, "\"%s", S.private_id);
            if (id.e - id.s > (size_t)pn && memcmp(line + id.s, prefix, (size_t)pn) == 0) return; /* replayed */
        }
        if (id.e > id.s) {
            for (size_t i = 0; i < S.nrec; i++) {
                if (strlen(S.rec[i].id) == id.e - id.s && memcmp(S.rec[i].id, line + id.s, id.e - id.s) == 0) {
                    span r = member(line, n, "result");
                    int ok = r.e > r.s;
                    if (!ok) {
                        span e = member(line, n, "error");
                        if (e.e > e.s) ok = span_eq(line + e.s, member(line + e.s, e.e - e.s, "code"), "-32601");
                    }
                    if (ok) cache_record(S.rec[i].key, line, n);
                    free(S.rec[i].id);
                    free(S.rec[i].key);
                    S.rec[i] = S.rec[--S.nrec];
                    break;
                }
            }
        }
    }
    to_session(line, n);
}

static void lines(buf *b, void (*each)(const char *, size_t)) {
    size_t off = 0;
    for (;;) {
        char *nl = memchr(b->p + off, '\n', b->len - off);
        if (!nl) break;
        size_t end = (size_t)(nl - b->p);
        size_t len = end - off;
        if (len && b->p[off + len - 1] == '\r') len--;
        if (len) {
            /* skip blank lines */
            size_t j = ws(b->p + off, len, 0);
            if (j < len) {
                b->p[off + len] = 0;
                each(b->p + off, len);
            }
        }
        off = end + 1;
    }
    if (off) buf_consume(b, off);
}

static void finish(int code) {
    /* hand the session everything it is owed, then go */
    fcntl(1, F_SETFL, S.stdout_flags & ~O_NONBLOCK);
    while (S.to_session.len) {
        ssize_t w = write(1, S.to_session.p, S.to_session.len);
        if (w <= 0) break;
        buf_consume(&S.to_session, (size_t)w);
    }
    fcntl(1, F_SETFL, S.stdout_flags);
    fcntl(0, F_SETFL, S.stdin_flags);
    if (S.pid > 0) kill_group(SIGTERM);
    _exit(code);
}

static void server_gone(void) {
    int code = WIFEXITED(S.status) ? WEXITSTATUS(S.status) : 1;
    if (S.state == STARTING) {
        char reason[64];
        snprintf(reason, sizeof reason, "exited with %d", code);
        start_failed(reason);
        if (S.session_eof) finish(0);
        return;
    }
    logf_("server exited (%d)", code);
    finish(S.stopping ? 0 : code);
}

static void stop(void) { /* the session is gone */
    S.stopping = 1;
    if (S.pid <= 0 || S.state == IDLE) finish(0);
    flush_fd(S.in_fd, &S.to_server, 0);
    if (S.in_fd >= 0 && !S.to_server.len) {
        close(S.in_fd);
        S.in_fd = -1;
    }
    kev(TIMER_STOP, EVFILT_TIMER, EV_ADD | EV_ONESHOT, 0, 3000);
}

int main(int argc, char **argv) {
    int at = 2;
    if (argc >= 3 && strcmp(argv[2], "--") == 0) at = 3;
    if (argc < at + 1) {
        static const char u[] = "usage: mcp-lazy <name> [--] <command> [args...]\n";
        write(2, u, sizeof u - 1);
        return 2;
    }
    g_name = argv[1];
    S.argc = argc - at;
    S.argv = argv + at;
    S.in_fd = S.out_fd = -1;
    S.debug = getenv("MCP_LAZY_DEBUG") && *getenv("MCP_LAZY_DEBUG");
    const char *t = getenv("MCP_LAZY_START_TIMEOUT");
    S.start_timeout = t && atof(t) > 0 ? atof(t) : 60;
    snprintf(S.private_id, sizeof S.private_id, "mcp-lazy-%08x%04x", arc4random(), arc4random() & 0xffff);

    const char *home = getenv("HOME");
    if (!home) home = "/tmp";
    const char *c = getenv("MCP_LAZY_CACHE");
    if (c && *c) snprintf(cache.dir, sizeof cache.dir, "%s", c);
    else snprintf(cache.dir, sizeof cache.dir, "%s/Library/Caches/mcp-lazy", home);
    const char *l = getenv("MCP_LAZY_LOG");
    if (l && *l) snprintf(g_log, sizeof g_log, "%s", l);
    else snprintf(g_log, sizeof g_log, "%s/Library/Logs/mcp-lazy.log", home);
    char key[33];
    server_key(key, S.argc, S.argv);
    char safe[64];
    snprintf(safe, sizeof safe, "%s", g_name);
    for (char *p = safe; *p; p++)
        if (*p == '/' || *p == '.') *p = '_';
    snprintf(cache.path, sizeof cache.path, "%s/%s-%s.manifest", cache.dir, safe, key);
    cache_load();

    signal(SIGPIPE, SIG_IGN);
    signal(SIGTERM, SIG_IGN);
    signal(SIGINT, SIG_IGN);
    S.kq = kqueue();
    S.stdin_flags = fcntl(0, F_GETFL);
    S.stdout_flags = fcntl(1, F_GETFL);
    set_nonblock(0);
    set_nonblock(1);
    kev(0, EVFILT_READ, EV_ADD, 0, 0);
    kev(SIGTERM, EVFILT_SIGNAL, EV_ADD, 0, 0);
    kev(SIGINT, EVFILT_SIGNAL, EV_ADD, 0, 0);

    if (cache.n) {
        S.state = IDLE;
        logf_("lazy: answers from the manifest");
    } else {
        char err[256];
        logf_("no manifest yet: running the server now");
        clock_gettime(CLOCK_MONOTONIC, &S.started_at);
        if (spawn_server(err, sizeof err) == 0) S.state = RUNNING;
        else logf_("start failed: %s", err);
    }

    char rbuf[65536];
    for (;;) {
        struct kevent evs[8];
        int ne = kevent(S.kq, NULL, 0, evs, 8, NULL);
        if (ne < 0) {
            if (errno == EINTR) continue;
            finish(1);
        }
        for (int i = 0; i < ne; i++) {
            struct kevent *e = &evs[i];
            if (e->filter == EVFILT_READ && e->ident == 0) {
                ssize_t r = read(0, rbuf, sizeof rbuf);
                if (r > 0) {
                    buf_add(&S.from_session, rbuf, (size_t)r);
                    lines(&S.from_session, on_session_line);
                } else if (r == 0 || (r < 0 && errno != EAGAIN && errno != EINTR)) {
                    if (S.from_session.len) { /* a last frame without its newline */
                        buf_add(&S.from_session, "\n", 1);
                        lines(&S.from_session, on_session_line);
                    }
                    kev(0, EVFILT_READ, EV_DELETE, 0, 0);
                    S.session_eof = 1;
                    stop();
                }
            } else if (e->filter == EVFILT_READ && (int)e->ident == S.out_fd) {
                ssize_t r;
                while ((r = read(S.out_fd, rbuf, sizeof rbuf)) > 0) {
                    buf_add(&S.from_server, rbuf, (size_t)r);
                    lines(&S.from_server, on_server_line);
                    if (S.out_fd < 0 || S.read_paused_server) break;
                }
                if (S.out_fd >= 0 && (r == 0 || (r < 0 && errno != EAGAIN && errno != EINTR))) {
                    kev((uintptr_t)S.out_fd, EVFILT_READ, EV_DELETE, 0, 0);
                    S.out_eof = 1;
                }
            } else if (e->filter == EVFILT_WRITE && e->ident == 1) {
                flush_fd(1, &S.to_session, 1);
            } else if (e->filter == EVFILT_WRITE && (int)e->ident == S.in_fd) {
                flush_fd(S.in_fd, &S.to_server, 0);
                if (S.stopping && S.in_fd >= 0 && !S.to_server.len) {
                    close(S.in_fd);
                    S.in_fd = -1;
                }
            } else if (e->filter == EVFILT_PROC && (pid_t)e->ident == S.pid) {
                waitpid(S.pid, &S.status, 0);
                S.exited = 1;
                /* what it wrote before exiting is in the pipe now; don't wait for EOF, which a
                 * child of its holding the pipe would put off forever */
                ssize_t r;
                while (S.out_fd >= 0 && (r = read(S.out_fd, rbuf, sizeof rbuf)) > 0) {
                    buf_add(&S.from_server, rbuf, (size_t)r);
                    lines(&S.from_server, on_server_line);
                }
                server_gone();
            } else if (e->filter == EVFILT_TIMER && e->ident == TIMER_START) {
                if (S.state == STARTING) {
                    start_failed("no answer to initialize");
                    if (S.session_eof) finish(0);
                }
            } else if (e->filter == EVFILT_TIMER && e->ident == TIMER_STOP) {
                if (S.stopping < 2) {
                    kill_group(SIGTERM);
                    S.stopping = 2;
                    kev(TIMER_STOP, EVFILT_TIMER, EV_ADD | EV_ONESHOT, 0, 2000);
                } else {
                    kill_group(SIGKILL);
                    finish(0);
                }
            } else if (e->filter == EVFILT_SIGNAL) {
                if (S.pid > 0 && S.state != IDLE) {
                    kill_group((int)e->ident);
                    S.stopping = 2;
                    kev(TIMER_STOP, EVFILT_TIMER, EV_ADD | EV_ONESHOT, 0, 3000);
                } else {
                    finish(0);
                }
            }
        }
    }
}
