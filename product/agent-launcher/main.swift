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
//   pod-agent-launcher --tree-watch <pid>  (internal) the watcher that gives <pid>'s tree the role
//
// POD_AGENT_TURBO=0 skips the policy (the command still runs); POD_AGENT_TREE=0 keeps the role on
// the agent's own process only.
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

// The agent's whole tree at app priority. The role is not inherited by fork, so the hooks, MCP
// servers and tool commands an agent starts ran at 31 and waited behind everything else under load.
// A watcher, detached from the agent (launchd's child, its own session, no terminal fd, no working
// directory), gives the agent's children and theirs the same role as soon as they exist: kqueue
// NOTE_FORK (no polling), proc_listchildpids for the new ones, and setpriority(PRIO_DARWIN_ROLE),
// which the kernel allows only on processes of the same user. Deeper processes (a build's workers)
// and Pod's statusline stay at default; a process that already has a role (darwinbg, throttled)
// keeps it, and a QoS clamp (`taskpolicy -c`) still wins over the role. It exits with the agent.
let treeEnv = "POD_AGENT_TREE"
// "<pid>": the agent whose watcher this process's tree already has.
let treeRootEnv = "POD_AGENT_TREE_ROOT"
// <sys/resource.h> (PRIVATE): PRIO_DARWIN_ROLE, and PRIO_DARWIN_ROLE_UI = TASK_DEFAULT_APPLICATION.
let prioDarwinRole: Int32 = 6
let prioDarwinRoleUI: Int32 = 2
// The watcher's word that it follows the agent, on this descriptor.
let readyFd: Int32 = 3
let forkNote = UInt32(truncatingIfNeeded: NOTE_FORK)
let exitNote = UInt32(truncatingIfNeeded: NOTE_EXIT)

func processInfo(_ pid: pid_t) -> proc_bsdinfo? {
  var info = proc_bsdinfo()
  let size = Int32(MemoryLayout<proc_bsdinfo>.size)
  return proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size ? info : nil
}

/// This process or an ancestor already has a watcher (a wrapper that execs the agent again, an
/// agent started from inside another): that tree includes this one.
func treeAlreadyWatched() -> Bool {
  guard let value = env(treeRootEnv), let root = pid_t(value), root > 1 else { return false }
  var pid = getpid()
  for _ in 0..<64 {
    if pid == root { return true }
    guard let info = processInfo(pid), info.pbi_ppid > 1 else { return false }
    pid = pid_t(info.pbi_ppid)
  }
  return false
}

/// `path args...` with /dev/null for 0-2, `ready` as fd 3 and no other descriptor, from /.
func spawnHelper(_ path: String, _ args: [String], ready: Int32, newSession: Bool) -> pid_t? {
  var attributes: posix_spawnattr_t?
  var actions: posix_spawn_file_actions_t?
  guard posix_spawnattr_init(&attributes) == 0 else { return nil }
  defer { posix_spawnattr_destroy(&attributes) }
  guard posix_spawn_file_actions_init(&actions) == 0 else { return nil }
  defer { posix_spawn_file_actions_destroy(&actions) }
  var flags = Int32(POSIX_SPAWN_CLOEXEC_DEFAULT)
  if newSession { flags |= Int32(POSIX_SPAWN_SETSID) }
  posix_spawnattr_setflags(&attributes, Int16(flags))
  for fd: Int32 in 0...2 { posix_spawn_file_actions_addopen(&actions, fd, "/dev/null", O_RDWR, 0) }
  posix_spawn_file_actions_adddup2(&actions, ready, readyFd)
  posix_spawn_file_actions_addchdir_np(&actions, "/")
  let argv: [UnsafeMutablePointer<CChar>?] = ([path] + args).map { strdup($0) } + [nil]
  defer { argv.forEach { free($0) } }
  var pid: pid_t = 0
  return posix_spawn(&pid, path, &actions, &attributes, argv, environ) == 0 ? pid : nil
}

/// Starts this pid's watcher and returns once it follows the pid, so nothing the agent starts is
/// missed; after 250 ms without word the agent starts anyway. The middle process starts the
/// watcher and exits, so the watcher is launchd's child, not the agent's.
func startTreeWatcher() {
  guard env(turboEnv) != "0", env(treeEnv) != "0", !treeAlreadyWatched(),
    let selfPath = executablePath()
  else { return }
  var fds: [Int32] = [-1, -1]
  guard pipe(&fds) == 0 else { return }
  defer { close(fds[0]) }
  let middle = spawnHelper(selfPath, ["--tree-detach", String(getpid())], ready: fds[1], newSession: false)
  close(fds[1])
  guard let middle else { return }
  var status: Int32 = 0
  while waitpid(middle, &status, 0) < 0 && errno == EINTR {}
  var poller = pollfd(fd: fds[0], events: Int16(POLLIN), revents: 0)
  var byte: UInt8 = 0
  if poll(&poller, 1, 250) > 0, read(fds[0], &byte, 1) == 1, byte == UInt8(ascii: "1") {
    setenv(treeRootEnv, String(getpid()), 1)
  }
}

let execNote = UInt32(truncatingIfNeeded: NOTE_EXEC)

/// The program a process runs now.
func programPath(_ pid: pid_t) -> String? {
  var buffer = [CChar](repeating: 0, count: 4096)
  guard proc_pidpath(pid, &buffer, UInt32(buffer.count)) > 0 else { return nil }
  return String(cString: buffer)
}

