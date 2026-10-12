// Claude's hooks through `--settings` (src/main/pod/agent-hook/pod-claude-flag-settings.ts), so Pod
// never writes them into ~/.claude/settings.json. The runtime's copies beside pod-agent-hook switch
// this on; the terminal daemon's, which send the hot events to its relay, win while the relay is up.

import Darwin

let claudeSettingsDirEnv = "POD_CLAUDE_SETTINGS"
let agentProcessEnv = "POD_AGENT_PROCESS"

func readBytes(_ path: String) -> [UInt8]? {
  let fd = open(path, O_RDONLY | O_CLOEXEC)
  guard fd >= 0 else { return nil }
  defer { close(fd) }
  var bytes: [UInt8] = []
  var chunk = [UInt8](repeating: 0, count: 65536)
  while true {
    let count = read(fd, &chunk, chunk.count)
    if count < 0 { return nil }
    if count == 0 { return bytes }
    bytes.append(contentsOf: chunk[0..<count])
  }
}

func exists(_ path: String) -> Bool { access(path, F_OK) == 0 }

func contains(_ bytes: [UInt8], _ needle: String) -> Bool {
  let pattern = Array(needle.utf8)
  guard bytes.count >= pattern.count else { return false }
  for start in 0...(bytes.count - pattern.count)
  where bytes[start] == pattern[0] && Array(bytes[start..<start + pattern.count]) == pattern {
    return true
  }
  return false
}

/// The relay answers on loopback; a dead daemon leaves its files behind.
func relayAlive(_ dir: String) -> Bool {
  guard let text = readBytes("\(dir)/relay.port"),
    let port = UInt16(String(decoding: text, as: UTF8.self).filter { $0.isNumber })
  else { return false }
  let fd = socket(AF_INET, SOCK_STREAM, 0)
  guard fd >= 0 else { return false }
  defer { close(fd) }
  _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
  var address = sockaddr_in()
  address.sin_family = sa_family_t(AF_INET)
  address.sin_port = port.bigEndian
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

/// A statusLine of the user's own anywhere Claude reads one below the flag: user settings, and the
/// project's from the working directory up (Claude reads the cwd's; a parent's only costs Pod's).
func userHasStatusLine(home: String) -> Bool {
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

/// `{"pid":N,"platform":"darwin","startTime":"<ps -o lstart= in UTC>"}`, as pod-agent-hook reports
/// the agent: this pid becomes Claude's at exec.
func agentProcessJSON() -> String? {
  var info = kinfo_proc()
  var size = MemoryLayout<kinfo_proc>.stride
  var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
  guard sysctl(&mib, 4, &info, &size, nil, 0) == 0, size > 0 else { return nil }
  var start = time_t(info.kp_proc.p_starttime.tv_sec)
  var utc = tm()
  gmtime_r(&start, &utc)
  var text = [CChar](repeating: 0, count: 64)
  strftime(&text, text.count, "%a %b %e %H:%M:%S %Y", &utc)
  return "{\"pid\":\(getpid()),\"platform\":\"darwin\",\"startTime\":\"\(String(cString: text))\"}"
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

/// Merged files are named for the launcher that wrote them; one whose process is gone is litter.
func collectMergedFiles(in dir: String) {
  guard let handle = opendir(dir) else { return }
  defer { closedir(handle) }
  while let entry = readdir(handle) {
    let name = withUnsafeBytes(of: entry.pointee.d_name) { raw in
      String(decoding: raw.prefix(while: { $0 != 0 }), as: UTF8.self)
    }
    guard name.hasPrefix("merged-"), let pid = Int32(name.dropFirst(7).prefix(while: \.isNumber))
    else { continue }
    if pid != getpid(), kill(pid, 0) != 0, errno == ESRCH { unlink("\(dir)/\(name)") }
  }
}

func writeMerged(_ bytes: [UInt8], in dir: String) -> String? {
  collectMergedFiles(in: dir)
  var template = Array("\(dir)/merged-\(getpid())-XXXXXX.json".utf8CString)
  let fd = mkstemps(&template, 5)
  guard fd >= 0 else { return nil }
  defer { close(fd) }
  let path = String(cString: template)
  _ = fchmod(fd, 0o600)
  let written = bytes.withUnsafeBytes { write(fd, $0.baseAddress, $0.count) }
  guard written == bytes.count else {
    unlink(path)
    return nil
  }
  return path
}

/// argv with Pod's `--settings`, or nil to run it as given: outside a Pod terminal (no pane for the
/// hooks to report to, e.g. this launcher on a Terminal.app PATH), native mode off, already handed
/// over (a wrapper script that ran `claude` again), or a user file Pod can't merge with.
func withClaudeSettings(_ argv: [String], home: String) -> [String]? {
  let fallbackDir = "\(home)/.orca/agent-hooks"
  guard env("ORCA_PANE_KEY")?.isEmpty == false, exists("\(fallbackDir)/claude-pod-settings.json")
  else { return nil }
  var dir = fallbackDir
  var names = ("claude-pod-settings.json", "claude-pod-settings-statusline.json")
  if let relayDir = env(claudeSettingsDirEnv), relayDir.hasPrefix("/"), relayAlive(relayDir) {
    dir = relayDir
    names = ("settings.json", "settings-statusline.json")
  }
  let ours = [fallbackDir, env(claudeSettingsDirEnv)].compactMap { $0 }.filter { !$0.isEmpty }
  var userValueIndex: Int?
  var inline = false
  var index = 1
  while index < argv.count, argv[index] != "--" {
    let arg = argv[index]
    if arg == "--settings", index + 1 < argv.count {
      userValueIndex = index + 1
      index += 1
    } else if arg.hasPrefix("--settings=") {
      userValueIndex = index
      inline = true
    }
    index += 1
  }
  let statusLine =
    exists("\(fallbackDir)/claude-pod-settings-statusline.json") && !userHasStatusLine(home: home)
  let chosen = "\(dir)/\(statusLine ? names.1 : names.0)"
  guard let at = userValueIndex else {
    return [argv[0], "--settings", chosen] + argv.dropFirst()
  }
  let given = inline ? String(argv[at].dropFirst("--settings=".count)) : argv[at]
  if ours.contains(where: { given.hasPrefix("\($0)/") }) { return nil }
  let trimmed = given.drop { $0 == " " || $0 == "\t" || $0 == "\n" }
  guard let userBytes = trimmed.hasPrefix("{") ? Array(given.utf8) : readBytes(given),
    let user = JSONParser.parse(userBytes),
    let podBytes = readBytes(chosen), let pod = JSONParser.parse(podBytes)
  else { return nil }
  // Why: Claude takes one --settings; the user's statusLine there beats Pod's.
  let podSettings: JSONValue
  if member(user, "statusLine") != nil, case .object(let members) = pod {
    podSettings = .object(members.filter { $0.key != Array("\"statusLine\"".utf8) })
  } else {
    podSettings = pod
  }
  guard let merged = mergeSettings(user: user, pod: podSettings) else { return nil }
  var bytes: [UInt8] = []
  serialize(merged, into: &bytes)
  guard let path = writeMerged(bytes, in: dir) else { return nil }
  var next = argv
  next[at] = inline ? "--settings=\(path)" : path
  return next
}
