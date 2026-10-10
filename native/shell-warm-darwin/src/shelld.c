// pod-shelld <key> <socket-path>: per-Claude-process pool of pre-started /bin/zsh
// processes that already ran the Bash tool's snapshot prelude. The `zsh` client
// spawns it (double fork) so it inherits Claude Code's responsible process,
// coalition and audit session. It exits when $CLAUDE_PID exits or after idling.
//
// A warm shell W is /bin/zsh -c "<prelude> && <boot> && : \"${$(< CMDFILE)%.}\" &&
// eval \"$_\" [< /dev/null] && pwd -P >| \"${$(< CWDFFILE)}\"", spawned with the
// request's exact env, cwd, umask, signal mask/ignores and QoS, setsid. <boot>
// blocks on fd 3 for the task output path, opens it with Claude Code's flags
// (O_WRONLY|O_APPEND|O_NONBLOCK) onto fds 1 and 2, reports 'g', closes fd 3,
// unloads zsh/system and unsets its variables, so the eval sees the same state
// as a fresh shell. CMD reaches eval through `$_`, not a variable.
#include <errno.h>
#include <fcntl.h>
#include <libproc.h>
#include <signal.h>
#include <spawn.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/event.h>
#include <sys/file.h>
#include <sys/param.h>
#include <sys/proc_info.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#include "proto.h"

#ifndef POSIX_SPAWN_SETSID
#define POSIX_SPAWN_SETSID 0x0400
#endif

extern char **environ;
int posix_spawnattr_set_qos_class_np(posix_spawnattr_t *attr, int qos_class);

#define MAXW 6
#define MAXC 64
#define W_MAX_AGE (30 * 60)
#define IDLE_EXIT (30 * 60)
#define OUT_FLAGS (O_WRONLY | O_APPEND | O_NONBLOCK)

static int kq, lsock, logfd = -1;
static char wdir[MAXPATHLEN];
static const char *real_shell = "/bin/zsh";
static unsigned long seq;
static time_t last_activity;
static long n_hit, n_miss, n_spawn;

static void logf_(const char *fmt, ...) {
  if (logfd < 0) return;
  char b[512];
  struct timeval tv;
  gettimeofday(&tv, NULL);
  int n = snprintf(b, sizeof b, "%ld.%03d ", (long)tv.tv_sec, (int)(tv.tv_usec / 1000));
  va_list ap;
  va_start(ap, fmt);
  n += vsnprintf(b + n, sizeof b - n, fmt, ap);
  va_end(ap);
  if (n > (int)sizeof b - 2) n = sizeof b - 2;
  b[n++] = '\n';
  (void)write(logfd, b, n);
}

// ---------------------------------------------------------------- key material

struct key {
  struct pnb_fixed fx;  // flavor and out_* fields are not part of the key
  char *spre, *cwd, *env;
  uint32_t spre_n, cwd_n, env_n;
};

static int key_eq(const struct key *a, const struct key *b) {
  return a->fx.umask == b->fx.umask && a->fx.qos == b->fx.qos && a->fx.nice == b->fx.nice &&
         a->fx.sigmask == b->fx.sigmask && a->fx.sigign == b->fx.sigign && a->fx.cwd_dev == b->fx.cwd_dev &&
         a->fx.cwd_ino == b->fx.cwd_ino && a->spre_n == b->spre_n && a->cwd_n == b->cwd_n && a->env_n == b->env_n &&
         !memcmp(a->spre, b->spre, a->spre_n) && !memcmp(a->cwd, b->cwd, a->cwd_n) && !memcmp(a->env, b->env, a->env_n);
}

static char *dupn(const char *p, uint32_t n) {
  char *d = malloc(n + 1);
  if (d) {
    memcpy(d, p, n);
    d[n] = 0;
  }
  return d;
}

static int key_copy(struct key *d, const struct key *s) {
  *d = *s;
  d->spre = dupn(s->spre, s->spre_n);
  d->cwd = dupn(s->cwd, s->cwd_n);
  d->env = dupn(s->env, s->env_n);
  return d->spre && d->cwd && d->env ? 0 : -1;
}

static void key_free(struct key *k) {
  free(k->spre);
  free(k->cwd);
  free(k->env);
  memset(k, 0, sizeof *k);
}

// ---------------------------------------------------------------- startup-file staleness

