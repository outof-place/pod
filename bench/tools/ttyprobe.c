// ttyprobe: the two process reads behind Orca's per-pane foreground poll, done Orca's way (fork
// /bin/ps) and the sysctl way, timed per call. Prints one JSON object on stdout.
//
//   ttyprobe --pid PID --mode ps-tty|ps-rows|sysctl-tty|sysctl-rows [--iterations N]
//
// ps-tty      `ps -o tty= -p PID`                                   (terminalOf, uncached)
// ps-rows     `ps -o pid=,ppid=,pgid=,tpgid=,stat=,command= -t TTY` (readTerminalProcessRows)
// sysctl-tty  KERN_PROC_PID -> e_tdev -> devname
// sysctl-rows KERN_PROC_TTY plus KERN_PROCARGS2 per process (the same columns as ps-rows)
#include <errno.h>
#include <fcntl.h>
#include <spawn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/sysctl.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

extern char **environ;

static uint64_t now_ns(void) { return clock_gettime_nsec_np(CLOCK_UPTIME_RAW); }

// Runs argv, returns stdout length (and the text in out), -1 on failure.
static long run_capture(char *const argv[], char *out, size_t cap) {
  int fds[2];
  if (pipe(fds) != 0) return -1;
  posix_spawn_file_actions_t fa;
  posix_spawn_file_actions_init(&fa);
  posix_spawn_file_actions_adddup2(&fa, fds[1], 1);
  posix_spawn_file_actions_addclose(&fa, fds[0]);
  posix_spawn_file_actions_addclose(&fa, fds[1]);
  pid_t child;
  int rc = posix_spawn(&child, argv[0], &fa, NULL, argv, environ);
  posix_spawn_file_actions_destroy(&fa);
  close(fds[1]);
  if (rc != 0) {
    close(fds[0]);
    return -1;
  }
  size_t used = 0;
  for (;;) {
    ssize_t r = read(fds[0], out + used, cap - used - 1);
    if (r < 0 && errno == EINTR) continue;
    if (r <= 0) break;
    used += (size_t)r;
    if (used + 1 >= cap) break;
  }
  out[used] = 0;
  close(fds[0]);
  int status;
  while (waitpid(child, &status, 0) < 0 && errno == EINTR) {
  }
  return WIFEXITED(status) && WEXITSTATUS(status) == 0 ? (long)used : -1;
}

static int proc_of(pid_t pid, struct kinfo_proc *kp) {
  int mib[4] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, pid};
  size_t size = sizeof(*kp);
  return sysctl(mib, 4, kp, &size, NULL, 0) == 0 && size == sizeof(*kp) ? 0 : -1;
}

static int sysctl_tty(pid_t pid, char *out, size_t cap) {
  struct kinfo_proc kp;
  if (proc_of(pid, &kp) != 0 || kp.kp_eproc.e_tdev == NODEV) return -1;
  const char *name = devname(kp.kp_eproc.e_tdev, S_IFCHR);
  if (!name) return -1;
  snprintf(out, cap, "%s", name);
  return 0;
}

static int read_command(pid_t pid, char *out, size_t cap) {
  static char buf[1 << 18];
  int mib[3] = {CTL_KERN, KERN_PROCARGS2, pid};
  size_t size = sizeof(buf);
  out[0] = 0;
  if (sysctl(mib, 3, buf, &size, NULL, 0) != 0 || size < sizeof(int)) return -1;
  int argc;
  memcpy(&argc, buf, sizeof(int));
  char *p = buf + sizeof(int), *end = buf + size;
  while (p < end && *p) p++;
  while (p < end && !*p) p++;
  size_t used = 0;
  for (int i = 0; i < argc && p < end; i++) {
    size_t len = strnlen(p, (size_t)(end - p));
    if (used + len + 2 >= cap) break;
    if (used) out[used++] = ' ';
    memcpy(out + used, p, len);
    used += len;
    p += len + 1;
  }
  out[used] = 0;
  return 0;
}

