// POD_INDEXED_SEARCH=1 (Settings › Indexed search, off by default; the runtime puts it in new
// terminals' environment): the `rg` Claude's Bash commands run is og, pod-search's indexed ripgrep,
// and the index of the folder Claude starts in builds while it starts. og answers from the ogd
// daemon when it can and execs the plain ripgrep 15.2.0 beside it otherwise, so its output is
// always ripgrep's. Not covered: Claude's own Grep tool, which runs the ripgrep embedded in its
// binary, and a user's ~/.zshrc that puts another rg ahead on PATH (that rg runs as before).
//
// <Resources>/pod-search (config/pod-search-extra-resources.cjs): bin/{og,ogd,ogctl,rg} and
// rg-shim/rg -> ../bin/og.
//   PATH                 rg-shim first: `rg` from Claude's Bash, or from a tool it runs, is og
//   OG_REAL_RG           the plain rg og execs when it can't answer (it serves only over its base)
//   POD_SEARCH_SPAWN     1: og may start ogd when none answers (pod-search crates/proto/src/spawn.rs);
//                        ogd then lives in this terminal daemon's tree and leaves when idle
//   OG_CANARY_RATE       0, always: no shadow rg runs behind served queries
//   OG_CANARY_KILL_FILE  a file of Pod's own: og's canary never touches the kill switch of a
//                        developer's own pod-search install (~/.local/share/pod-search/hook-enabled)
// ogd uses the default socket and state dir (~/Library/Caches/pod-search): a Mac with a
// developer's own install runs one daemon, whichever answers, and Pod never stops a launchd one.
//
// Claude only (Pod is Claude-scoped): codex and others start as before.

import Darwin

let indexedSearchEnv = "POD_INDEXED_SEARCH"

/// <Resources>/pod-search, from <Resources>/bin/pod-agent-launcher.
func podSearchDir() -> String? {
  guard let selfPath = executablePath() else { return nil }
  var parts = selfPath.split(separator: "/", omittingEmptySubsequences: false)
  guard parts.count > 2 else { return nil }
  parts.removeLast(2)
  return parts.joined(separator: "/") + "/pod-search"
}

/// The indexed-search environment for `command` when the setting is on and the payload is there.
func applyIndexedSearch(command: String) {
  guard env(indexedSearchEnv) == "1", command == "claude", let dir = podSearchDir() else { return }
  let shim = dir + "/rg-shim"
  guard isExecutableFile(dir + "/bin/og"), isExecutableFile(dir + "/bin/rg"),
    isExecutableFile(dir + "/bin/ogctl"), isExecutableFile(shim + "/rg")
  else { return }
  let path = env("PATH") ?? ""
  // Why the check: a claude started under claude already has it.
  if !path.hasPrefix(shim + ":") && path != shim {
    setenv("PATH", path.isEmpty ? shim : shim + ":" + path, 1)
  }
  setenv("OG_REAL_RG", dir + "/bin/rg", 1)
  setenv("POD_SEARCH_SPAWN", "1", 1)
  setenv("OG_CANARY_RATE", "0", 1)
  if let home = env("HOME"), home.hasPrefix("/") {
    setenv("OG_CANARY_KILL_FILE", home + "/Library/Caches/" + launcherCacheName + "/og-canary-off", 1)
  }
  startIndexing(ogctl: dir + "/bin/ogctl")
}

/// Pod's own cache folder for the launcher (never pod-search's or a developer install's).
let launcherCacheName = "codes.pod.agent-launcher"

/// Whether `dir` is the home directory or a folder above it: ogd never indexes those (a dotfiles
/// repository in ~ would cover all of home), so starting a daemon for them is pointless.
func coversHome(_ dir: String) -> Bool {
  guard let home = env("HOME").flatMap(realPath), let dir = realPath(dir) else { return true }
  return dir == "/" || home == dir || home.hasPrefix(dir + "/")
}

/// `ogctl ensure --register <cwd>` in its own session, not waited for: it starts ogd when none
/// answers and registers the folder, so the first search finds the index built or building. A
/// middle process (`--search-detach`) starts it and exits, so ogctl is launchd's child and never
/// a zombie of the agent's.
func startIndexing(ogctl: String) {
  guard let selfPath = executablePath(), let cwd = currentDirectory(), !coversHome(cwd) else {
    return
  }
  guard let middle = spawnQuiet(selfPath, ["--search-detach", ogctl, cwd], newSession: false)
  else { return }
  var status: Int32 = 0
  while waitpid(middle, &status, 0) < 0 && errno == EINTR {}
}

/// The `--search-detach` middle process: starts ogctl and exits.
func searchDetach(ogctl: String, cwd: String) -> Never {
  _ = spawnQuiet(ogctl, ["ensure", "--register", cwd], newSession: true, environment: daemonEnvironment())
  exit(0)
}

/// What ogctl, and the ogd it may start, get from the agent's environment: no more than the
/// daemon needs (HOME and XDG_CONFIG_HOME are og's fingerprint of it), never the agent's tokens.
func daemonEnvironment() -> [String] {
  let keep: Set<String> = ["HOME", "XDG_CONFIG_HOME", "PATH", "TMPDIR", "LANG"]
  var out: [String] = []
  var entry = environ
  while let pointer = entry.pointee {
    let pair = String(cString: pointer)
    let name = String(pair.prefix { $0 != "=" })
    if keep.contains(name) || name.hasPrefix("POD_SEARCH_") || name.hasPrefix("OGD_") {
      out.append(pair)
    }
    entry += 1
  }
  return out
}

func currentDirectory() -> String? {
  var buffer = [CChar](repeating: 0, count: Int(MAXPATHLEN))
  guard getcwd(&buffer, buffer.count) != nil else { return nil }
  return String(cString: buffer)
}

/// `path args...` with /dev/null for 0-2 and no other descriptor, from /; with `environment`
/// ("NAME=value" entries) instead of this process's own when given.
func spawnQuiet(_ path: String, _ args: [String], newSession: Bool, environment: [String]? = nil)
  -> pid_t?
{
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
  posix_spawn_file_actions_addchdir_np(&actions, "/")
  let argv: [UnsafeMutablePointer<CChar>?] = ([path] + args).map { strdup($0) } + [nil]
  defer { argv.forEach { free($0) } }
  let envp: [UnsafeMutablePointer<CChar>?]? = environment.map { $0.map { strdup($0) } + [nil] }
  defer { envp?.forEach { free($0) } }
  var pid: pid_t = 0
  let spawned = envp.map { posix_spawn(&pid, path, &actions, &attributes, argv, $0) }
    ?? posix_spawn(&pid, path, &actions, &attributes, argv, environ)
  return spawned == 0 ? pid : nil
}