static const char *startup_files[3];

static void startup_init(void) {
  static char zshenv[MAXPATHLEN];
  const char *zd = getenv("ZDOTDIR");
  if (!zd || !*zd) zd = getenv("HOME");
  snprintf(zshenv, sizeof zshenv, "%s/.zshenv", zd ? zd : "/");
  startup_files[0] = "/etc/zshenv";
  startup_files[1] = zshenv;
  startup_files[2] = NULL;
}

static void startup_snap(struct stat *out) {
  for (int i = 0; startup_files[i]; i++)
    if (stat(startup_files[i], &out[i])) memset(&out[i], 0, sizeof out[i]);
}

static int startup_same(const struct stat *a) {
  struct stat now[3];
  startup_snap(now);
  for (int i = 0; startup_files[i]; i++)
    if (now[i].st_ino != a[i].st_ino || now[i].st_size != a[i].st_size ||
        now[i].st_mtimespec.tv_sec != a[i].st_mtimespec.tv_sec || now[i].st_mtimespec.tv_nsec != a[i].st_mtimespec.tv_nsec)
      return 0;
  return 1;
}

// ---------------------------------------------------------------- warm shells

enum { W_FREE, W_IDLE, W_BUSY };

struct w {
  int state, flavor;
  pid_t pid;
  int ctl, in, junk;
  int client;  // index into clients when busy
  int committed, tainted;
  time_t born;
  struct key k;
  struct stat st_startup[3];
  uint64_t out_dev, out_ino;
  char cmdf[MAXPATHLEN], cwdff[MAXPATHLEN];
  char cwdfile[MAXPATHLEN];
};

struct client {
  int fd;
  int w;  // -1 when not assigned
};

static struct w ws[MAXW];
static struct client cs[MAXC];

static int ev(int fd, int filt, int flags, int fflags, void *udata) {
  struct kevent k;
  EV_SET(&k, fd, filt, flags, fflags, 0, udata);
  return kevent(kq, &k, 1, NULL, 0, NULL);
}

static void cloexec(int fd) { fcntl(fd, F_SETFD, FD_CLOEXEC); }

static int sq_append(char *out, size_t n, const char *s) {
  // single-quote for zsh
  size_t o = strlen(out);
  if (o + 2 >= n) return -1;
  out[o++] = '\'';
  for (; *s; s++) {
    if (*s == '\'') {
      if (o + 5 >= n) return -1;
      memcpy(out + o, "'\\''", 4);
      o += 4;
    } else {
      if (o + 2 >= n) return -1;
      out[o++] = *s;
    }
  }
  out[o++] = '\'';
  out[o] = 0;
  return 0;
}

static void tree_kill(pid_t root, int sig) {
  pid_t q[512];
  int qn = 0, qi = 0;
  q[qn++] = root;
  while (qi < qn) {
    pid_t kids[256];
    int n = proc_listchildpids(q[qi++], kids, sizeof kids);
    for (int i = 0; i < n && qn < 512; i++)
      if (kids[i] > 1) q[qn++] = kids[i];
  }
  if (killpg(root, sig) && errno != ESRCH) kill(root, sig);
  for (int i = 1; i < qn; i++) kill(q[i], sig);
}

static void w_close_fds(struct w *w) {
  if (w->ctl >= 0) close(w->ctl);
  if (w->in >= 0) close(w->in);
  if (w->junk >= 0) close(w->junk);
  w->ctl = w->in = w->junk = -1;
}

static void w_exit(int slot);

