// pod-agent-launcher: starts an agent CLI from a Pod terminal with interactive scheduling, then
// replaces itself with that CLI (same pid, same argv, same environment).
//
// Installed in Contents/Resources/bin next to Pod's CLI launchers, plus one symlink per agent
// command (claude -> pod-agent-launcher). Pod's shell wrappers keep that directory first on PATH
// in every terminal (ORCA_CLI_BIN_DIR), so a typed `claude` reaches this binary, which looks the
// real command up on the rest of PATH.
//
//   claude [args...]                       via the symlink: run the next `claude` on PATH
//   pod-agent-launcher -- <cmd> [args...]  explicit form
//   pod-agent-launcher --print-policy      apply the policy and print what the kernel reports
//
// POD_AGENT_TURBO=0 skips the policy (the command still runs).
//
// Why a task role and not a QoS class: thread QoS does not survive exec, and
// posix_spawnattr_set_qos_class_np only accepts UTILITY or BACKGROUND (pthread/spawn.h). A task
// role does survive exec and is not inherited by children (mach/task_policy.h), so the agent's own
// event loop and threads run at app priority while the builds and tools it spawns stay at default.

import Darwin
import MachO

let launcherName = "pod-agent-launcher"
let turboEnv = "POD_AGENT_TURBO"
// "<pid>\n<path>\n<path>...": wrapper scripts already tried by this process (exec keeps the pid).
let skipEnv = "POD_AGENT_LAUNCHER_SKIP"
// Script hops across processes; a wrapper that reaches its own name through PATH loops otherwise.
let depthEnv = "POD_AGENT_LAUNCHER_DEPTH"
let maxScriptDepth = 8

func fail(_ message: String, code: Int32) -> Never {
  fputs("\(message)\n", stderr)
  exit(code)
}

func env(_ name: String) -> String? {
  guard let value = getenv(name) else { return nil }
  return String(cString: value)
}

func realPath(_ path: String) -> String? {
  guard let resolved = realpath(path, nil) else { return nil }
  defer { free(resolved) }
  return String(cString: resolved)
}

func executablePath() -> String? {
  var size: UInt32 = 0
  _ = _NSGetExecutablePath(nil, &size)
  var buffer = [CChar](repeating: 0, count: Int(size) + 1)
  guard _NSGetExecutablePath(&buffer, &size) == 0 else { return nil }
  return realPath(String(cString: buffer))
}

func isExecutableFile(_ path: String) -> Bool {
  var info = stat()
  guard stat(path, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG else { return false }
  return access(path, X_OK) == 0
}

func isScript(_ path: String) -> Bool {
  let fd = open(path, O_RDONLY | O_CLOEXEC)
  guard fd >= 0 else { return false }
  defer { close(fd) }
  var magic: [UInt8] = [0, 0]
  return read(fd, &magic, 2) == 2 && magic == [0x23, 0x21]
}

/// The first `name` on PATH that is not this launcher (any symlink to it) and not a wrapper
/// script this process already exec'd. Relative and empty PATH entries are skipped.
func resolveCommand(_ name: String, selfPath: String?, skip: Set<String>) -> String? {
  if name.contains("/") {
    return isExecutableFile(name) && realPath(name) != selfPath ? name : nil
  }
  for dir in (env("PATH") ?? "").split(separator: ":", omittingEmptySubsequences: true) {
    guard dir.hasPrefix("/") else { continue }
    let candidate = "\(dir)/\(name)"
    guard isExecutableFile(candidate), let resolved = realPath(candidate) else { continue }
    if resolved == selfPath || skip.contains(resolved) { continue }
    return candidate
  }
  return nil
}

func inheritedSkips() -> Set<String> {
  guard let value = env(skipEnv) else { return [] }
  let lines = value.split(separator: "\n").map(String.init)
  guard let pid = lines.first, pid == String(getpid()) else { return [] }
  return Set(lines.dropFirst())
}

func taskRole() -> task_role_t? {
  var policy = task_category_policy_data_t(role: TASK_UNSPECIFIED)
  var count = mach_msg_type_number_t(
    MemoryLayout<task_category_policy_data_t>.size / MemoryLayout<integer_t>.size)
  var getDefault: boolean_t = 0
  let result = withUnsafeMutablePointer(to: &policy) { pointer in
    pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
      task_policy_get(mach_task_self_, task_policy_flavor_t(TASK_CATEGORY_POLICY), $0, &count,
        &getDefault)
    }
  }
  return result == KERN_SUCCESS ? policy.role : nil
}

