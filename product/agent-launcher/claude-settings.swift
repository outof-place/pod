// In a Pod pane, `claude` gets Pod's agent-status hooks with the launch (`--settings`), so
// ~/.claude/settings.json holds none of Pod's (src/main/pod/agent-hook/pod-claude-launch-settings.ts).
// The runtime writes the templates: the launcher fills the http one (the terminal daemon's relay,
// which answers at once) or, without a relay, passes the command one (Pod's hook client). Each comes
// with Pod's statusLine too, taken only while the user has none. A user's own --settings gets a
// merged file, since Claude keeps only the last one. The JSON merge and the statusLine lookup are
// agent-api's (pod/claude-hooks-flag-settings 6859217697).

import Darwin

// Template prefix: <prefix>.<http|command>[-statusline].json, from the runtime.
let settingsEnv = "POD_CLAUDE_LAUNCH_SETTINGS"
// The terminal daemon's relay file: POD_HOOK_RELAY_PORT, POD_HOOK_RELAY_TOKEN.
let relayEnv = "POD_AGENT_HOOK_RELAY"
// The pid that already got settings (a wrapper script runs claude again in the same pid).
let settingsPidEnv = "POD_CLAUDE_SETTINGS_PID"

func readBytes(_ path: String, limit: Int = 1 << 20) -> [UInt8]? {
  let fd = open(path, O_RDONLY | O_CLOEXEC)
  guard fd >= 0 else { return nil }
  defer { close(fd) }
  var bytes: [UInt8] = []
  var chunk = [UInt8](repeating: 0, count: 16_384)
  while true {
    let n = read(fd, &chunk, chunk.count)
    if n < 0 { return nil }
    if n == 0 { return bytes }
    bytes.append(contentsOf: chunk[0..<n])
    if bytes.count > limit { return nil }
  }
}

func readText(_ path: String) -> String? {
  readBytes(path).map { String(decoding: $0, as: UTF8.self) }
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

func writePrivate(_ path: String, _ bytes: [UInt8]) -> Bool {
  let tmp = "\(path).\(getpid()).tmp"
  let fd = open(tmp, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0o600)
  guard fd >= 0 else { return false }
  let written = bytes.withUnsafeBytes { write(fd, $0.baseAddress, bytes.count) }
  close(fd)
  guard written == bytes.count, rename(tmp, path) == 0 else {
    unlink(tmp)
    return false
  }
  return true
}

/// Settings files of claudes that are gone: claude-<pid>.json and merged-<pid>.json.
func pruneLaunchFiles(_ dir: String) {
  guard let handle = opendir(dir) else { return }
  defer { closedir(handle) }
  while let entry = readdir(handle) {
    let name = withUnsafeBytes(of: entry.pointee.d_name) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) }
    guard name.hasPrefix("claude-") || name.hasPrefix("merged-"), name.hasSuffix(".json"),
      let pid = Int32(name.dropFirst(7).dropLast(5)), pid != getpid()
    else { continue }
    if kill(pid, 0) != 0 && errno == ESRCH { unlink("\(dir)/\(name)") }
  }
}

func launchDir(_ prefix: String) -> String {
  let dir = String(prefix[..<(prefix.lastIndex(of: "/") ?? prefix.startIndex)]) + "/claude-launch"
  mkdir(dir, 0o700)
  // Why: mkdir leaves an existing directory's mode as it was.
  chmod(dir, 0o700)
  pruneLaunchFiles(dir)
  return dir
}

func contains(_ bytes: [UInt8], _ needle: String) -> Bool {
  let pattern = Array(needle.utf8)
  guard bytes.count >= pattern.count else { return false }
  for start in 0...(bytes.count - pattern.count)
  where bytes[start] == pattern[0] && Array(bytes[start..<start + pattern.count]) == pattern {
    return true
  }
  return false
}