static int spawn_w(const struct key *k, int flavor) {
  int slot = -1;
  time_t oldest = 0;
  for (int i = 0; i < MAXW; i++)
    if (ws[i].state == W_FREE) {
      slot = i;
      break;
    }
  if (slot < 0) {
    for (int i = 0; i < MAXW; i++)
      if (ws[i].state == W_IDLE && (slot < 0 || ws[i].born < oldest)) slot = i, oldest = ws[i].born;
    if (slot < 0) return -1;
    tree_kill(ws[slot].pid, SIGKILL);  // reaped on NOTE_EXIT
    ws[slot].tainted = 1;
    return -1;  // retry on the next miss; keeps the slot bookkeeping simple
  }
  struct w *w = &ws[slot];
  memset(w, 0, sizeof *w);
  w->ctl = w->in = w->junk = -1;
  w->client = -1;
  if (key_copy(&w->k, k)) return -1;
  w->flavor = flavor;
  unsigned long id = ++seq;
  snprintf(w->cmdf, sizeof w->cmdf, "%s/w%lu.cmd", wdir, id);
  snprintf(w->cwdff, sizeof w->cwdff, "%s/w%lu.cwdf", wdir, id);

  static char s[1 << 16];
  if (k->spre_n + 2048 > sizeof s) goto fail;
  memcpy(s, k->spre, k->spre_n);
  s[k->spre_n] = 0;
  strcat(s,
         // The request is "<dev>:<ino>\n<path>"; the opened fd must be that exact file (race-free check).
         " && { zmodload zsh/system && zmodload -F zsh/stat b:zstat && sysread -i 3 __pnb_p"
         " && sysopen -w -a -o nonblock -u __pnb_f \"${__pnb_p#*$'\\n'}\" && exec 1>&$__pnb_f 2>&1 {__pnb_f}>&-"
         " && zstat -A __pnb_i +device -f 1 && zstat -A __pnb_j +inode -f 1"
         " && [[ \"$__pnb_i:$__pnb_j\" == \"${__pnb_p%%$'\\n'*}\" ]] && zmodload -u zsh/stat zsh/system"
         " && unset __pnb_p __pnb_f __pnb_i __pnb_j && SECONDS=0 && print -nu 3 g && exec 3<&- || exit 199 } && : \"${$(< ");
  if (sq_append(s, sizeof s, w->cmdf)) goto fail;
  strcat(s, ")%.}\" && eval \"$_\"");
  if (flavor == PNB_FLAVOR_DEVNULL) strcat(s, " < /dev/null");
  strcat(s, " && pwd -P >| \"${$(< ");
  if (sq_append(s, sizeof s, w->cwdff)) goto fail;
  strcat(s, ")}\"");

  int ctl[2], in[2], junk[2];
  if (socketpair(AF_UNIX, SOCK_STREAM, 0, ctl)) goto fail;
  if (socketpair(AF_UNIX, SOCK_STREAM, 0, in)) {
    close(ctl[0]), close(ctl[1]);
    goto fail;
  }
  if (pipe(junk)) {
    close(ctl[0]), close(ctl[1]), close(in[0]), close(in[1]);
    goto fail;
  }
  int one = 1;
  setsockopt(ctl[0], SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof one);

  // env blob -> envp
  int ne = 0;
  for (uint32_t i = 0; i < k->env_n; i++)
    if (!k->env[i]) ne++;
  char **envp = calloc(ne + 1, sizeof *envp);
  if (!envp) goto fail_fds;
  char *e = w->k.env;
  for (int i = 0; i < ne; i++) {
    envp[i] = e;
    e += strlen(e) + 1;
  }

  posix_spawn_file_actions_t fa;
  posix_spawnattr_t at;
  posix_spawn_file_actions_init(&fa);
  posix_spawnattr_init(&at);
  posix_spawn_file_actions_adddup2(&fa, in[1], 0);
  posix_spawn_file_actions_adddup2(&fa, junk[1], 1);
  posix_spawn_file_actions_adddup2(&fa, junk[1], 2);
  posix_spawn_file_actions_adddup2(&fa, ctl[1], 3);
  posix_spawn_file_actions_addchdir_np(&fa, w->k.cwd);  // _np: the macOS 13 floor predates the POSIX name
  sigset_t mask = (sigset_t)k->fx.sigmask, def;
  sigfillset(&def);
  struct sigaction ign = {.sa_handler = SIG_IGN}, saved[32];
  for (int sg = 1; sg < 32; sg++)
    if (k->fx.sigign & (1u << sg)) {
      sigdelset(&def, sg);
      sigaction(sg, &ign, &saved[sg]);
    }
  posix_spawnattr_setsigmask(&at, &mask);
  posix_spawnattr_setsigdefault(&at, &def);
  posix_spawnattr_setflags(&at, POSIX_SPAWN_SETSID | POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_CLOEXEC_DEFAULT);
  posix_spawnattr_set_qos_class_np(&at, k->fx.qos);
  mode_t old_um = umask((mode_t)k->fx.umask);
  char *argv[] = {(char *)real_shell, "-c", s, NULL};
  startup_snap(w->st_startup);
  int rc = posix_spawn(&w->pid, real_shell, &fa, &at, argv, envp);
  umask(old_um);
  for (int sg = 1; sg < 32; sg++)
    if (k->fx.sigign & (1u << sg)) sigaction(sg, &saved[sg], NULL);
  posix_spawn_file_actions_destroy(&fa);
  posix_spawnattr_destroy(&at);
  free(envp);
  close(ctl[1]), close(in[1]), close(junk[1]);
  if (rc) {
    close(ctl[0]), close(in[0]), close(junk[0]);
    errno = rc;
    logf_("spawn failed: %s", strerror(rc));
    goto fail;
  }
  if (k->fx.nice != getpriority(PRIO_PROCESS, 0)) setpriority(PRIO_PROCESS, w->pid, k->fx.nice);
  w->ctl = ctl[0], w->in = in[0], w->junk = junk[0];
  cloexec(w->ctl), cloexec(w->in), cloexec(w->junk);
  w->state = W_IDLE;
  w->born = time(NULL);
  n_spawn++;
  ev(w->junk, EVFILT_READ, EV_ADD, 0, (void *)(intptr_t)(0x20000 + slot));
  if (ev(w->pid, EVFILT_PROC, EV_ADD | EV_ONESHOT, NOTE_EXIT, (void *)(intptr_t)(0x10000 + slot))) {
    // Already gone: reap now so the slot cannot leak.
    w->tainted = 1;
    w_exit(slot);
    return -1;
  }
  logf_("spawn w%lu pid %d flavor %d", id, w->pid, flavor);
  return slot;
fail_fds:
  close(ctl[0]), close(ctl[1]), close(in[0]), close(in[1]), close(junk[0]), close(junk[1]);
fail:
  key_free(&w->k);
  w->state = W_FREE;
  return -1;
}

