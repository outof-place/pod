// macOS process metadata from sysctl and proc_pidinfo, using ps-compatible formats.
#define NAPI_VERSION 8
#include <node_api.h>
#include "proc_tty_names.h"
#include "proc_api_arguments.h"

#include <errno.h>
#include <dirent.h>
#include <libproc.h>
#include <locale.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/param.h>
#include <sys/proc.h>
#include <sys/stat.h>
#include <sys/sysctl.h>
#include <time.h>
#include <vis.h>
#include <xlocale.h>

#define PROCESS_CAPTURE_MAX_BYTES ((size_t)32 * 1024 * 1024)

#define CHECK(call)                                                                                \
  do {                                                                                             \
    if ((call) != napi_ok) {                                                                       \
      return NULL;                                                                                 \
    }                                                                                              \
  } while (0)

// Why C: Orca's lstart parsers expect `Sat Oct 10 00:04:51 2026`, and the `ps` fallback is run
// under a pinned en_US.UTF-8 (#27004), whose `%c` is the same. The user's locale would reorder it.
static locale_t cached_start_time_locale = NULL;
static pthread_once_t start_time_locale_once = PTHREAD_ONCE_INIT;

static void initialize_start_time_locale(void) {
  cached_start_time_locale = newlocale(LC_ALL_MASK, "C", NULL);
}

static locale_t start_time_locale(void) {
  pthread_once(&start_time_locale_once, initialize_start_time_locale);
  return cached_start_time_locale;
}

static void format_stat(const struct kinfo_proc *proc, char *out) {
  const struct extern_proc *p = &proc->kp_proc;
  const struct eproc *e = &proc->kp_eproc;
  char *cp = out;
  switch (p->p_stat) {
    case SSTOP:
      *cp++ = 'T';
      break;
    case SZOMB:
      *cp++ = 'Z';
      break;
    case SSLEEP:
      *cp++ = 'S';
      break;
    default:
      // Why R for SRUN/SIDL: ps refines this letter from Mach thread states, which needs a task
      // port; Orca reads only the job-control flags below, which come from the same kernel fields.
      *cp++ = 'R';
      break;
  }
  if (p->p_nice < 0) {
    *cp++ = '<';
  } else if (p->p_nice > 0) {
    *cp++ = 'N';
  }
  if (p->p_flag & P_TRACED) {
    *cp++ = 'X';
  }
  if ((p->p_flag & P_WEXIT) && p->p_stat != SZOMB) {
    *cp++ = 'E';
  }
  if (p->p_flag & P_PPWAIT) {
    *cp++ = 'V';
  }
  if (e->e_flag & EPROC_SLEADER) {
    *cp++ = 's';
  }
  if ((p->p_flag & P_CONTROLT) && e->e_pgid == e->e_tpgid) {
    *cp++ = '+';
  }
  *cp = '\0';
}

static void format_start(const struct kinfo_proc *proc, char *out, size_t size) {
  time_t started = proc->kp_proc.p_starttime.tv_sec;
  struct tm local;
  out[0] = '\0';
  if (localtime_r(&started, &local) != NULL) {
    strftime_l(out, size, "%c", &local, start_time_locale());
  }
}

// One KERN_ARGMAX-sized scratch buffer per listing: reading argv is the costly part of a row.
typedef struct {
  char *data;
  size_t capacity;
  char *text;
  size_t text_capacity;
  locale_t locale;
  size_t command_bytes;
} args_buffer;

static int args_buffer_init(args_buffer *buffer) {
  int mib[2] = {CTL_KERN, KERN_ARGMAX};
  int argmax = 0;
  size_t size = sizeof(argmax);
  if (sysctl(mib, 2, &argmax, &size, NULL, 0) != 0) {
    return 0;
  }
  if (argmax <= 0) {
    errno = EINVAL;
    return 0;
  }
  buffer->capacity = (size_t)argmax;
  buffer->data = malloc(buffer->capacity);
  buffer->text = NULL;
  buffer->text_capacity = 0;
  buffer->locale = newlocale(LC_CTYPE_MASK, "en_US.UTF-8", NULL);
  return buffer->data != NULL && buffer->locale != NULL;
}

static void args_buffer_free(args_buffer *buffer) {
  free(buffer->data);
  free(buffer->text);
  if (buffer->locale != NULL) {
    freelocale(buffer->locale);
  }
}

