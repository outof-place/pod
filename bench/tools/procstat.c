// procstat: CPU time and memory of one app's process set, as one JSON object on stdout.
//
//   procstat [--root PID]... [--argv STR]...
//
// Selects every --root pid, every process whose argv contains an --argv string, and all their
// descendants. Per process: cumulative user+system CPU (ns), resident size and phys_footprint
// (the "Memory" column of Activity Monitor), from proc_pid_rusage, and the first 512 bytes of argv. Also the host's cumulative
// busy and idle CPU time, so a caller can tell how busy the rest of the machine was.
#include <libproc.h>
#include <mach/mach.h>
#include <mach/mach_time.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc_info.h>
#include <sys/resource.h>
#include <sys/sysctl.h>
#include <time.h>
#include <unistd.h>

static void json_string(const char *s) {
  putchar('"');
  for (; *s; s++) {
    unsigned char c = (unsigned char)*s;
    if (c == '"' || c == '\\') {
      printf("\\%c", c);
    } else if (c < 0x20) {
      printf("\\u%04x", c);
    } else {
      putchar(c);
    }
  }
  putchar('"');
}

// argv of a process joined by spaces; empty when the kernel refuses (another user's process).
static int read_argv(pid_t pid, char *out, size_t cap) {
  int mib[3] = {CTL_KERN, KERN_PROCARGS2, pid};
  static char buf[1 << 18];
  size_t size = sizeof(buf);
  out[0] = 0;
  if (sysctl(mib, 3, buf, &size, NULL, 0) != 0 || size < sizeof(int)) return -1;
  int argc;
  memcpy(&argc, buf, sizeof(int));
  char *p = buf + sizeof(int), *end = buf + size;
  while (p < end && *p) p++;  // exec path
  while (p < end && !*p) p++;  // padding
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

int main(int argc, char **argv) {
  pid_t roots[64];
  const char *needles[16];
  int nroots = 0, nneedles = 0;
  for (int i = 1; i < argc; i++) {
    if (!strcmp(argv[i], "--root") && i + 1 < argc && nroots < 64) {
      roots[nroots++] = (pid_t)atoi(argv[++i]);
    } else if (!strcmp(argv[i], "--argv") && i + 1 < argc && nneedles < 16) {
      needles[nneedles++] = argv[++i];
    } else {
      fprintf(stderr, "usage: procstat [--root PID]... [--argv STR]...\n");
      return 2;
    }
  }

  int mib[4] = {CTL_KERN, KERN_PROC, KERN_PROC_ALL, 0};
  size_t size = 0;
  if (sysctl(mib, 3, NULL, &size, NULL, 0) != 0) return 1;
  size += size / 4;
  struct kinfo_proc *procs = malloc(size);
  if (!procs || sysctl(mib, 3, procs, &size, NULL, 0) != 0) return 1;
  int n = (int)(size / sizeof(struct kinfo_proc));
  char *selected = calloc((size_t)n, 1);
  static char args[1 << 16];

  for (int i = 0; i < n; i++) {
    pid_t pid = procs[i].kp_proc.p_pid;
    for (int r = 0; r < nroots; r++) {
      if (pid == roots[r]) selected[i] = 1;
    }
    if (!selected[i] && nneedles > 0 && read_argv(pid, args, sizeof(args)) == 0) {
      for (int k = 0; k < nneedles; k++) {
        if (strstr(args, needles[k])) selected[i] = 1;
      }
    }
  }
  // Descendants: repeat until no new process joins.
  for (int changed = 1; changed;) {
    changed = 0;
    for (int i = 0; i < n; i++) {
      if (selected[i]) continue;
      pid_t ppid = procs[i].kp_eproc.e_ppid;
      for (int j = 0; j < n; j++) {
        if (selected[j] && procs[j].kp_proc.p_pid == ppid) {
          selected[i] = 1;
          changed = 1;
          break;
        }
      }
    }
  }

  mach_timebase_info_data_t tb;
  mach_timebase_info(&tb);
  struct timespec now;
  clock_gettime(CLOCK_REALTIME, &now);
  printf("{\"atMs\":%.3f,\"procs\":[", (double)now.tv_sec * 1e3 + (double)now.tv_nsec / 1e6);
  uint64_t total_cpu = 0, total_rss = 0, total_fp = 0;
  int first = 1;
  for (int i = 0; i < n; i++) {
    if (!selected[i]) continue;
    pid_t pid = procs[i].kp_proc.p_pid;
    struct rusage_info_v4 ri;
    if (proc_pid_rusage(pid, RUSAGE_INFO_V4, (rusage_info_t *)&ri) != 0) continue;
    // Apple silicon reports these in Mach ticks, not nanoseconds.
    uint64_t cpu = (ri.ri_user_time + ri.ri_system_time) * tb.numer / tb.denom;
    char path[PROC_PIDPATHINFO_MAXSIZE] = "";
    proc_pidpath(pid, path, sizeof(path));
    read_argv(pid, args, 512);
    printf("%s{\"pid\":%d,\"ppid\":%d,\"name\":", first ? "" : ",", pid, procs[i].kp_eproc.e_ppid);
    json_string(procs[i].kp_proc.p_comm);
    printf(",\"path\":");
    json_string(path);
    printf(",\"args\":");
    json_string(args);
    printf(",\"cpuNs\":%llu,\"rss\":%llu,\"footprint\":%llu}", (unsigned long long)cpu,
           (unsigned long long)ri.ri_resident_size, (unsigned long long)ri.ri_phys_footprint);
    total_cpu += cpu;
    total_rss += ri.ri_resident_size;
    total_fp += ri.ri_phys_footprint;
    first = 0;
  }
  host_cpu_load_info_data_t load;
  mach_msg_type_number_t count = HOST_CPU_LOAD_INFO_COUNT;
  unsigned long long busy = 0, idle = 0;
  if (host_statistics(mach_host_self(), HOST_CPU_LOAD_INFO, (host_info_t)&load, &count) == KERN_SUCCESS) {
    busy = (unsigned long long)load.cpu_ticks[CPU_STATE_USER] + load.cpu_ticks[CPU_STATE_SYSTEM] +
           load.cpu_ticks[CPU_STATE_NICE];
    idle = load.cpu_ticks[CPU_STATE_IDLE];
  }
  long hz = sysconf(_SC_CLK_TCK);
  printf("],\"cpuNs\":%llu,\"rss\":%llu,\"footprint\":%llu,\"hostBusyNs\":%llu,\"hostIdleNs\":%llu}\n",
         (unsigned long long)total_cpu, (unsigned long long)total_rss, (unsigned long long)total_fp,
         busy * 1000000000ull / (unsigned long long)hz, idle * 1000000000ull / (unsigned long long)hz);
  return 0;
}