// ---------------------------------------------------------------- clients

static void client_close(int ci) {
  if (cs[ci].fd >= 0) {
    ev(cs[ci].fd, EVFILT_READ, EV_DELETE, 0, NULL);
    close(cs[ci].fd);
  }
  cs[ci].fd = -1;
  cs[ci].w = -1;
}

static void reply(int ci, char c, const int32_t *st) {
  char b[5] = {c};
  size_t n = 1;
  if (st) memcpy(b + 1, st, 4), n = 5;
  (void)write(cs[ci].fd, b, n);
}

static int read_full(int fd, void *p, size_t n) {
  for (size_t got = 0; got < n;) {
    ssize_t r = read(fd, (char *)p + got, n - got);
    if (r < 0 && errno == EINTR) continue;
    if (r <= 0) return -1;
    got += r;
  }
  return 0;
}

static int write_file(const char *path, const char *p, size_t n, const char *suffix) {
  int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (fd < 0) return -1;
  int ok = write(fd, p, n) == (ssize_t)n && (!suffix || write(fd, suffix, strlen(suffix)) == (ssize_t)strlen(suffix));
  close(fd);
  return ok ? 0 : -1;
}

static int snapshot_ok(const struct key *k) {
  // The prelude starts with `source <path> `; bare paths only (Claude Code quotes unusual ones).
  const char *p = k->spre + 7, *e = strchr(p, ' ');
  if (strncmp(k->spre, "source ", 7) || !e || *p == '\'') return 1;
  char path[MAXPATHLEN];
  if ((size_t)(e - p) >= sizeof path) return 0;
  memcpy(path, p, e - p);
  path[e - p] = 0;
  return access(path, R_OK) == 0;
}