// argv joined with spaces in place; 0 when the kernel refuses (another user's process) or it exited.
static int read_command(pid_t pid, args_buffer *buffer, const char **command, size_t *length) {
  int mib[3] = {CTL_KERN, KERN_PROCARGS2, pid};
  size_t size = buffer->capacity;
  if (sysctl(mib, 3, buffer->data, &size, NULL, 0) != 0 || size < sizeof(int)) {
    return 0;
  }
  int argc = 0;
  memcpy(&argc, buffer->data, sizeof(argc));
  if (argc <= 0) {
    return 0;
  }
  char *cursor = buffer->data + sizeof(argc);
  char *end = buffer->data + size;
  // Skip the exec path and the NUL padding before argv[0].
  while (cursor < end && *cursor != '\0') {
    cursor++;
  }
  while (cursor < end && *cursor == '\0') {
    cursor++;
  }
  char *first = cursor;
  char *last_end = cursor;
  for (int index = 0; index < argc; index++) {
    size_t arg_length = cursor < end ? strnlen(cursor, (size_t)(end - cursor)) : 0;
    last_end = cursor + arg_length;
    if (last_end == end) {
      return 0;
    }
    cursor = last_end + 1;
    if (index + 1 < argc && cursor < end) {
      *last_end = ' ';
    }
  }
  // Why trim: Orca's ps parsers trim each line, and processes that retitle themselves pad argv.
  while (first < last_end && *first == ' ') {
    first++;
  }
  while (last_end > first && last_end[-1] == ' ') {
    last_end--;
  }
  size_t raw_length = (size_t)(last_end - first);
  if (raw_length == 0) {
    return 0;
  }
  size_t needed = raw_length * 4 + 1;
  if (needed > buffer->text_capacity) {
    char *grown = realloc(buffer->text, needed);
    if (grown == NULL) {
      return 0;
    }
    buffer->text = grown;
    buffer->text_capacity = needed;
  }
  // Match ps's vis flags and UTF-8 locale without changing another thread's locale.
  locale_t previous = uselocale(buffer->locale);
  if (previous == NULL) {
    return 0;
  }
  int written = strnvisx(buffer->text, buffer->text_capacity, first, raw_length,
                         VIS_TAB | VIS_NL | VIS_NOSLASH);
  uselocale(previous);
  if (written < 0) {
    return 0;
  }
  *command = buffer->text;
  *length = (size_t)written;
  return 1;
}

static napi_value make_string(napi_env env, const char *value) {
  napi_value result;
  if (value == NULL) {
    CHECK(napi_get_null(env, &result));
  } else {
    CHECK(napi_create_string_utf8(env, value, NAPI_AUTO_LENGTH, &result));
  }
  return result;
}

static napi_status set_int(napi_env env, napi_value object, const char *name, int32_t value) {
  napi_value number;
  napi_status status = napi_create_int32(env, value, &number);
  return status == napi_ok ? napi_set_named_property(env, object, name, number) : status;
}

