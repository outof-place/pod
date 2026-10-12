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
// In a Pod pane, `claude` also gets Pod's agent-status hooks with the launch (`--settings`), so
// ~/.claude/settings.json holds none of Pod's: the runtime writes two templates, and the launcher
// fills the http one (the terminal daemon's relay, which answers at once) or, without a relay,
// passes the command one (Pod's hook client).
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

// Template prefix: <prefix>.http.json and <prefix>.command.json, from the runtime.
let settingsEnv = "POD_CLAUDE_LAUNCH_SETTINGS"
// The terminal daemon's relay file: POD_HOOK_RELAY_PORT, POD_HOOK_RELAY_TOKEN.
let relayEnv = "POD_AGENT_HOOK_RELAY"
// The pid that already got settings (a wrapper script runs claude again in the same pid).
let settingsPidEnv = "POD_CLAUDE_SETTINGS_PID"

func readText(_ path: String) -> String? {
  let fd = open(path, O_RDONLY | O_CLOEXEC)
  guard fd >= 0 else { return nil }
  defer { close(fd) }
  var bytes: [UInt8] = []
  var chunk = [UInt8](repeating: 0, count: 16_384)
  while true {
    let n = read(fd, &chunk, chunk.count)
    if n <= 0 { break }
    bytes.append(contentsOf: chunk[0..<n])
    if bytes.count > 1 << 20 { return nil }
  }
  return String(decoding: bytes, as: UTF8.self)
}

func keyValues(_ text: String) -> [String: String] {
  var values: [String: String] = [:]
  for line in text.split(separator: "\n") {
    guard let eq = line.firstIndex(of: "=") else { continue }
    values[String(line[..<eq])] = String(line[line.index(after: eq)...])
  }
  return values
}

func base64(_ bytes: [UInt8]) -> String {
  let table = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/")
  var out = ""
  var i = 0
  while i < bytes.count {
    let b0 = UInt32(bytes[i])
    let b1 = i + 1 < bytes.count ? UInt32(bytes[i + 1]) : 0
    let b2 = i + 2 < bytes.count ? UInt32(bytes[i + 2]) : 0
    let v = b0 << 16 | b1 << 8 | b2
    out.append(table[Int(v >> 18 & 63)])
    out.append(table[Int(v >> 12 & 63)])
    out.append(i + 1 < bytes.count ? table[Int(v >> 6 & 63)] : "=")
    out.append(i + 2 < bytes.count ? table[Int(v & 63)] : "=")
    i += 3
  }
  return out
}

func jsonEscaped(_ text: String) -> String {
  var out = ""
  for scalar in text.unicodeScalars {
    switch scalar {
    case "\\": out += "\\\\"
    case "\"": out += "\\\""
    default: out.unicodeScalars.append(scalar.value < 0x20 ? " " : scalar)
    }
  }
  return out
}

/// What Pod's hook client sends as X-Orca-Agent-Process: this pid is claude's after exec.
func agentProcess() -> String? {
  var info = kinfo_proc()
  var size = MemoryLayout<kinfo_proc>.size
  var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
  guard sysctl(&mib, 4, &info, &size, nil, 0) == 0, size > 0 else { return nil }
  var start = info.kp_proc.p_starttime.tv_sec
  var parts = tm()
  gmtime_r(&start, &parts)
  var when = [CChar](repeating: 0, count: 64)
  strftime(&when, when.count, "%a %b %e %H:%M:%S %Y", &parts)
  return "{\"pid\":\(getpid()),\"platform\":\"darwin\",\"startTime\":\"\(String(cString: when))\"}"
}

func writePrivate(_ path: String, _ text: String) -> Bool {
  let tmp = "\(path).\(getpid()).tmp"
  let fd = open(tmp, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0o600)
  guard fd >= 0 else { return false }
  let bytes = Array(text.utf8)
  let written = bytes.withUnsafeBytes { write(fd, $0.baseAddress, bytes.count) }
  close(fd)
  guard written == bytes.count, rename(tmp, path) == 0 else {
    unlink(tmp)
    return false
  }
  return true
}

/// Settings files of claudes that are gone.
func pruneLaunchFiles(_ dir: String) {
  guard let handle = opendir(dir) else { return }
  defer { closedir(handle) }
  while let entry = readdir(handle) {
    let name = withUnsafeBytes(of: entry.pointee.d_name) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) }
    guard name.hasPrefix("claude-"), name.hasSuffix(".json"),
      let pid = Int32(name.dropFirst(7).dropLast(5)), pid != getpid()
    else { continue }
    if kill(pid, 0) != 0 && errno == ESRCH { unlink("\(dir)/\(name)") }
  }
}

/// The settings file for this claude, or nil where Pod adds none.
func claudeLaunchSettings(command: String, args: [String]) -> String? {
  guard command.split(separator: "/").last == "claude", let prefix = env(settingsEnv), !prefix.isEmpty,
    let pane = env("ORCA_PANE_KEY"), !pane.isEmpty, env(settingsPidEnv) != String(getpid()),
    // As Pod's hook client: agents that run claude for themselves report nothing.
    env("CLAUDE_JOB_DIR") == nil, env("GROK_HOOK_EVENT") == nil, env("DEVIN_PROJECT_DIR") == nil,
    // Why: Claude keeps only the last --settings; the user's own wins over Pod's status.
    !args.dropFirst().contains(where: { $0 == "--settings" || $0.hasPrefix("--settings=") })
  else { return nil }
  let commandTemplate = "\(prefix).command.json"
  guard let relayPath = env(relayEnv), let relay = readText(relayPath).map(keyValues),
    let port = relay["POD_HOOK_RELAY_PORT"], let token = relay["POD_HOOK_RELAY_TOKEN"],
    let template = readText("\(prefix).http.json"), let process = agentProcess()
  else { return access(commandTemplate, R_OK) == 0 ? commandTemplate : nil }
  let fields = [pane, env("ORCA_TAB_ID") ?? "", env("ORCA_AGENT_LAUNCH_TOKEN") ?? "",
    env("ORCA_WORKTREE_ID") ?? "", env("ORCA_AGENT_HOOK_ENV") ?? "", env("ORCA_AGENT_HOOK_VERSION") ?? "",
    env("ORCA_AGENT_HOOK_ENDPOINT") ?? ""]
  let settings = template
    .replacing("@@POD_RELAY_URL@@", with: "http://127.0.0.1:\(port)/hook/claude")
    .replacing("@@POD_RELAY_TOKEN@@", with: jsonEscaped(token))
    .replacing("@@POD_RELAY_PANE@@", with: base64(Array(fields.joined(separator: "\u{1f}").utf8)))
    .replacing("@@POD_AGENT_PROCESS@@", with: jsonEscaped(process))
  let dir = String(prefix[..<(prefix.lastIndex(of: "/") ?? prefix.startIndex)]) + "/claude-launch"
  mkdir(dir, 0o700)
  pruneLaunchFiles(dir)
  let path = "\(dir)/claude-\(getpid()).json"
  return writePrivate(path, settings) ? path : (access(commandTemplate, R_OK) == 0 ? commandTemplate : nil)
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
var launchArgs = Array(arguments[commandIndex...])
if let settings = claudeLaunchSettings(command: command, args: launchArgs) {
  launchArgs.insert(contentsOf: ["--settings", settings], at: 1)
  setenv(settingsPidEnv, String(getpid()), 1)
}
let argv = launchArgs.map { strdup($0) } + [nil]
execv(target, argv)
fail("\(command): \(String(cString: strerror(errno)))", code: 126)