static void handle_request(int ci) {
  int fd = cs[ci].fd;
  uint32_t hdr[2];
  struct timeval tv = {2, 0};
  setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
  if (read_full(fd, hdr, sizeof hdr) || hdr[0] != PNB_MAGIC || hdr[1] > (64u << 20)) {
    client_close(ci);
    return;
  }
  char *body = malloc(hdr[1]);
  if (!body || read_full(fd, body, hdr[1])) {
    free(body);
    client_close(ci);
    return;
  }
  struct key k = {0};
  char *blob[PNB_NBLOBS];
  uint32_t bn[PNB_NBLOBS];
  size_t off = sizeof(struct pnb_fixed);
  if (hdr[1] < off) goto bad;
  memcpy(&k.fx, body, sizeof k.fx);
  for (int i = 0; i < PNB_NBLOBS; i++) {
    if (off + 4 > hdr[1]) goto bad;
    memcpy(&bn[i], body + off, 4);
    off += 4;
    if (off + bn[i] > hdr[1]) goto bad;
    blob[i] = body + off;
    off += bn[i];
  }
  k.spre = blob[B_SPRE], k.spre_n = bn[B_SPRE];
  k.cwd = blob[B_CWD], k.cwd_n = bn[B_CWD];
  k.env = blob[B_ENV], k.env_n = bn[B_ENV];
  last_activity = time(NULL);

  const char *why = NULL;
  int hit = -1;
  if (k.fx.out_flags != OUT_FLAGS) why = "out-flags";
  else if (bn[B_OUTPATH] >= MAXPATHLEN || bn[B_CWDFILE] >= MAXPATHLEN || memchr(blob[B_OUTPATH], 0, bn[B_OUTPATH]))
    why = "paths";
  else if (!snapshot_ok(&k)) why = "snapshot";
  if (!why) {
    for (int i = 0; i < MAXW; i++) {
      struct w *w = &ws[i];
      if (w->state != W_IDLE || w->flavor != (int)k.fx.flavor || w->tainted || !key_eq(&w->k, &k)) continue;
      if (time(NULL) - w->born > W_MAX_AGE || !startup_same(w->st_startup)) {
        tree_kill(w->pid, SIGKILL);
        w->tainted = 1;
        continue;
      }
      hit = i;
      break;
    }
    if (hit < 0) why = "cold";
  }
  if (hit >= 0) {
    struct w *w = &ws[hit];
    char msg[MAXPATHLEN + 64];
    int ml = snprintf(msg, sizeof msg, "%llu:%llu\n", (unsigned long long)k.fx.out_dev, (unsigned long long)k.fx.out_ino);
    memcpy(msg + ml, blob[B_OUTPATH], bn[B_OUTPATH]);
    ml += bn[B_OUTPATH];
    if (write_file(w->cmdf, blob[B_CMD], bn[B_CMD], ".") || write_file(w->cwdff, blob[B_CWDFILE], bn[B_CWDFILE], NULL) ||
        write(w->ctl, msg, ml) != ml) {
      why = "assign";
      tree_kill(w->pid, SIGKILL);
      w->tainted = 1;
    } else {
      memcpy(w->cwdfile, blob[B_CWDFILE], bn[B_CWDFILE]);
      w->cwdfile[bn[B_CWDFILE]] = 0;
      w->out_dev = k.fx.out_dev, w->out_ino = k.fx.out_ino;
      w->state = W_BUSY;
      w->client = ci;
      cs[ci].w = hit;
      ev(w->ctl, EVFILT_READ, EV_ADD, 0, (void *)(intptr_t)(0x30000 + hit));
      n_hit++;
      logf_("hit pid %d", w->pid);
    }
  }
  if (why) {
    n_miss++;
    logf_("miss %s", why);
    reply(ci, 'M', NULL);
    client_close(ci);
    if (!strcmp(why, "cold")) spawn_w(&k, k.fx.flavor);
  }
  free(body);
  return;
bad:
  free(body);
  client_close(ci);
}

static void client_event(int ci) {
  if (cs[ci].w < 0) {
    handle_request(ci);
    return;
  }
  unsigned char m[2];
  ssize_t n = read(cs[ci].fd, m, 2);
  struct w *w = &ws[cs[ci].w];
  if (n == 2 && m[0] == 'S') {
    tree_kill(w->pid, m[1]);
    logf_("relay sig %d to %d", m[1], w->pid);
    return;
  }
  if (n <= 0) {
    // Client died (Claude Code SIGKILLed it after its grace period): same for the command tree.
    tree_kill(w->pid, SIGKILL);
    logf_("client gone, killed %d", w->pid);
    w->client = -1;
    client_close(ci);
  }
}