// Rows for every process on the terminal; returns the row count, -1 on failure.
static int sysctl_rows(dev_t tdev, char *out, size_t cap) {
  int mib[4] = {CTL_KERN, KERN_PROC, KERN_PROC_TTY, (int)tdev};
  static struct kinfo_proc procs[512];
  size_t size = sizeof(procs);
  if (sysctl(mib, 4, procs, &size, NULL, 0) != 0) return -1;
  int n = (int)(size / sizeof(struct kinfo_proc));
  size_t used = 0;
  static char command[1 << 16];
  for (int i = 0; i < n; i++) {
    struct kinfo_proc *kp = &procs[i];
    read_command(kp->kp_proc.p_pid, command, sizeof(command));
    int w = snprintf(out + used, cap - used, "%d %d %d %d %d %s\n", kp->kp_proc.p_pid,
                     kp->kp_eproc.e_ppid, kp->kp_eproc.e_pgid, kp->kp_eproc.e_tpgid,
                     kp->kp_proc.p_stat, command[0] ? command : kp->kp_proc.p_comm);
    if (w < 0 || (size_t)w >= cap - used) break;
    used += (size_t)w;
  }
  return n;
}

static int count_lines(const char *s) {
  int n = 0;
  for (; *s; s++) n += *s == '\n';
  return n;
}

int main(int argc, char **argv) {
  pid_t pid = 0;
  const char *mode = NULL;
  int iterations = 50;
  for (int i = 1; i + 1 < argc; i += 2) {
    if (!strcmp(argv[i], "--pid")) pid = (pid_t)atoi(argv[i + 1]);
    else if (!strcmp(argv[i], "--mode")) mode = argv[i + 1];
    else if (!strcmp(argv[i], "--iterations")) iterations = atoi(argv[i + 1]);
  }
  if (!pid || !mode || iterations < 1) {
    fprintf(stderr, "usage: ttyprobe --pid PID --mode ps-tty|ps-rows|sysctl-tty|sysctl-rows [--iterations N]\n");
    return 2;
  }
  char tty[64];
  if (sysctl_tty(pid, tty, sizeof(tty)) != 0) {
    fprintf(stderr, "pid %d has no controlling terminal\n", pid);
    return 1;
  }
  struct kinfo_proc kp;
  proc_of(pid, &kp);
  char pidarg[16], ttyarg[80];
  snprintf(pidarg, sizeof(pidarg), "%d", pid);
  snprintf(ttyarg, sizeof(ttyarg), "%s", tty);
  static char out[1 << 20];
  double *us = calloc((size_t)iterations, sizeof(double));
  int rows = -1;
  for (int i = 0; i < iterations; i++) {
    uint64_t t0 = now_ns();
    long ok = -1;
    if (!strcmp(mode, "ps-tty")) {
      char *a[] = {"/bin/ps", "-o", "tty=", "-p", pidarg, NULL};
      ok = run_capture(a, out, sizeof(out));
    } else if (!strcmp(mode, "ps-rows")) {
      char *a[] = {"/bin/ps", "-o", "pid=,ppid=,pgid=,tpgid=,stat=,command=", "-t", ttyarg, NULL};
      ok = run_capture(a, out, sizeof(out));
      if (ok >= 0) rows = count_lines(out);
    } else if (!strcmp(mode, "sysctl-tty")) {
      ok = sysctl_tty(pid, out, sizeof(out));
    } else if (!strcmp(mode, "sysctl-rows")) {
      ok = rows = sysctl_rows(kp.kp_eproc.e_tdev, out, sizeof(out));
    } else {
      fprintf(stderr, "unknown mode %s\n", mode);
      return 2;
    }
    us[i] = (double)(now_ns() - t0) / 1e3;
    if (ok < 0) {
      fprintf(stderr, "%s failed on iteration %d\n", mode, i);
      return 1;
    }
  }
  printf("{\"mode\":\"%s\",\"pid\":%d,\"tty\":\"%s\",\"rows\":%d,\"us\":[", mode, pid, tty, rows);
  for (int i = 0; i < iterations; i++) printf("%s%.3f", i ? "," : "", us[i]);
  printf("]}\n");
  return 0;
}