/// TASK_DEFAULT_APPLICATION: the role an unprivileged task may give itself that schedules its
/// threads like an app's (base priority 46 instead of 31) with tight timer leeway.
func applyAppRole() -> Bool {
  var policy = task_category_policy_data_t(role: TASK_DEFAULT_APPLICATION)
  let count = mach_msg_type_number_t(
    MemoryLayout<task_category_policy_data_t>.size / MemoryLayout<integer_t>.size)
  let result = withUnsafeMutablePointer(to: &policy) { pointer in
    pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
      task_policy_set(mach_task_self_, task_policy_flavor_t(TASK_CATEGORY_POLICY), $0, count)
    }
  }
  return result == KERN_SUCCESS
}

func sysctlInt(_ name: String) -> Int32? {
  var value: Int32 = 0
  var size = MemoryLayout<Int32>.size
  return sysctlbyname(name, &value, &size, nil, 0) == 0 ? value : nil
}

/// Soft limit up to the hard limit, capped by the kernel's per-process ceiling.
func raiseSoftLimit(_ resource: Int32, ceilingSysctl: String) {
  var limit = rlimit()
  guard getrlimit(resource, &limit) == 0 else { return }
  var target = limit.rlim_max
  if let ceiling = sysctlInt(ceilingSysctl), ceiling > 0 {
    target = min(target, rlim_t(ceiling))
  }
  guard limit.rlim_cur < target else { return }
  limit.rlim_cur = target
  _ = setrlimit(resource, &limit)
}

func applyPolicy() {
  guard env(turboEnv) != "0" else { return }
  _ = applyAppRole()
  raiseSoftLimit(RLIMIT_NOFILE, ceilingSysctl: "kern.maxfilesperproc")
  raiseSoftLimit(RLIMIT_NPROC, ceilingSysctl: "kern.maxprocperuid")
}

func printPolicy() {
  applyPolicy()
  var files = rlimit()
  var procs = rlimit()
  getrlimit(RLIMIT_NOFILE, &files)
  getrlimit(RLIMIT_NPROC, &procs)
  let role = taskRole().map { String($0.rawValue) } ?? "null"
  print(
    "{\"role\":\(role),\"nofile\":\(files.rlim_cur),\"nproc\":\(procs.rlim_cur),"
      + "\"turbo\":\(env(turboEnv) != "0")}")
}

let arguments = CommandLine.arguments
let invokedAs = String(arguments[0].split(separator: "/").last ?? "")
var commandIndex = 0
if invokedAs == launcherName {
  switch arguments.dropFirst().first {
  case "--print-policy":
    printPolicy()
    exit(0)
  case "--" where arguments.count > 2:
    commandIndex = 2
  default:
    fail("usage: \(launcherName) -- <command> [args...] | --print-policy", code: 64)
  }
}

// Why the basename: a shim reached by path (.../bin/claude) looks up `claude`, not itself.
let command = commandIndex == 0 ? invokedAs : arguments[commandIndex]
let depth = Int(env(depthEnv) ?? "") ?? 0
if depth >= maxScriptDepth {
  fail(
    "\(command): wrapper scripts keep calling \(command) through Pod's launcher; "
      + "run it with \(turboEnv)=0 or call the real binary by path", code: 126)
}
var skips = inheritedSkips()
guard let target = resolveCommand(command, selfPath: executablePath(), skip: skips) else {
  fail("\(command): command not found", code: 127)
}

if isScript(target) {
  // Why: a wrapper that execs the command again by name lands back here in the same pid.
  if let resolved = realPath(target) { skips.insert(resolved) }
  setenv(skipEnv, ([String(getpid())] + skips.sorted()).joined(separator: "\n"), 1)
  setenv(depthEnv, String(depth + 1), 1)
} else {
  unsetenv(skipEnv)
  unsetenv(depthEnv)
}

applyPolicy()
let argv = CommandLine.unsafeArgv + commandIndex
execv(target, argv)
fail("\(command): \(String(cString: strerror(errno)))", code: 126)