/// A statusLine of the user's own anywhere Claude reads one below the flag: user settings, and the
/// project's from the working directory up (Claude reads the cwd's; a parent's only costs Pod's).
func userHasStatusLine() -> Bool {
  guard let home = env("HOME"), home.hasPrefix("/") else { return true }
  let configDir = env("CLAUDE_CONFIG_DIR").flatMap { $0.isEmpty ? nil : $0 } ?? "\(home)/.claude"
  var files = ["\(configDir)/settings.json"]
  var buffer = [CChar](repeating: 0, count: Int(PATH_MAX))
  if getcwd(&buffer, buffer.count) != nil {
    var dir = String(cString: buffer)
    while true {
      let base = dir == "/" ? "" : dir
      files += ["\(base)/.claude/settings.json", "\(base)/.claude/settings.local.json"]
      guard let slash = dir.lastIndex(of: "/"), dir != "/" else { break }
      dir = slash == dir.startIndex ? "/" : String(dir[..<slash])
    }
  }
  return files.contains { readBytes($0).map { contains($0, "\"statusLine\"") } ?? false }
}

// MARK: The JSON a user's own --settings merges with: objects and arrays parsed, the rest kept raw.

indirect enum JSONValue {
  case object([(key: [UInt8], value: JSONValue)])
  case array([JSONValue])
  case raw([UInt8])
}

struct JSONParser {
  let bytes: [UInt8]
  var index = 0

  init(_ bytes: [UInt8]) { self.bytes = bytes }

  mutating func skipSpace() {
    while index < bytes.count, [0x20, 0x09, 0x0a, 0x0d].contains(bytes[index]) { index += 1 }
  }

  mutating func string() -> [UInt8]? {
    let start = index
    index += 1
    while index < bytes.count {
      if bytes[index] == 0x5c { index += 2; continue }
      if bytes[index] == 0x22 { index += 1; return Array(bytes[start..<index]) }
      index += 1
    }
    return nil
  }

  mutating func value() -> JSONValue? {
    skipSpace()
    guard index < bytes.count else { return nil }
    switch bytes[index] {
    case 0x7b:
      index += 1
      var members: [(key: [UInt8], value: JSONValue)] = []
      skipSpace()
      if index < bytes.count, bytes[index] == 0x7d { index += 1; return .object(members) }
      while true {
        skipSpace()
        guard index < bytes.count, bytes[index] == 0x22, let key = string() else { return nil }
        skipSpace()
        guard index < bytes.count, bytes[index] == 0x3a else { return nil }
        index += 1
        guard let member = value() else { return nil }
        members.append((key, member))
        skipSpace()
        guard index < bytes.count else { return nil }
        if bytes[index] == 0x2c { index += 1; continue }
        if bytes[index] == 0x7d { index += 1; return .object(members) }
        return nil
      }
    case 0x5b:
      index += 1
      var items: [JSONValue] = []
      skipSpace()
      if index < bytes.count, bytes[index] == 0x5d { index += 1; return .array(items) }
      while true {
        guard let item = value() else { return nil }
        items.append(item)
        skipSpace()
        guard index < bytes.count else { return nil }
        if bytes[index] == 0x2c { index += 1; continue }
        if bytes[index] == 0x5d { index += 1; return .array(items) }
        return nil
      }
    case 0x22:
      return string().map { .raw($0) }
    default:
      let start = index
      while index < bytes.count, ![0x2c, 0x5d, 0x7d, 0x20, 0x09, 0x0a, 0x0d].contains(bytes[index]) {
        index += 1
      }
      return index > start ? .raw(Array(bytes[start..<index])) : nil
    }
  }

  static func parse(_ bytes: [UInt8]) -> JSONValue? {
    var parser = JSONParser(bytes)
    guard let parsed = parser.value() else { return nil }
    parser.skipSpace()
    return parser.index == bytes.count ? parsed : nil
  }
}

func serialize(_ value: JSONValue, into out: inout [UInt8]) {
  switch value {
  case .raw(let bytes):
    out += bytes
  case .array(let items):
    out.append(0x5b)
    for (offset, item) in items.enumerated() {
      if offset > 0 { out.append(0x2c) }
      serialize(item, into: &out)
    }
    out.append(0x5d)
  case .object(let members):
    out.append(0x7b)
    for (offset, member) in members.enumerated() {
      if offset > 0 { out.append(0x2c) }
      out += member.key
      out.append(0x3a)
      serialize(member.value, into: &out)
    }
    out.append(0x7d)
  }
}