static napi_value make_row(napi_env env, const struct kinfo_proc *proc, args_buffer *args,
                           const char *tty_override) {
  napi_value row;
  char stat[16];
  char tty[MAXNAMLEN];
  char start[128];
  CHECK(napi_create_object(env, &row));
  CHECK(set_int(env, row, "pid", proc->kp_proc.p_pid));
  CHECK(set_int(env, row, "ppid", proc->kp_eproc.e_ppid));
  CHECK(set_int(env, row, "pgid", proc->kp_eproc.e_pgid));
  CHECK(set_int(env, row, "tpgid", proc->kp_eproc.e_tpgid));
  format_stat(proc, stat);
  if (tty_override != NULL) {
    strlcpy(tty, tty_override, sizeof(tty));
  } else {
    format_process_tty_name(proc->kp_eproc.e_tdev, tty, sizeof(tty));
  }
  format_start(proc, start, sizeof(start));
  CHECK(napi_set_named_property(env, row, "stat", make_string(env, stat)));
  CHECK(napi_set_named_property(env, row, "tty", make_string(env, tty)));
  CHECK(napi_set_named_property(env, row, "startTime", make_string(env, start)));
  if (args == NULL) {
    return row;
  }
  args->command_bytes = 0;
  // Why: the kernel's short name still identifies a process whose argv another user owns.
  CHECK(napi_set_named_property(env, row, "name", make_string(env, proc->kp_proc.p_comm)));
  napi_value command;
  const char *text = NULL;
  size_t length = 0;
  if (proc->kp_proc.p_stat == SZOMB) {
    // Why: ps prints exactly this for a zombie, whose argv is gone.
    CHECK(napi_create_string_utf8(env, "<defunct>", NAPI_AUTO_LENGTH, &command));
    args->command_bytes = strlen("<defunct>");
  } else if (read_command(proc->kp_proc.p_pid, args, &text, &length)) {
    CHECK(napi_create_string_utf8(env, text, length, &command));
    args->command_bytes = length;
  } else {
    CHECK(napi_get_null(env, &command));
    // Why: unlike argv and PROC_PIDTBSDINFO, the executable path stays readable for root-owned
    // processes (login, sudo), which is all a verdict needs when the program ignores its argv.
    char path[PROC_PIDPATHINFO_MAXSIZE];
    if (proc_pidpath(proc->kp_proc.p_pid, path, sizeof(path)) > 0) {
      CHECK(napi_set_named_property(env, row, "path", make_string(env, path)));
      args->command_bytes = strlen(path);
    }
  }
  CHECK(napi_set_named_property(env, row, "command", command));
  return row;
}

static napi_value throw_syscall_error(napi_env env, const char *operation) {
  char message[160];
  snprintf(message, sizeof(message), "%s: %s", operation, strerror(errno));
  napi_throw_error(env, "ORCA_PROC_INFO_SYSCALL", message);
  return NULL;
}

// sysctl KERN_PROC listings grow between the size probe and the read; retry with headroom.
static struct kinfo_proc *read_kinfo(int *mib, u_int mib_length, size_t *count) {
  for (int attempt = 0; attempt < 4; attempt++) {
    size_t size = 0;
    if (sysctl(mib, mib_length, NULL, &size, NULL, 0) != 0) {
      return NULL;
    }
    size += size / 4 + sizeof(struct kinfo_proc) * 16;
    struct kinfo_proc *procs = malloc(size);
    if (procs == NULL) {
      return NULL;
    }
    if (sysctl(mib, mib_length, procs, &size, NULL, 0) == 0) {
      *count = size / sizeof(struct kinfo_proc);
      return procs;
    }
    free(procs);
    if (errno != ENOMEM) {
      return NULL;
    }
  }
  return NULL;
}

static napi_value rows_from_kinfo(napi_env env, struct kinfo_proc *procs, size_t count,
                                  int with_command, const char *tty_override) {
  napi_value rows;
  args_buffer args = {0};
  if (with_command && !args_buffer_init(&args)) {
    int error = errno;
    args_buffer_free(&args);
    free(procs);
    errno = error;
    return throw_syscall_error(env, "initialize process arguments failed");
  }
  if (tty_override == NULL) {
    preload_process_tty_names(procs, count);
  }
  // Why not presized: rows for pid 0 are skipped, which would leave holes at the end.
  if (napi_create_array(env, &rows) != napi_ok) {
    args_buffer_free(&args);
    free(procs);
    return NULL;
  }
  uint32_t index = 0;
  size_t capture_bytes = 0;
  for (size_t i = 0; i < count; i++) {
    if (procs[i].kp_proc.p_pid <= 0) {
      continue;
    }
    napi_value row = make_row(env, &procs[i], with_command ? &args : NULL, tty_override);
    // Keep the ps capture's 32 MiB ceiling; 512 covers every fixed-width metadata field.
    size_t row_bytes = 512 + args.command_bytes;
    if (with_command && row_bytes > PROCESS_CAPTURE_MAX_BYTES - capture_bytes) {
      args_buffer_free(&args);
      free(procs);
      napi_throw_error(env, "ORCA_PROC_INFO_CAPTURE_LIMIT", "process capture exceeds 32 MiB");
      return NULL;
    }
    capture_bytes += row_bytes;
    if (row == NULL || napi_set_element(env, rows, index++, row) != napi_ok) {
      args_buffer_free(&args);
      free(procs);
      return NULL;
    }
  }
  args_buffer_free(&args);
  free(procs);
  return rows;
}

