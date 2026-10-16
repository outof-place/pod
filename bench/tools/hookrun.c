// hookrun: replays recorded hook payloads against one hook command, one event at a time, the way
// Claude Code runs a command hook: spawn the command, write the payload to its stdin, close stdin,
// read its stdout and stderr to EOF and reap it.
//
//   hookrun <payloads.jsonl> <gap-ms> -- <argv>...
//
// Each line of payloads.jsonl is written as one event's stdin (without the newline). The command
// gets hookrun's own environment. Per event, one JSON line on stdout:
// - wallUs: spawn to the later of exit and stdout/stderr EOF (Node's 'close', what a caller waits
//   for); exitUs and eofUs on their own;
// - cpuNs: user+system CPU of the whole process tree, read from the reaped-but-unwaited top process
//   (its own time plus every descendant its tree waited for); outlivedCpuNs adds any process that
//   outlived the top one;
// - processes: every process of the tree seen through kqueue (the command is spawned suspended,
//   so its first fork cannot be missed; a grandchild that exits before its parent's NOTE_FORK is
//   read can be, so this is a lower bound), execs among them, and outlived;
// - pid: the top pid. Pids are handed out in order, so the next event's pid minus this one bounds
//   the processes this event created from above (other processes on the Mac also take pids).
#include <errno.h>
#include <fcntl.h>
#include <libproc.h>
#include <mach/mach_time.h>
#include <signal.h>
#include <spawn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/event.h>
#include <sys/resource.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

extern char **environ;

#define MAX_TREE 4096

static mach_timebase_info_data_t timebase;
static pid_t tree[MAX_TREE];
static int tree_count, exec_count;

static uint64_t now_ns(void) { return clock_gettime_nsec_np(CLOCK_UPTIME_RAW); }

static uint64_t ticks_ns(uint64_t ticks) { return ticks * timebase.numer / timebase.denom; }

static int in_tree(pid_t pid) {
  for (int i = 0; i < tree_count; i++) {
    if (tree[i] == pid) return 1;
  }
  return 0;
}

static void watch(int kq, pid_t pid);

// A tracked process forked: register every child not seen yet, then their children, since a
// child may fork again before this runs.
static void adopt_children(int kq, pid_t parent) {
  pid_t kids[256];
  int n = proc_listchildpids(parent, kids, sizeof(kids));
  if (n <= 0) return;
  // proc_listchildpids returns a count of pids on current macOS, bytes on some older ones.
  if (n > 256) n /= (int)sizeof(pid_t);
  for (int i = 0; i < n && i < 256; i++) {
    if (kids[i] > 0 && !in_tree(kids[i])) watch(kq, kids[i]);
  }
}

static void watch(int kq, pid_t pid) {
  if (tree_count >= MAX_TREE) return;
  tree[tree_count++] = pid;
  struct kevent ev;
  EV_SET(&ev, (uintptr_t)pid, EVFILT_PROC, EV_ADD, NOTE_EXIT | NOTE_FORK | NOTE_EXEC, 0, NULL);
  // ESRCH: it already exited; it still counts as one of the tree's processes.
  if (kevent(kq, &ev, 1, NULL, 0, NULL) == 0) adopt_children(kq, pid);
}

// CPU of a process that exited but is not reaped yet: its own time plus its reaped descendants'.
static int zombie_cpu(pid_t pid, uint64_t *total, uint64_t *own, uint64_t *instructions) {
  struct rusage_info_v4 ri;
  if (proc_pid_rusage(pid, RUSAGE_INFO_V4, (rusage_info_t *)&ri) != 0) return -1;
  *own = ticks_ns(ri.ri_user_time + ri.ri_system_time);
  *total = *own + ticks_ns(ri.ri_child_user_time + ri.ri_child_system_time);
  *instructions = ri.ri_instructions;
  return 0;
}