static void w_exit(int slot) {
  struct w *w = &ws[slot];
  int st = 0;
  waitpid(w->pid, &st, 0);
  if (w->state == W_BUSY && !w->committed && w->ctl >= 0) {
    // NOTE_EXIT can be delivered before the ctl read event: 'g' is already buffered if
    // the command started, and replying 'M' then would make the client run it twice.
    char c;
    fcntl(w->ctl, F_SETFL, O_NONBLOCK);
    if (read(w->ctl, &c, 1) == 1 && c == 'g') w->committed = 1;
  }
  if (w->state == W_BUSY && w->client >= 0) {
    int ci = w->client;
    if (w->committed) {
      int32_t s32 = st;
      reply(ci, 'X', &s32);
    } else {
      reply(ci, 'M', NULL);
      logf_("setup failed pid %d status %d", w->pid, st);
    }
    client_close(ci);
  } else if (w->state == W_IDLE && !w->tainted) {
    logf_("idle shell died pid %d status %d", w->pid, st);
  }
  int was_busy = w->state == W_BUSY && w->committed;
  unlink(w->cmdf);
  unlink(w->cwdff);
  w_close_fds(w);
  struct key k;
  int flavor = w->flavor;
  int respawn = was_busy && key_copy(&k, &w->k) == 0;
  if (respawn) {
    // Follow `cd`: the next call most likely starts where this one ended.
    char nc[MAXPATHLEN];
    int fd = open(w->cwdfile, O_RDONLY | O_CLOEXEC);
    ssize_t n = fd >= 0 ? read(fd, nc, sizeof nc - 1) : -1;
    if (fd >= 0) close(fd);
    struct stat cst;
    if (n > 1 && nc[n - 1] == '\n') {
      nc[n - 1] = 0;
      if (strcmp(nc, k.cwd) && stat(nc, &cst) == 0 && S_ISDIR(cst.st_mode)) {
        free(k.cwd);
        k.cwd = strdup(nc);
        k.cwd_n = strlen(nc);
        k.fx.cwd_dev = cst.st_dev;
        k.fx.cwd_ino = cst.st_ino;
      }
    }
  }
  key_free(&w->k);
  w->state = W_FREE;
  if (respawn) {
    if (k.cwd) spawn_w(&k, flavor);
    key_free(&k);
  }
}

static void ctl_event(int slot) {
  struct w *w = &ws[slot];
  char c;
  ssize_t n = read(w->ctl, &c, 1);
  if (n == 1 && c == 'g') w->committed = 1;
  if (n <= 0) ev(w->ctl, EVFILT_READ, EV_DELETE, 0, NULL);
}

static void junk_event(int slot) {
  struct w *w = &ws[slot];
  char b[256];
  ssize_t n = read(w->junk, b, sizeof b);
  if (n > 0 && !w->committed) {
    // The prelude wrote output: a fresh shell would have written it to the task file.
    logf_("prelude output from pid %d: not poolable", w->pid);
    w->tainted = 1;
    tree_kill(w->pid, SIGKILL);
  }
  if (n <= 0) {
    ev(w->junk, EVFILT_READ, EV_DELETE, 0, NULL);
    close(w->junk);
    w->junk = -1;
  }
}

// ---------------------------------------------------------------- main

static int setup_dirs(const char *spath, const char *key) {
  char dir[MAXPATHLEN];
  snprintf(dir, sizeof dir, "%s", spath);
  char *sl = strrchr(dir, '/');
  if (!sl) return -1;
  *sl = 0;
  if (mkdir(dir, 0700) && errno != EEXIST) return -1;
  struct stat st;
  if (lstat(dir, &st) || !S_ISDIR(st.st_mode) || st.st_uid != getuid() || (st.st_mode & 077)) return -1;
  snprintf(wdir, sizeof wdir, "%s/%s.d", dir, key);
  if (mkdir(wdir, 0700) && errno != EEXIST) return -1;
  if (lstat(wdir, &st) || !S_ISDIR(st.st_mode) || st.st_uid != getuid() || (st.st_mode & 077)) return -1;
  return 0;
}