// listProcesses(): every process with the cheap-tier columns.
static napi_value ListProcesses(napi_env env, napi_callback_info info) {
  (void)info;
  int mib[4] = {CTL_KERN, KERN_PROC, KERN_PROC_ALL, 0};
  size_t count = 0;
  struct kinfo_proc *procs = read_kinfo(mib, 3, &count);
  if (procs == NULL) {
    return throw_syscall_error(env, "sysctl(KERN_PROC_ALL) failed");
  }
  return rows_from_kinfo(env, procs, count, 0, NULL);
}

// listProcessesWithCommands(): every process plus argv, as the full `ps` capture reads it.
static napi_value ListProcessesWithCommands(napi_env env, napi_callback_info info) {
  (void)info;
  int mib[4] = {CTL_KERN, KERN_PROC, KERN_PROC_ALL, 0};
  size_t count = 0;
  struct kinfo_proc *procs = read_kinfo(mib, 3, &count);
  if (procs == NULL) {
    return throw_syscall_error(env, "sysctl(KERN_PROC_ALL) failed");
  }
  return rows_from_kinfo(env, procs, count, 1, NULL);
}

// readProcess(pid): one row, or null when the pid does not exist.
// Resize targeting checks a known PTY only; unlike readProcess it never resolves another device's name.
static napi_value ReadProcessForegroundGroup(napi_env env, napi_callback_info info) {
  int32_t pid = 0;
  char tty[MAXNAMLEN];
  if (!read_process_pid_argument(env, info, &pid) ||
      read_process_tty_argument(env, info, 1, 0, tty, sizeof(tty)) == PROC_TTY_ARGUMENT_ERROR) {
    return NULL;
  }
  // Why: the name becomes a /dev path, so a separator or dot segment must not escape devfs.
  const char *name = strncmp(tty, "/dev/", 5) == 0 ? tty + 5 : tty;
  if (*name == '\0' || strchr(name, '/') != NULL || strchr(name, '\\') != NULL ||
      strcmp(name, ".") == 0 || strcmp(name, "..") == 0) {
    napi_throw_type_error(env, "ORCA_PROC_INFO_ARGUMENT", "expected a terminal name");
    return NULL;
  }
  memmove(tty, name, strlen(name) + 1);
  int mib[4] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, pid};
  struct kinfo_proc proc = {0};
  size_t size = sizeof(proc);
  if (sysctl(mib, 4, &proc, &size, NULL, 0) != 0) {
    return throw_syscall_error(env, "sysctl(KERN_PROC_PID) failed");
  }
  if (size == 0) {
    napi_value null_value;
    CHECK(napi_get_null(env, &null_value));
    return null_value;
  }
  if (size != sizeof(proc) || proc.kp_proc.p_pid != pid) {
    napi_throw_error(env, "ORCA_PROC_INFO_RESPONSE", "unexpected process metadata");
    return NULL;
  }
  char path[sizeof("/dev/") + sizeof(tty)];
  snprintf(path, sizeof(path), "/dev/%s", tty);
  struct stat device;
  // Only a direct devfs character device can identify a pane's known PTY.
  if (proc.kp_eproc.e_tdev == NODEV || lstat(path, &device) != 0 ||
      !S_ISCHR(device.st_mode) || device.st_rdev != proc.kp_eproc.e_tdev) {
    strlcpy(tty, "??", sizeof(tty));
  }
  napi_value row;
  CHECK(napi_create_object(env, &row));
  CHECK(set_int(env, row, "pid", proc.kp_proc.p_pid));
  CHECK(set_int(env, row, "tpgid", proc.kp_eproc.e_tpgid));
  CHECK(napi_set_named_property(env, row, "tty", make_string(env, tty)));
  return row;
}