func member(_ value: JSONValue, _ key: String) -> JSONValue? {
  guard case .object(let members) = value else { return nil }
  let quoted = Array("\"\(key)\"".utf8)
  return members.last { $0.key == quoted }?.value
}

/// The user's settings with Pod's hook groups after theirs, per event (Claude runs both), and Pod's
/// statusLine only where the user's file has none.
func mergeSettings(user: JSONValue, pod: JSONValue) -> JSONValue? {
  guard case .object(var members) = user, case .object(let podMembers) = pod else { return nil }
  let hooksKey = Array("\"hooks\"".utf8)
  for podMember in podMembers {
    if podMember.key == hooksKey, case .object(let podEvents) = podMember.value {
      var events: [(key: [UInt8], value: JSONValue)] = []
      if let existing = members.lastIndex(where: { $0.key == hooksKey }) {
        guard case .object(let userEvents) = members[existing].value else { return nil }
        events = userEvents
        members.remove(at: existing)
      }
      for podEvent in podEvents {
        guard case .array(let podGroups) = podEvent.value else { return nil }
        if let at = events.lastIndex(where: { $0.key == podEvent.key }) {
          guard case .array(let groups) = events[at].value else { return nil }
          events[at].value = .array(groups + podGroups)
        } else {
          events.append(podEvent)
        }
      }
      members.append((hooksKey, .object(events)))
    } else if !members.contains(where: { $0.key == podMember.key }) {
      members.append(podMember)
    }
  }
  return .object(members)
}

/// The relay answers on loopback; a relay file a dead daemon left behind must not cost the hooks
/// (agent-api's check).
func relayAlive(_ port: String) -> Bool {
  guard let number = UInt16(port) else { return false }
  let fd = socket(AF_INET, SOCK_STREAM, 0)
  guard fd >= 0 else { return false }
  defer { close(fd) }
  _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
  var address = sockaddr_in()
  address.sin_family = sa_family_t(AF_INET)
  address.sin_port = number.bigEndian
  address.sin_addr.s_addr = UInt32(0x7f00_0001).bigEndian
  let result = withUnsafePointer(to: &address) {
    $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
      connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
    }
  }
  if result == 0 { return true }
  guard errno == EINPROGRESS else { return false }
  var poller = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
  guard poll(&poller, 1, 100) == 1 else { return false }
  var error: Int32 = 0
  var length = socklen_t(MemoryLayout<Int32>.size)
  return getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &length) == 0 && error == 0
}

// MARK: Claude's argv

/// Pod's settings for this launch: the filled http template, else the command one. With `write`
/// false (a merge follows) the filled template stays in memory.
func podLaunchSettings(prefix: String, pane: String, statusLine: Bool, write: Bool) -> (path: String, bytes: [UInt8])? {
  let variant = statusLine ? "-statusline" : ""
  let commandTemplate = "\(prefix).command\(variant).json"
  let fallback = readBytes(commandTemplate).map { (commandTemplate, $0) }
  // Why the endpoint file: the relay reads only that; without it the C client uses the pane's env.
  guard let endpoint = env("ORCA_AGENT_HOOK_ENDPOINT"), access(endpoint, R_OK) == 0,
    let relayPath = env(relayEnv), let relay = readText(relayPath).map(keyValues),
    let port = relay["POD_HOOK_RELAY_PORT"], let token = relay["POD_HOOK_RELAY_TOKEN"], relayAlive(port),
    let template = readText("\(prefix).http\(variant).json"), let process = agentProcess()
  else { return fallback }
  let fields = [pane, env("ORCA_TAB_ID") ?? "", env("ORCA_AGENT_LAUNCH_TOKEN") ?? "",
    env("ORCA_WORKTREE_ID") ?? "", env("ORCA_AGENT_HOOK_ENV") ?? "", env("ORCA_AGENT_HOOK_VERSION") ?? "",
    endpoint]
  let settings = Array(template
    .replacing("@@POD_RELAY_URL@@", with: "http://127.0.0.1:\(port)/hook/claude")
    .replacing("@@POD_RELAY_TOKEN@@", with: jsonEscaped(token))
    .replacing("@@POD_RELAY_PANE@@", with: base64(Array(fields.joined(separator: "\u{1f}").utf8)))
    .replacing("@@POD_AGENT_PROCESS@@", with: jsonEscaped(process)).utf8)
  guard write else { return ("", settings) }
  let path = "\(launchDir(prefix))/claude-\(getpid()).json"
  return writePrivate(path, settings) ? (path, settings) : fallback
}