int main(int argc, char **argv) {
  if (argc != 3) return 2;
  const char *key = argv[1], *spath = argv[2];
  const char *rs = getenv("POD_NATIVE_BASH_REAL_SHELL");
  if (rs && *rs == '/') real_shell = rs;
  signal(SIGPIPE, SIG_IGN);
  umask(077);
  if (setup_dirs(spath, key)) return 1;
  char lockp[MAXPATHLEN], logp[MAXPATHLEN];
  snprintf(lockp, sizeof lockp, "%s/lock", wdir);
  int lk = open(lockp, O_RDWR | O_CREAT | O_CLOEXEC, 0600);
  if (lk < 0 || flock(lk, LOCK_EX | LOCK_NB)) return 0;  // another daemon owns this key
  snprintf(logp, sizeof logp, "%s/shelld.log", wdir);
  if (getenv("POD_SHELLD_LOG")) logfd = open(logp, O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC, 0600);
  startup_init();

  lsock = socket(AF_UNIX, SOCK_STREAM, 0);
  struct sockaddr_un a = {.sun_family = AF_UNIX};
  if (strlen(spath) >= sizeof a.sun_path) return 1;
  strcpy(a.sun_path, spath);
  unlink(spath);
  if (bind(lsock, (struct sockaddr *)&a, sizeof a) || listen(lsock, 64)) return 1;
  chmod(spath, 0600);
  cloexec(lsock);
  for (int i = 0; i < MAXC; i++) cs[i].fd = -1, cs[i].w = -1;
  for (int i = 0; i < MAXW; i++) ws[i].state = W_FREE;

  kq = kqueue();
  ev(lsock, EVFILT_READ, EV_ADD, 0, (void *)(intptr_t)1);
  const char *cp = getenv("CLAUDE_PID");
  pid_t watch = cp ? (pid_t)atoi(cp) : 0;
  if (watch > 1) ev(watch, EVFILT_PROC, EV_ADD | EV_ONESHOT, NOTE_EXIT, (void *)(intptr_t)2);
  struct kevent t;
  EV_SET(&t, 1, EVFILT_TIMER, EV_ADD, NOTE_SECONDS, 30, (void *)(intptr_t)3);
  kevent(kq, &t, 1, NULL, 0, NULL);
  last_activity = time(NULL);
  logf_("start key %s watch %d", key, watch);

  for (;;) {
    struct kevent evs[32];
    int n = kevent(kq, NULL, 0, evs, 32, NULL);
    if (n < 0 && errno == EINTR) continue;
    for (int i = 0; i < n; i++) {
      intptr_t u = (intptr_t)evs[i].udata;
      if (u == 1) {
        int c = accept(lsock, NULL, NULL);
        if (c < 0) continue;
        cloexec(c);
        uid_t uid;
        gid_t gid;
        if (getpeereid(c, &uid, &gid) || uid != getuid()) {
          close(c);
          continue;
        }
        int one = 1;
        setsockopt(c, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof one);
        int ci = -1;
        for (int j = 0; j < MAXC; j++)
          if (cs[j].fd < 0) {
            ci = j;
            break;
          }
        if (ci < 0) {
          close(c);
          continue;
        }
        cs[ci].fd = c;
        cs[ci].w = -1;
        ev(c, EVFILT_READ, EV_ADD, 0, (void *)(intptr_t)(0x40000 + ci));
      } else if (u == 2) {
        struct rusage ru_s, ru_c;
        getrusage(RUSAGE_SELF, &ru_s);
        getrusage(RUSAGE_CHILDREN, &ru_c);
        logf_("watched pid exited; hits %ld misses %ld spawns %ld cpu_self_ms %.1f cpu_shells_ms %.1f", n_hit, n_miss, n_spawn,
              (ru_s.ru_utime.tv_sec + ru_s.ru_stime.tv_sec) * 1e3 + (ru_s.ru_utime.tv_usec + ru_s.ru_stime.tv_usec) / 1e3,
              (ru_c.ru_utime.tv_sec + ru_c.ru_stime.tv_sec) * 1e3 + (ru_c.ru_utime.tv_usec + ru_c.ru_stime.tv_usec) / 1e3);
        goto out;
      } else if (u == 3) {
        int busy = 0;
        for (int j = 0; j < MAXW; j++) busy |= ws[j].state == W_BUSY;
        if (!busy && time(NULL) - last_activity > IDLE_EXIT) goto out;
      } else if (u >= 0x40000) {
        client_event(u - 0x40000);
      } else if (u >= 0x30000) {
        ctl_event(u - 0x30000);
      } else if (u >= 0x20000) {
        junk_event(u - 0x20000);
      } else if (u >= 0x10000) {
        w_exit(u - 0x10000);
      }
    }
  }
out:
  unlink(spath);
  close(lsock);
  for (int j = 0; j < MAXW; j++)
    if (ws[j].state == W_IDLE) tree_kill(ws[j].pid, SIGKILL);
  return 0;
}
