// In-process macOS process table reads for Orca: the columns Orca used to fork `ps` and `lsof`
// for, read straight from the kernel with sysctl(2) and proc_pidinfo(2).
//
// Field formats deliberately match `ps` so rows from either source compare equal:
//   stat      the run-state letter plus the job-control flags ps prints (s, +, <, N, X, E, V)
//   tty       devname(3) of the controlling terminal ("ttys003"), or "??" without one
//   startTime strftime "%c" in the environment's locale, as `ps -o lstart=`
//   command   argv joined with spaces, as `ps -o command=`
#define NAPI_VERSION 8
#include <node_api.h>

#include <errno.h>
#include <libproc.h>
#include <locale.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc.h>
#include <sys/stat.h>
#include <sys/sysctl.h>
#include <time.h>
#include <xlocale.h>

#define CHECK(call)                                                                                \
  do {                                                                                             \
    if ((call) != napi_ok) {                                                                       \
      return NULL;                                                                                 \
    }                                                                                              \
  } while (0)

static locale_t environment_locale(void) {
  static locale_t cached = NULL;
  if (cached == NULL) {
    // Why "": ps calls setlocale(LC_ALL, ""), so lstart follows LANG/LC_ALL/LC_TIME.
    cached = newlocale(LC_ALL_MASK, "", NULL);
    if (cached == NULL) {
      cached = newlocale(LC_ALL_MASK, "C", NULL);
    }
  }
  return cached;
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

// Why cached: devname(3) scans /dev on every call (~0.5 ms), which is what makes `ps -o tty=`
// slow. A device number names the same terminal for as long as the node exists.
#define TTY_NAME_CACHE_SIZE 512
static struct {
  dev_t dev;
  char name[32];
} tty_name_cache[TTY_NAME_CACHE_SIZE];
static size_t tty_name_cache_length = 0;

static void format_tty(const struct kinfo_proc *proc, char *out, size_t size) {
  dev_t dev = proc->kp_eproc.e_tdev;
  if (dev == NODEV) {
    strlcpy(out, "??", size);
    return;
  }
  for (size_t i = 0; i < tty_name_cache_length; i++) {
    if (tty_name_cache[i].dev == dev) {
      strlcpy(out, tty_name_cache[i].name, size);
      return;
    }
  }
  const char *name = devname(dev, S_IFCHR);
  strlcpy(out, name != NULL ? name : "??", size);
  if (name != NULL) {
    size_t slot = tty_name_cache_length < TTY_NAME_CACHE_SIZE
                      ? tty_name_cache_length++
                      : (size_t)dev % TTY_NAME_CACHE_SIZE;
    tty_name_cache[slot].dev = dev;
    strlcpy(tty_name_cache[slot].name, name, sizeof(tty_name_cache[slot].name));
  }
}

static void format_start(const struct kinfo_proc *proc, char *out, size_t size) {
  time_t started = proc->kp_proc.p_starttime.tv_sec;
  struct tm local;
  out[0] = '\0';
  if (localtime_r(&started, &local) != NULL) {
    strftime_l(out, size, "%c", &local, environment_locale());
  }
}

// One KERN_ARGMAX-sized scratch buffer per listing: reading argv is the costly part of a row.
typedef struct {
  char *data;
  size_t capacity;
  char *text;
  size_t text_capacity;
} args_buffer;

static int args_buffer_init(args_buffer *buffer) {
  int mib[2] = {CTL_KERN, KERN_ARGMAX};
  int argmax = 0;
  size_t size = sizeof(argmax);
  if (sysctl(mib, 2, &argmax, &size, NULL, 0) != 0 || argmax <= 0) {
    return 0;
  }
  buffer->capacity = (size_t)argmax;
  buffer->data = malloc(buffer->capacity);
  buffer->text = NULL;
  buffer->text_capacity = 0;
  return buffer->data != NULL;
}

static void args_buffer_free(args_buffer *buffer) {
  free(buffer->data);
  free(buffer->text);
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
  for (int index = 0; index < argc && cursor < end; index++) {
    size_t arg_length = strnlen(cursor, (size_t)(end - cursor));
    last_end = cursor + arg_length;
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
  // Why \ooo for control bytes only: that is what ps prints under a UTF-8 locale. Under the C
  // locale ps also mangles every non-ASCII byte into vis(3) meta notation; raw UTF-8 is the argv.
  size_t written = 0;
  for (const unsigned char *byte = (const unsigned char *)first; byte < (const unsigned char *)last_end;
       byte++) {
    if (*byte < 0x20 || *byte == 0x7f) {
      written += (size_t)snprintf(buffer->text + written, 5, "\\%03o", *byte);
    } else {
      buffer->text[written++] = (char)*byte;
    }
  }
  *command = buffer->text;
  *length = written;
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

static napi_value make_row(napi_env env, const struct kinfo_proc *proc, args_buffer *args) {
  napi_value row;
  char stat[16];
  char tty[64];
  char start[128];
  CHECK(napi_create_object(env, &row));
  CHECK(set_int(env, row, "pid", proc->kp_proc.p_pid));
  CHECK(set_int(env, row, "ppid", proc->kp_eproc.e_ppid));
  CHECK(set_int(env, row, "pgid", proc->kp_eproc.e_pgid));
  CHECK(set_int(env, row, "tpgid", proc->kp_eproc.e_tpgid));
  format_stat(proc, stat);
  format_tty(proc, tty, sizeof(tty));
  format_start(proc, start, sizeof(start));
  CHECK(napi_set_named_property(env, row, "stat", make_string(env, stat)));
  CHECK(napi_set_named_property(env, row, "tty", make_string(env, tty)));
  CHECK(napi_set_named_property(env, row, "startTime", make_string(env, start)));
  if (args == NULL) {
    return row;
  }
  // Why: the kernel's short name still identifies a process whose argv another user owns.
  CHECK(napi_set_named_property(env, row, "name", make_string(env, proc->kp_proc.p_comm)));
  napi_value command;
  const char *text = NULL;
  size_t length = 0;
  if (proc->kp_proc.p_stat == SZOMB) {
    // Why: ps prints exactly this for a zombie, whose argv is gone.
    CHECK(napi_create_string_utf8(env, "<defunct>", NAPI_AUTO_LENGTH, &command));
  } else if (read_command(proc->kp_proc.p_pid, args, &text, &length)) {
    CHECK(napi_create_string_utf8(env, text, length, &command));
  } else {
    CHECK(napi_get_null(env, &command));
    // Why: unlike argv and PROC_PIDTBSDINFO, the executable path stays readable for root-owned
    // processes (login, sudo), which is all a verdict needs when the program ignores its argv.
    char path[PROC_PIDPATHINFO_MAXSIZE];
    if (proc_pidpath(proc->kp_proc.p_pid, path, sizeof(path)) > 0) {
      CHECK(napi_set_named_property(env, row, "path", make_string(env, path)));
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
                                  int with_command) {
  napi_value rows;
  args_buffer args = {NULL, 0, NULL, 0};
  // Why not presized: rows for pid 0 are skipped, which would leave holes at the end.
  if ((with_command && !args_buffer_init(&args)) || napi_create_array(env, &rows) != napi_ok) {
    args_buffer_free(&args);
    free(procs);
    return NULL;
  }
  uint32_t index = 0;
  for (size_t i = 0; i < count; i++) {
    if (procs[i].kp_proc.p_pid <= 0) {
      continue;
    }
    napi_value row = make_row(env, &procs[i], with_command ? &args : NULL);
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
  return rows_from_kinfo(env, procs, count, 0);
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
  return rows_from_kinfo(env, procs, count, 1);
}

static int read_pid_argument(napi_env env, napi_callback_info info, int32_t *pid) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 1 ||
      napi_get_value_int32(env, argv[0], pid) != napi_ok || *pid <= 0) {
    napi_throw_type_error(env, "ORCA_PROC_INFO_ARGUMENT", "expected a positive pid");
    return 0;
  }
  return 1;
}

// readProcess(pid): one row, or null when the pid does not exist.
static napi_value ReadProcess(napi_env env, napi_callback_info info) {
  int32_t pid = 0;
  if (!read_pid_argument(env, info, &pid)) {
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
  return make_row(env, &proc, NULL);
}

// listTerminalProcesses(ttyName): the processes holding one terminal, with argv, as `ps -t`.
static napi_value ListTerminalProcesses(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  char name[128];
  size_t name_length = 0;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 1 ||
      napi_get_value_string_utf8(env, argv[0], name, sizeof(name), &name_length) != napi_ok ||
      name_length == 0) {
    napi_throw_type_error(env, "ORCA_PROC_INFO_ARGUMENT", "expected a terminal name");
    return NULL;
  }
  char path[160];
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
  return rows_from_kinfo(env, procs, count, 1);
}

// readProcessCwd(pid): the working directory, or null when the kernel will not say.
static napi_value ReadProcessCwd(napi_env env, napi_callback_info info) {
  int32_t pid = 0;
  if (!read_pid_argument(env, info, &pid)) {
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