/// Claude's argv with Pod's settings, or nil where Pod adds none: outside a Pod pane, in a job or
/// another agent's claude, already handed over, or a user file Pod can't merge with.
func claudeLaunchArgs(command: String, args: [String]) -> [String]? {
  guard command.split(separator: "/").last == "claude", let prefix = env(settingsEnv), !prefix.isEmpty,
    let pane = env("ORCA_PANE_KEY"), !pane.isEmpty, env(settingsPidEnv) != String(getpid()),
    // As Pod's hook client: agents that run claude for themselves report nothing.
    env("CLAUDE_JOB_DIR") == nil, env("GROK_HOOK_EVENT") == nil, env("DEVIN_PROJECT_DIR") == nil
  else { return nil }
  var userValueIndex: Int?
  var inline = false
  var index = 1
  while index < args.count, args[index] != "--" {
    if args[index] == "--settings", index + 1 < args.count {
      userValueIndex = index + 1
      index += 1
    } else if args[index].hasPrefix("--settings=") {
      userValueIndex = index
      inline = true
    }
    index += 1
  }
  let ours = String(prefix[..<(prefix.lastIndex(of: "/") ?? prefix.startIndex)]) + "/"
  let given = userValueIndex.map { inline ? String(args[$0].dropFirst("--settings=".count)) : args[$0] }
  // Why: a wrapper that runs claude again with Pod's file already in its argv.
  if let given, given.hasPrefix(ours) { return nil }
  let statusLine = access("\(prefix).command-statusline.json", R_OK) == 0 && !userHasStatusLine()
  guard let pod = podLaunchSettings(prefix: prefix, pane: pane, statusLine: statusLine, write: given == nil)
  else { return nil }
  guard let at = userValueIndex, let given else {
    return [args[0], "--settings", pod.path] + args.dropFirst()
  }
  let trimmed = given.drop { $0 == " " || $0 == "\t" || $0 == "\n" }
  guard let userBytes = trimmed.hasPrefix("{") ? Array(given.utf8) : readBytes(given),
    let user = JSONParser.parse(userBytes), let podSettings = JSONParser.parse(pod.bytes)
  else { return nil }
  // Why: Claude takes one --settings; the user's statusLine there beats Pod's.
  var podPart = podSettings
  if member(user, "statusLine") != nil, case .object(let members) = podSettings {
    podPart = .object(members.filter { $0.key != Array("\"statusLine\"".utf8) })
  }
  guard let merged = mergeSettings(user: user, pod: podPart) else { return nil }
  var bytes: [UInt8] = []
  serialize(merged, into: &bytes)
  let path = "\(launchDir(prefix))/merged-\(getpid()).json"
  guard writePrivate(path, bytes) else { return nil }
  var next = args
  next[at] = inline ? "--settings=\(path)" : path
  return next
}

/// For the runtime's deferred settings.json cut (pod-claude-settings-cut.ts): returns, printing the
/// pid, once one of `pids` exits (kqueue NOTE_EXIT, no polling); also when the caller exits, so the
/// watcher never outlives Pod. A pid already gone returns at once.
func awaitExit(_ pids: [pid_t]) -> Never {
  let queue = kqueue()
  guard queue >= 0, !pids.isEmpty else { exit(64) }
  for pid in pids + [getppid()] {
    var change = kevent(
      ident: UInt(pid), filter: Int16(EVFILT_PROC), flags: UInt16(EV_ADD | EV_ONESHOT),
      fflags: NOTE_EXIT, data: 0, udata: nil)
    if kevent(queue, &change, 1, nil, 0, nil) != 0 {
      print(pid)
      exit(0)
    }
  }
  var event = kevent()
  while kevent(queue, nil, 0, &event, 1, nil) < 0 && errno == EINTR {}
  print(event.ident)
  exit(0)
}