static void json_bytes(const char *s, size_t n) {
  putchar('"');
  for (size_t i = 0; i < n; i++) {
    unsigned char c = (unsigned char)s[i];
    if (c == '"' || c == '\\') {
      printf("\\%c", c);
    } else if (c < 0x20 || c >= 0x7f) {
      printf("\\u%04x", c);
    } else {
      putchar(c);
    }
  }
  putchar('"');
}

static int run_event(int index, const char *payload, size_t length, char **argv) {
  int in[2], out[2], err[2];
  if (pipe(in) || pipe(out) || pipe(err)) return -1;
  posix_spawn_file_actions_t actions;
  posix_spawn_file_actions_init(&actions);
  posix_spawn_file_actions_adddup2(&actions, in[0], 0);
  posix_spawn_file_actions_adddup2(&actions, out[1], 1);
  posix_spawn_file_actions_adddup2(&actions, err[1], 2);
  int fds[] = {in[0], in[1], out[0], out[1], err[0], err[1]};
  for (int i = 0; i < 6; i++) posix_spawn_file_actions_addclose(&actions, fds[i]);
  posix_spawnattr_t attr;
  posix_spawnattr_init(&attr);
  posix_spawnattr_setflags(&attr, POSIX_SPAWN_START_SUSPENDED | POSIX_SPAWN_CLOEXEC_DEFAULT);

  int kq = kqueue();
  tree_count = 0;
  exec_count = 0;
  pid_t pid;
  uint64_t t0 = now_ns();
  int rc = posix_spawn(&pid, argv[0], &actions, &attr, argv, environ);
  posix_spawn_file_actions_destroy(&actions);
  posix_spawnattr_destroy(&attr);
  close(in[0]);
  close(out[1]);
  close(err[1]);
  if (rc != 0) {
    fprintf(stderr, "hookrun: spawn %s: %s\n", argv[0], strerror(rc));
    return -1;
  }
  watch(kq, pid);
  // The payload fits the pipe buffer (64 KiB): write it before the command runs, as one write.
  if (length > 0 && write(in[1], payload, length) != (ssize_t)length) {
    fprintf(stderr, "hookrun: short payload write for event %d\n", index);
  }
  close(in[1]);
  kill(pid, SIGCONT);

  struct kevent ev[2];
  EV_SET(&ev[0], (uintptr_t)out[0], EVFILT_READ, EV_ADD, 0, 0, NULL);
  EV_SET(&ev[1], (uintptr_t)err[0], EVFILT_READ, EV_ADD, 0, 0, NULL);
  kevent(kq, ev, 2, NULL, 0, NULL);
  char stdout_head[64];
  size_t stdout_len = 0;
  int open_pipes = 2, top_exited = 0, timed_out = 0;
  uint64_t t_exit = 0, t_eof = 0, cpu = 0, own = 0, instructions = 0;
  // Claude's hook timeout is 10 s; past 15 s the run is broken, not slow.
  uint64_t deadline = t0 + 15000000000ull;
  while (!top_exited || open_pipes > 0) {
    struct kevent got[16];
    struct timespec tick = {0, 100000000};
    int n = kevent(kq, NULL, 0, got, 16, &tick);
    if (n < 0 && errno == EINTR) continue;
    if (n < 0) break;
    if (now_ns() > deadline && !timed_out) {
      fprintf(stderr, "hookrun: event %d still running after 15 s: killing its top process %d\n", index, pid);
      kill(pid, SIGKILL);
      timed_out = 1;
    }
    for (int i = 0; i < n; i++) {
      if (got[i].filter == EVFILT_READ) {
        char buf[4096];
        ssize_t r = read((int)got[i].ident, buf, sizeof(buf));
        if (r > 0 && (int)got[i].ident == out[0]) {
          size_t take = (size_t)r < sizeof(stdout_head) - stdout_len ? (size_t)r : sizeof(stdout_head) - stdout_len;
          memcpy(stdout_head + stdout_len, buf, take);
          stdout_len += take;
        }
        if (r <= 0) {
          EV_SET(&ev[0], got[i].ident, EVFILT_READ, EV_DELETE, 0, 0, NULL);
          kevent(kq, ev, 1, NULL, 0, NULL);
          if (--open_pipes == 0) t_eof = now_ns();
        }
        continue;
      }
      pid_t who = (pid_t)got[i].ident;
      if (got[i].fflags & NOTE_FORK) adopt_children(kq, who);
      if (got[i].fflags & NOTE_EXEC) exec_count++;
      if ((got[i].fflags & NOTE_EXIT) && who == pid && !top_exited) {
        t_exit = now_ns();
        top_exited = 1;
        zombie_cpu(pid, &cpu, &own, &instructions);
      }
    }
  }
  int status = 0;
  struct rusage ru;
  wait4(pid, &status, 0, &ru);
  // Anything of the tree still alive outlived the hook: wait for it (up to 2 s) and add its CPU.
  int outlived = 0, outlived_exits = 0;
  uint64_t outlived_cpu = 0;
  for (int i = 1; i < tree_count; i++) {
    if (kill(tree[i], 0) == 0) outlived++;
  }
  uint64_t linger = now_ns() + 2000000000ull;
  while (outlived_exits < outlived && now_ns() < linger) {
    struct kevent got;
    struct timespec tick = {0, 50000000};
    if (kevent(kq, NULL, 0, &got, 1, &tick) == 1 && got.filter == EVFILT_PROC && (got.fflags & NOTE_EXIT)) {
      uint64_t total, mine, ins;
      if (zombie_cpu((pid_t)got.ident, &total, &mine, &ins) == 0) outlived_cpu += mine;
      outlived_exits++;
    }
  }
  close(out[0]);
  close(err[0]);
  close(kq);
  uint64_t t_close = t_exit > t_eof ? t_exit : t_eof;
  printf("{\"i\":%d,\"pid\":%d,\"bytes\":%zu,\"wallUs\":%.1f,\"exitUs\":%.1f,\"eofUs\":%.1f,"
         "\"cpuNs\":%llu,\"ownCpuNs\":%llu,\"instructions\":%llu,\"waitCpuUs\":%lld,\"processes\":%d,"
         "\"execs\":%d,\"outlived\":%d,\"outlivedCpuNs\":%llu,\"status\":%d,\"timedOut\":%d,\"stdout\":",
         index, pid, length, (double)(t_close - t0) / 1e3, (double)(t_exit - t0) / 1e3,
         (double)(t_eof - t0) / 1e3, (unsigned long long)cpu, (unsigned long long)own,
         (unsigned long long)instructions,
         (long long)(ru.ru_utime.tv_sec + ru.ru_stime.tv_sec) * 1000000 + ru.ru_utime.tv_usec + ru.ru_stime.tv_usec,
         tree_count, exec_count, outlived, (unsigned long long)outlived_cpu, status, timed_out);
  json_bytes(stdout_head, stdout_len);
  printf("}\n");
  fflush(stdout);
  return 0;
}

int main(int argc, char **argv) {
  int sep = 0;
  for (int i = 1; i < argc; i++) {
    if (!strcmp(argv[i], "--")) {
      sep = i;
      break;
    }
  }
  if (sep != 3 || sep + 1 >= argc) {
    fprintf(stderr, "usage: hookrun <payloads.jsonl> <gap-ms> -- <argv>...\n");
    return 2;
  }
  mach_timebase_info(&timebase);
  FILE *f = fopen(argv[1], "r");
  if (!f) {
    perror(argv[1]);
    return 2;
  }
  useconds_t gap = (useconds_t)atoi(argv[2]) * 1000;
  char *line = NULL;
  size_t cap = 0;
  ssize_t len;
  int index = 0;
  while ((len = getline(&line, &cap, f)) > 0) {
    if (line[len - 1] == '\n') len--;
    if (run_event(index++, line, (size_t)len, argv + sep + 1) != 0) return 1;
    usleep(gap);
  }
  free(line);
  fclose(f);
  return 0;
}