static napi_value ReadProcess(napi_env env, napi_callback_info info) {
  int32_t pid = 0;
  if (!read_process_pid_argument(env, info, &pid)) {
    return NULL;
  }
  int mib[4] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, pid};
  struct kinfo_proc proc;
  size_t size = sizeof(proc);
  if (sysctl(mib, 4, &proc, &size, NULL, 0) != 0) {
    return throw_syscall_error(env, "sysctl(KERN_PROC_PID) failed");
  }
  if (size == 0) {
    napi_value null_value;
    CHECK(napi_get_null(env, &null_value));
    return null_value;
  }
  char tty[MAXNAMLEN];
  proc_tty_argument_status tty_argument =
      read_process_tty_argument(env, info, 1, 1, tty, sizeof(tty));
  if (tty_argument == PROC_TTY_ARGUMENT_ERROR) {
    return NULL;
  }
  if (tty_argument == PROC_TTY_ARGUMENT_PRESENT) {
    const char *name = strncmp(tty, "/dev/", 5) == 0 ? tty + 5 : tty;
    char path[sizeof("/dev/") + MAXNAMLEN];
    snprintf(path, sizeof(path), "/dev/%s", name);
    struct stat device;
    if (stat(path, &device) != 0 || !S_ISCHR(device.st_mode) ||
        device.st_rdev != proc.kp_eproc.e_tdev) {
      strlcpy(tty, "??", sizeof(tty));
    } else {
      memmove(tty, name, strlen(name) + 1);
    }
  } else if (!format_cached_process_tty_name(proc.kp_eproc.e_tdev, tty, sizeof(tty))) {
    napi_throw_error(env, "ORCA_PROC_INFO_TTY_UNKNOWN", "terminal name is not cached");
    return NULL;
  }
  return make_row(env, &proc, NULL, tty);
}

// listTerminalProcesses(ttyName): the processes holding one terminal, with argv, as `ps -t`.
static napi_value ListTerminalProcesses(napi_env env, napi_callback_info info) {
  char name[MAXNAMLEN];
  if (read_process_tty_argument(env, info, 0, 0, name, sizeof(name)) !=
      PROC_TTY_ARGUMENT_PRESENT) {
    return NULL;
  }
  char path[sizeof("/dev/") + MAXNAMLEN];
  snprintf(path, sizeof(path), "%s%s", strncmp(name, "/dev/", 5) == 0 ? "" : "/dev/", name);
  struct stat info_stat;
  if (stat(path, &info_stat) != 0 || !S_ISCHR(info_stat.st_mode)) {
    napi_value null_value;
    CHECK(napi_get_null(env, &null_value));
    return null_value;
  }
  int mib[4] = {CTL_KERN, KERN_PROC, KERN_PROC_TTY, (int)info_stat.st_rdev};
  size_t count = 0;
  struct kinfo_proc *procs = read_kinfo(mib, 4, &count);
  if (procs == NULL) {
    return throw_syscall_error(env, "sysctl(KERN_PROC_TTY) failed");
  }
  const char *tty_name = strncmp(name, "/dev/", 5) == 0 ? name + 5 : name;
  return rows_from_kinfo(env, procs, count, 1, tty_name);
}

// readProcessCwd(pid): the working directory, or null when the kernel will not say.
static napi_value ReadProcessCwd(napi_env env, napi_callback_info info) {
  int32_t pid = 0;
  if (!read_process_pid_argument(env, info, &pid)) {
    return NULL;
  }
  struct proc_vnodepathinfo vnode;
  int bytes = proc_pidinfo(pid, PROC_PIDVNODEPATHINFO, 0, &vnode, sizeof(vnode));
  if (bytes != (int)sizeof(vnode) || vnode.pvi_cdir.vip_path[0] == '\0') {
    return make_string(env, NULL);
  }
  return make_string(env, vnode.pvi_cdir.vip_path);
}

NAPI_MODULE_INIT(/* napi_env env, napi_value exports */) {
  napi_property_descriptor properties[] = {
      {"listProcesses", NULL, ListProcesses, NULL, NULL, NULL, napi_enumerable, NULL},
      {"listProcessesWithCommands", NULL, ListProcessesWithCommands, NULL, NULL, NULL,
       napi_enumerable, NULL},
      {"readProcess", NULL, ReadProcess, NULL, NULL, NULL, napi_enumerable, NULL},
      {"readProcessForegroundGroup", NULL, ReadProcessForegroundGroup, NULL, NULL, NULL,
       napi_enumerable, NULL},
      {"listTerminalProcesses", NULL, ListTerminalProcesses, NULL, NULL, NULL, napi_enumerable,
       NULL},
      {"readProcessCwd", NULL, ReadProcessCwd, NULL, NULL, NULL, napi_enumerable, NULL},
  };
  if (napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]),
                             properties) != napi_ok) {
    return NULL;
  }
  return exports;
}