/// Pod's statusline, which Claude runs about once a second per agent and doesn't wait for: it
/// stays at default, so it doesn't compete with the tool's shell. (Pod's hooks get the role: a
/// PreToolUse hook runs before every tool.)
func isPodStatusLine(_ pid: pid_t) -> Bool {
  var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
  var buffer = [UInt8](repeating: 0, count: 16384)
  var size = buffer.count
  guard sysctl(&mib, 3, &buffer, &size, nil, 0) == 0, size > 4 else { return false }
  let argc = buffer.withUnsafeBytes { $0.load(as: Int32.self) }
  // argc, the exec path, NULs, then argc arguments (the environment follows: never read).
  var index = 4
  while index < size && buffer[index] != 0 { index += 1 }
  while index < size && buffer[index] == 0 { index += 1 }
  for _ in 0..<max(argc, 0) where index < size {
    let start = index
    while index < size && buffer[index] != 0 { index += 1 }
    let argument = String(decoding: buffer[start..<index], as: UTF8.self)
    if argument.contains("/agent-hooks/"), argument.contains("statusline") { return true }
    index += 1
  }
  return false
}

/// The watched tree: depth below the agent of each process followed.
struct Tree {
  let queue: Int32
  var depth: [pid_t: Int] = [:]

  /// Follows `pid` (forks, exit, and the exec of the agent's own children), once.
  mutating func follow(_ pid: pid_t, depth level: Int) -> Bool {
    guard depth[pid] == nil else { return false }
    var change = kevent(
      ident: UInt(pid), filter: Int16(EVFILT_PROC), flags: UInt16(EV_ADD | EV_CLEAR),
      fflags: forkNote | exitNote | (level == 1 ? execNote : 0), data: 0, udata: nil)
    guard kevent(queue, &change, 1, nil, 0, nil) == 0 else { return false }
    depth[pid] = level
    return true
  }

  mutating func forget(_ pid: pid_t) {
    var change = kevent(
      ident: UInt(pid), filter: Int16(EVFILT_PROC), flags: UInt16(EV_DELETE), fflags: 0, data: 0,
      udata: nil)
    _ = kevent(queue, &change, 1, nil, 0, nil)
    depth[pid] = nil
  }

  /// `parent`'s new children get the role (unless they have one). The agent's children are
  /// followed, so their own children (the command a tool's shell runs, a hook's client) get it
  /// too; deeper processes (a build's workers) stay at default, and so does Pod's statusline.
  mutating func sweep(_ parent: pid_t) {
    guard let parentDepth = depth[parent], parentDepth < 2 else { return }
    var children = [pid_t](repeating: 0, count: 256)
    let size = Int32(children.count * MemoryLayout<pid_t>.size)
    let count = proc_listchildpids(parent, &children, size)
    guard count > 0 else { return }
    let parentProgram = programPath(parent)
    for child in children.prefix(min(Int(count), children.count)) where depth[child] == nil {
      // Still that parent's child, and this user's (the kernel checks the user again).
      guard let info = processInfo(child), pid_t(info.pbi_ppid) == parent,
        info.pbi_uid == getuid()
      else { continue }
      let level = parentDepth + 1
      // A child not exec'd yet runs its parent's program: its exec decides (NOTE_EXEC).
      if level == 1, programPath(child) != parentProgram, isPodStatusLine(child) { continue }
      errno = 0
      let role = getpriority(prioDarwinRole, id_t(child))
      guard errno == 0 else { continue }
      if role == 0 { _ = setpriority(prioDarwinRole, id_t(child), prioDarwinRoleUI) }
      if level == 1, follow(child, depth: level) { sweep(child) }
    }
  }

  /// One of the agent's children exec'd: Pod's statusline goes back to default.
  mutating func execed(_ pid: pid_t) {
    guard depth[pid] == 1, isPodStatusLine(pid) else { return }
    _ = setpriority(prioDarwinRole, id_t(pid), 0)
    forget(pid)
  }
}

func watchTree(_ root: pid_t) -> Never {
  _ = applyAppRole()
  var tree = Tree(queue: kqueue())
  let ok = tree.queue >= 0 && tree.follow(root, depth: 0)
  var word = UInt8(ascii: ok ? "1" : "0")
  _ = write(readyFd, &word, 1)
  close(readyFd)
  guard ok else { exit(0) }
  tree.sweep(root)
  var events = Array(
    repeating: kevent(ident: 0, filter: 0, flags: 0, fflags: 0, data: 0, udata: nil), count: 64)
  while true {
    let count = kevent(tree.queue, nil, 0, &events, Int32(events.count), nil)
    if count < 0 {
      if errno == EINTR { continue }
      exit(0)
    }
    for event in events.prefix(Int(count)) {
      let pid = pid_t(event.ident)
      if event.fflags & execNote != 0 { tree.execed(pid) }
      if event.fflags & forkNote != 0 { tree.sweep(pid) }
      if event.fflags & exitNote != 0 {
        if pid == root { exit(0) }
        tree.depth[pid] = nil
      }
    }
  }
}

let arguments = CommandLine.arguments
let invokedAs = String(arguments[0].split(separator: "/").last ?? "")
var commandIndex = 0
if invokedAs == launcherName {
  switch arguments.dropFirst().first {
  case "--print-policy":
    printPolicy()
    exit(0)
  case "--tree-detach" where arguments.count == 3:
    if let root = pid_t(arguments[2]), let selfPath = executablePath() {
      _ = spawnHelper(selfPath, ["--tree-watch", String(root)], ready: readyFd, newSession: true)
    }
    exit(0)
  case "--tree-watch" where arguments.count == 3:
    guard let root = pid_t(arguments[2]), root > 1 else { exit(64) }
    watchTree(root)
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
startTreeWatcher()
let argv = CommandLine.unsafeArgv + commandIndex
execv(target, argv)
fail("\(command): \(String(cString: strerror(errno)))", code: 126)
