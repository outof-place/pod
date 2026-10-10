import Darwin
import PodxCore

// Ports of src/cli/handlers/computer.ts, computer-action-flags.ts and computer-format.ts.
// Flag validation that would fail goes to Node, which prints its own hint.

extension Invocation {
  /// getOptionalNumberFlag for spellings Number() reads back unchanged (no exponent, no padding).
  func optNumber(_ name: String) throws(CliError) -> JSONValue? {
    switch flags[name] {
    case nil: return nil
    case .bool?: throw .needsNode
    case .string(let value)?:
      if value.isEmpty { return nil }
      guard isCanonicalDecimal(value) else { throw .needsNode }
      return .number(value)
    }
  }

  func reqStringAllowingEmpty(_ name: String) throws(CliError) -> String {
    guard case .string(let value)? = flags[name] else { throw .needsNode }
    return value
  }

  /// getComputerObserveFlags as ordered params.
  func computerObserveFlags() throws(CliError) -> [(String, JSONValue?)] {
    let windowId = try optNonNegativeInt("window-id")
    let windowIndex = try optNonNegativeInt("window-index")
    if windowId != nil && windowIndex != nil { throw .needsNode }
    var params: [(String, JSONValue?)] = [("noScreenshot", flags.has("no-screenshot") ? .bool(true) : nil)]
    if flags.has("restore-window") { params.append(("restoreWindow", .bool(true))) }
    if let windowId { params.append(("windowId", .int(windowId))) }
    if let windowIndex { params.append(("windowIndex", .int(windowIndex))) }
    return params
  }

  /// getComputerCommandTarget.
  func computerTarget() throws(CliError) -> [(String, JSONValue?)] {
    let app = try reqString("app")
    let session = try optString("session")
    let worktree = try optString("worktree")
    if session != nil && worktree != nil { throw .needsNode }
    if let session {
      return [("session", .str(session)), ("app", .str(app))]
    }
    return [("app", .str(app)), ("worktree", try browserWorktreeSelector().json)]
  }
}

/// Matches /^-?(0|[1-9]\d*)(\.\d*[1-9])?$/ with at most 15 significant digits, not -0.
func isCanonicalDecimal(_ s: String) -> Bool {
  var bytes = Array(s.utf8)
  if bytes.first == 0x2D { bytes.removeFirst() }
  guard let first = bytes.first, isDigitByte(first) else { return false }
  var i = 0
  var digits = 0
  if first == 0x30 {
    i = 1
  } else {
    while i < bytes.count, isDigitByte(bytes[i]) { i += 1 }
    digits = i
  }
  if i < bytes.count {
    guard bytes[i] == 0x2E, i + 1 < bytes.count else { return false }
    let fraction = bytes[(i + 1)...]
    guard fraction.allSatisfy(isDigitByte), fraction.last != 0x30 else { return false }
    digits += fraction.count
  }
  if s.hasPrefix("-") && s == "-0" { return false }
  return digits <= 15
}

func isDigitByte(_ c: UInt8) -> Bool { c >= 0x30 && c <= 0x39 }

let HOTKEY_MODIFIERS: Set<String> = [
  "alt", "cmd", "cmdorctrl", "command", "commandorcontrol", "control", "ctrl", "meta", "option", "shift",
  "super", "win",
]

/// computerUseHotkeyValidationMessage(key) === null, for ASCII keys.
func isValidHotkey(_ key: String) -> Bool {
  let parts = key.split(separator: "+", omittingEmptySubsequences: false).map { jsTrimASCII(String($0)) }
  if parts.count < 2 || parts.contains(where: \.isEmpty) { return false }
  let keyParts = parts.filter { part in
    !HOTKEY_MODIFIERS.contains(String(part.lowercased().filter { !" \t\n\r\u{0B}\u{0C}_-".contains($0) }))
  }
  return keyParts.count == 1
}

func isValidPressKey(_ key: String) -> Bool {
  let trimmed = jsTrimASCII(key)
  if trimmed.isEmpty { return false }
  return trimmed == "+" || !trimmed.contains("+")
}

func isValidClickModifiers(_ modifiers: String) -> Bool {
  let parts = modifiers.split(separator: "+", omittingEmptySubsequences: false).map { jsTrimASCII(String($0)) }
  return !parts.isEmpty && parts.count <= 4 && parts.allSatisfy { !$0.isEmpty && HOTKEY_MODIFIERS.contains($0.lowercased()) }
}

/// String.prototype.trim for ASCII input; non-ASCII keys go to Node.
func jsTrimASCII(_ s: String) -> String {
  let bytes = Array(s.utf8)
  var start = 0
  var end = bytes.count
  let ws: Set<UInt8> = [0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20]
  while start < end, ws.contains(bytes[start]) { start += 1 }
  while end > start, ws.contains(bytes[end - 1]) { end -= 1 }
  return String(decoding: bytes[start..<end], as: UTF8.self)
}

func computerActionHandler(
  _ verb: String, _ method: String, _ actionParams: @escaping @Sendable (Invocation) throws(CliError) -> [(String, JSONValue?)]
) -> Handler {
  { inv in
    _ = try inv.reqString("app")
    let observe = try inv.computerObserveFlags()
    let action = try actionParams(inv)
    let target = try inv.computerTarget()
    let r = try inv.call("computer.\(method)", target + action + observe)
    let followUp = paramsObject(target + observe)
    try inv.printComputerResult(r) { v in formatComputerAction(verb, v, followUp) }
  }
}

let COMPUTER_HANDLERS: [String: Handler] = [
  "computer capabilities": { inv in
    let r = try inv.call("computer.capabilities", [], readOnly: true)
    try inv.printComputerResult(r, formatComputerCapabilities)
  },
  "computer list-apps": { inv in
    let r = try inv.call("computer.listApps", [], readOnly: true)
    try inv.printComputerResult(r, formatListApps)
  },
  "computer list-windows": { inv in
    let app = try inv.reqString("app")
    let r = try inv.call("computer.listWindows", [("app", .str(app))], readOnly: true)
    try inv.printComputerResult(r, formatListWindows)
  },
  "computer get-app-state": { inv in
    let observe = try inv.computerObserveFlags()
    let target = try inv.computerTarget()
    let r = try inv.call("computer.getAppState", target + observe)
    try inv.printComputerResult(r, formatGetAppState)
  },
  "computer click": computerActionHandler("click", "click") { inv throws(CliError) in
    let modifiers: String?
    switch inv.flags["modifiers"] {
    case .string(let value)?: modifiers = value
    default: modifiers = nil
    }
    let elementIndex = try inv.optNonNegativeInt("element-index")
    let x = try inv.optNumber("x")
    let y = try inv.optNumber("y")
    let clickCount = try inv.optPositiveInt("click-count")
    let mouseButton = try inv.optString("mouse-button")
    guard isValidElementOrCoordinates(elementIndex, x, y) else { throw .needsNode }
    if let mouseButton, mouseButton != "left" && mouseButton != "right" && mouseButton != "middle" {
      throw .needsNode
    }
    if let modifiers, !isASCII(modifiers) || !isValidClickModifiers(modifiers) { throw .needsNode }
    return [
      ("elementIndex", elementIndex.json), ("x", x), ("y", y), ("clickCount", clickCount.json),
      ("mouseButton", mouseButton.json), ("modifiers", modifiers.json),
    ]
  },
  "computer scroll": computerActionHandler("scroll", "scroll") { inv throws(CliError) in
    let elementIndex = try inv.optNonNegativeInt("element-index")
    let x = try inv.optNumber("x")
    let y = try inv.optNumber("y")
    let direction = try inv.reqString("direction")
    let pages = try inv.optNumber("pages")
    if case .number(let raw)? = pages, raw.hasPrefix("-") || raw == "0" { throw .needsNode }
    guard isValidElementOrCoordinates(elementIndex, x, y),
      ["up", "down", "left", "right"].contains(direction)
    else { throw .needsNode }
    return [("elementIndex", elementIndex.json), ("x", x), ("y", y), ("direction", .str(direction)), ("pages", pages)]
  },
  "computer press-key": computerActionHandler("press-key", "pressKey") { inv throws(CliError) in
    let key = try inv.reqString("key")
    guard isASCII(key), isValidPressKey(key) else { throw .needsNode }
    return [("key", .str(key))]
  },
  "computer hotkey": computerActionHandler("hotkey", "hotkey") { inv throws(CliError) in
    let key = try inv.reqString("key")
    guard isASCII(key), isValidHotkey(key) else { throw .needsNode }
    return [("key", .str(key))]
  },
  "computer type-text": computerActionHandler("type-text", "typeText") { inv throws(CliError) in
    if inv.flags.has("text-stdin") { throw .needsNode }
    return [("text", .str(try inv.reqString("text")))]
  },
  "computer paste-text": computerActionHandler("paste-text", "pasteText") { inv throws(CliError) in
    if inv.flags.has("text-stdin") { throw .needsNode }
    return [("text", .str(try inv.reqString("text")))]
  },
  "computer set-value": computerActionHandler("set-value", "setValue") { inv throws(CliError) in
    guard let elementIndex = try inv.optNonNegativeInt("element-index") else { throw .needsNode }
    if inv.flags.has("value-stdin") { throw .needsNode }
    return [("elementIndex", .int(elementIndex)), ("value", .str(try inv.reqStringAllowingEmpty("value")))]
  },
]

func isValidElementOrCoordinates(_ elementIndex: Int?, _ x: JSONValue?, _ y: JSONValue?) -> Bool {
  let hasElement = elementIndex != nil
  let hasX = x != nil
  let hasY = y != nil
  if !hasElement && !(hasX && hasY) { return false }
  if hasX != hasY { return false }
  return !(hasElement && (hasX || hasY))
}

// MARK: - JSON screenshot export (prepareComputerCliJsonResult)

let COMPUTER_SCREENSHOT_TTL_MS: Int64 = 24 * 60 * 60 * 1000
let COMPUTER_SCREENSHOT_CLEANUP_INTERVAL_MS: Int64 = 60 * 60 * 1000

extension Invocation {
  func printComputerResult(_ response: JSONObject, _ format: (JSONValue?) -> String) throws(CliError) {
    if json {
      out.log(bytes: JSONValue.object(prepareComputerJson(response)).stringify())
    } else {
      out.log(format(response["result"]))
    }
  }
}

func prepareComputerJson(_ response: JSONObject) -> JSONObject {
  guard case .object(var result)? = response["result"], result.has("screenshotStatus"),
    case .object(var screenshot)? = result["screenshot"],
    case .string(let data)? = screenshot["data"], !data.raw.isEmpty
  else { return response }
  guard let dir = computerScreenshotTempDir() else { return response }
  cleanupComputerScreenshots(dir)
  let ext = screenshot["format"].isString("png") ? "png" : "img"
  let id = response["id"]?.stringValue?.string ?? ""
  let path = dir + "/" + safeCliFileStem(id) + "-screenshot." + ext
  guard writeFileExclusive(path, decodeBase64Lenient(data.raw), mode: 0o600) else { return response }
  screenshot.entries.removeAll { $0.key.equals("data") }
  screenshot.set("path", .str(path))
  screenshot.set("dataOmitted", .bool(true))
  screenshot.set("expiresAt", .str(isoTimestamp(epochMs() + COMPUTER_SCREENSHOT_TTL_MS)))
  result.set("screenshot", .object(screenshot))
  var out = response
  out.set("result", .object(result))
  return out
}

func computerScreenshotTempDir() -> String? {
  let dir: String
  if let override = env("ORCA_COMPUTER_SCREENSHOT_TMPDIR"), !override.isEmpty {
    dir = override
  } else {
    dir = nodeTmpdir() + "/orca-computer-use"
  }
  guard mkdirRecursive(dir, 0o700) else { return nil }
  var st = stat()
  guard lstat(dir, &st) == 0, (st.st_mode & S_IFMT) == S_IFDIR, st.st_uid == getuid() else { return nil }
  chmod(dir, 0o700)
  return dir
}

/// mkdirSync(dir, { recursive: true, mode }).
func mkdirRecursive(_ dir: String, _ mode: mode_t) -> Bool {
  if mkdir(dir, mode) == 0 || errno == EEXIST { return true }
  guard errno == ENOENT else { return false }
  let parent = parentDirectory(dir)
  guard parent != dir, !parent.isEmpty, mkdirRecursive(parent, mode) else { return false }
  return mkdir(dir, mode) == 0 || errno == EEXIST
}

/// os.tmpdir(): $TMPDIR without its trailing slash, else /tmp.
func nodeTmpdir() -> String {
  var value = env("TMPDIR") ?? ""
  if value.isEmpty { value = env("TMP") ?? "" }
  if value.isEmpty { value = env("TEMP") ?? "" }
  if value.isEmpty { return "/tmp" }
  while value.count > 1 && value.hasSuffix("/") { value.removeLast() }
  return value
}

func cleanupComputerScreenshots(_ dir: String) {
  let now = epochMs()
  let marker = dir + "/.last-cleanup"
  var st = stat()
  if stat(marker, &st) == 0 {
    let mtimeMs = Int64(st.st_mtimespec.tv_sec) * 1000 + Int64(st.st_mtimespec.tv_nsec) / 1_000_000
    if mtimeMs > now - COMPUTER_SCREENSHOT_CLEANUP_INTERVAL_MS { return }
  }
  let cutoff = now - COMPUTER_SCREENSHOT_TTL_MS
  if let handle = opendir(dir) {
    while let entry = readdir(handle) {
      let name = withUnsafePointer(to: entry.pointee.d_name) {
        $0.withMemoryRebound(to: CChar.self, capacity: Int(entry.pointee.d_namlen) + 1) {
          String(decoding: UnsafeBufferPointer(start: UnsafeRawPointer($0).assumingMemoryBound(to: UInt8.self), count: Int(entry.pointee.d_namlen)), as: UTF8.self)
        }
      }
      guard name.hasSuffix("-screenshot.png") || name.hasSuffix("-screenshot.img") else { continue }
      let path = dir + "/" + name
      var fileStat = stat()
      if stat(path, &fileStat) == 0 {
        let mtimeMs = Int64(fileStat.st_mtimespec.tv_sec) * 1000 + Int64(fileStat.st_mtimespec.tv_nsec) / 1_000_000
        if mtimeMs < cutoff { unlink(path) }
      }
    }
    closedir(handle)
  }
  _ = writeFileExclusive(marker, Array("\(now)\n".utf8), mode: 0o600)
}

/// writeFileSync(path, bytes, { mode }): truncate-or-create; mode applies only on creation.
func writeFileExclusive(_ path: String, _ bytes: [UInt8], mode: mode_t) -> Bool {
  let fd = open(path, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, mode)
  guard fd >= 0 else { return false }
  defer { close(fd) }
  var offset = 0
  while offset < bytes.count {
    let n = bytes[offset...].withUnsafeBytes { write(fd, $0.baseAddress, $0.count) }
    if n < 0 {
      if errno == EINTR { continue }
      return false
    }
    offset += n
  }
  return true
}

func safeCliFileStem(_ value: String) -> String {
  String(decoding: value.utf8.map { c in
    (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) || c == 0x2E || c == 0x5F || c == 0x2D ? c : 0x5F
  }, as: UTF8.self)
}

/// Buffer.from(s, 'base64'): standard and URL-safe alphabets, other bytes skipped, stops at '='.
func decodeBase64Lenient(_ raw: [UInt8]) -> [UInt8] {
  var out: [UInt8] = []
  out.reserveCapacity(raw.count * 3 / 4)
  var acc: UInt32 = 0
  var bits = 0
  for c in raw {
    let v: UInt32
    switch c {
    case 0x41...0x5A: v = UInt32(c - 0x41)
    case 0x61...0x7A: v = UInt32(c - 0x61 + 26)
    case 0x30...0x39: v = UInt32(c - 0x30 + 52)
    case 0x2B, 0x2D: v = 62
    case 0x2F, 0x5F: v = 63
    case 0x3D: return out
    default: continue
    }
    acc = acc << 6 | v
    bits += 6
    if bits >= 8 {
      bits -= 8
      out.append(UInt8((acc >> UInt32(bits)) & 0xFF))
    }
  }
  return out
}

func epochMs() -> Int64 {
  var ts = timespec()
  clock_gettime(CLOCK_REALTIME, &ts)
  return Int64(ts.tv_sec) * 1000 + Int64(ts.tv_nsec) / 1_000_000
}

/// Date.prototype.toISOString for a ms timestamp.
func isoTimestamp(_ ms: Int64) -> String {
  var seconds = time_t(ms / 1000)
  var tm = tm()
  gmtime_r(&seconds, &tm)
  func pad(_ v: Int32, _ n: Int) -> String {
    let s = String(v)
    return String(repeating: "0", count: max(0, n - s.count)) + s
  }
  return "\(pad(tm.tm_year + 1900, 4))-\(pad(tm.tm_mon + 1, 2))-\(pad(tm.tm_mday, 2))T\(pad(tm.tm_hour, 2)):\(pad(tm.tm_min, 2)):\(pad(tm.tm_sec, 2)).\(pad(Int32(ms % 1000), 3))Z"
}

// MARK: - Formatters (computer-format.ts)

func formatGetAppState(_ v: JSONValue?) -> String {
  let snapshot = v["snapshot"]
  let app = snapshot["app"]
  let window = snapshot["window"]
  let bundle = app["bundleId"].truthy ? ", \(app["bundleId"].templateString)" : ""
  let focused = snapshot["focusedElementId"].isNull ? "none" : "#\(snapshot["focusedElementId"].templateString)"
  let windowId = window["id"].isNullish ? "" : " id:\(window["id"].templateString)"
  let windowIndex = window["index"].isNullish ? "" : " index:\(window["index"].templateString)"
  let origin = window["x"].isNullish || window["y"].isNullish ? "" : " @ \(window["x"].templateString),\(window["y"].templateString)"
  let truncation = snapshot["truncation"]["truncated"].truthy
    ? "  Truncated: yes (max nodes \(snapshot["truncation"]["maxNodes"].nullish("unknown")), max depth \(snapshot["truncation"]["maxDepth"].nullish("unknown")))"
    : "  Truncated: no"
  return [
    "\(app["name"].templateString) (pid \(app["pid"].templateString)\(bundle))",
    "  Window:\(windowId)\(windowIndex) \"\(window["title"].templateString)\" (\(window["width"].templateString)x\(window["height"].templateString)\(origin))",
    "  Visible elements: \(snapshot["elementCount"].templateString)  Focused: \(focused)  Coordinates: \(snapshot["coordinateSpace"].templateString)",
    truncation,
    "  \(formatComputerScreenshotStatus(v))",
    "",
    snapshot["treeText"].templateString,
  ].joined(separator: "\n")
}

func formatComputerScreenshotStatus(_ v: JSONValue?) -> String {
  let status = v["screenshotStatus"]
  let screenshot = v["screenshot"]
  if status["state"].isString("captured") && screenshot.truthy {
    let bytes = screenshot["data"].truthy
      ? base64PayloadByteCount(screenshot["data"])
      : "saved to \(screenshot["path"].nullish("temporary file"))"
    let dimensions = "\(screenshot["width"].templateString)x\(screenshot["height"].templateString)"
    var scaleDetail = ""
    if case .number(let raw)? = screenshot["scale"], let scale = Double(raw), scale > 0, scale != 1 {
      let text = formatComputerScreenshotScale(raw, scale)
      scaleDetail = ", scale \(text); coordinate x/y = screenshot pixels / \(text)"
    }
    let engine = status["metadata"]["engine"]
    let format = screenshot["format"].templateString
    return engine.truthy
      ? "Screenshot captured (\(format), \(bytes), \(dimensions)\(scaleDetail), \(engine.templateString))"
      : "Screenshot captured (\(format), \(bytes), \(dimensions)\(scaleDetail))"
  }
  if status["state"].isString("skipped") { return "Screenshot skipped (--no-screenshot)" }
  if status["state"].isString("failed") {
    return "Screenshot failed (\(status["code"].templateString)): \(status["message"].templateString)"
  }
  return "Screenshot was not captured"
}

func formatComputerScreenshotScale(_ raw: String, _ scale: Double) -> String {
  if scale == scale.rounded() { return raw }
  var text = jsToFixed(scale, 3)
  while text.hasSuffix("0") { text.removeLast() }
  if text.hasSuffix(".") { text.removeLast() }
  return text
}

/// Number.prototype.toFixed: n / 10^digits nearest to x, ties to the larger n.
func jsToFixed(_ x: Double, _ digits: Int) -> String {
  let negative = x < 0
  let magnitude = abs(x)
  var factor: UInt64 = 1
  for _ in 0..<digits { factor *= 10 }
  let significand = magnitude.significandBitPattern | (magnitude.exponentBitPattern == 0 ? 0 : 1 << 52)
  let exponent = Int(magnitude.exponentBitPattern == 0 ? -1074 : Int(magnitude.exponentBitPattern) - 1075)
  let scaled = significand.multipliedReportingOverflow(by: factor)
  var n: UInt64
  if scaled.overflow || exponent > 10 {
    n = UInt64((magnitude * Double(factor)).rounded(.toNearestOrAwayFromZero))
  } else if exponent >= 0 {
    n = scaled.partialValue << UInt64(exponent)
  } else if -exponent >= 64 {
    n = 0
  } else {
    let shift = UInt64(-exponent)
    n = scaled.partialValue >> shift
    let remainder = scaled.partialValue & ((1 << shift) - 1)
    if remainder >= (1 << (shift - 1)) { n += 1 }
  }
  var text = String(n)
  if text.count <= digits { text = String(repeating: "0", count: digits + 1 - text.count) + text }
  let split = text.index(text.endIndex, offsetBy: -digits)
  let body = digits > 0 ? text[..<split] + "." + text[split...] : Substring(text)
  return (negative && n != 0 ? "-" : (negative ? "-" : "")) + body
}

func formatListApps(_ v: JSONValue?) -> String {
  let apps = v["apps"].arrayValue ?? []
  if apps.isEmpty { return "No apps found." }
  return apps.map { app in
    let bundle = app["bundleId"].truthy ? "  \(app["bundleId"].templateString)" : ""
    return "\(app["name"].templateString)  pid:\(app["pid"].templateString)\(bundle)"
  }.joined(separator: "\n")
}

func formatListWindows(_ v: JSONValue?) -> String {
  let windows = v["windows"].arrayValue ?? []
  if windows.isEmpty { return "No windows found for \(v["app"]["name"].templateString)." }
  return windows.map { w in
    let id = w["id"].isNullish ? "none" : w["id"].templateString
    let origin = w["x"].isNullish || w["y"].isNullish ? "" : " @ \(w["x"].templateString),\(w["y"].templateString)"
    let screen = w["screenIndex"].isNullish ? "" : " screen:\(w["screenIndex"].templateString)"
    var state: [String] = []
    if w["isMinimized"].truthy { state.append("minimized") }
    if w["isOffscreen"].truthy { state.append("offscreen") }
    let stateText = state.isEmpty ? "" : " \(state.joined(separator: ","))"
    return "[\(w["index"].templateString)] id:\(id) \"\(w["title"].templateString)\" (\(w["width"].templateString)x\(w["height"].templateString)\(origin))\(screen)\(stateText)"
  }.joined(separator: "\n")
}

func formatComputerCapabilities(_ v: JSONValue?) -> String {
  let supports = v["supports"]
  let actions = (supports["actions"]?.objectValue?.entries ?? []).filter { Optional($0.value).truthy }.map { $0.key.string }
  return [
    "\(v["provider"].templateString) (\(v["platform"].templateString), protocol \(v["protocolVersion"].templateString))",
    "  Apps: list=\(supports["apps"]["list"].templateString) bundleIds=\(supports["apps"]["bundleIds"].templateString) pids=\(supports["apps"]["pids"].templateString)",
    "  Windows: list=\(supports["windows"]["list"].templateString) targetById=\(supports["windows"]["targetById"].templateString) targetByIndex=\(supports["windows"]["targetByIndex"].templateString)",
    "  Observation: screenshot=\(supports["observation"]["screenshot"].templateString) elementFrames=\(supports["observation"]["elementFrames"].templateString) annotatedScreenshot=\(supports["observation"]["annotatedScreenshot"].templateString)",
    "  Actions: \(actions.joined(separator: ", "))",
  ].joined(separator: "\n")
}

let UNVERIFIED_ACTION_REASONS: [String: String] = [
  "accessibility": "accessibility action unasserted",
  "clipboard": "clipboard paste",
  "synthetic": "synthetic input",
]

func formatComputerAction(_ verb: String, _ v: JSONValue?, _ target: JSONObject) -> String {
  let action = v["action"]
  let path = action["path"].truthy ? " via \(action["path"].templateString)" : ""
  let verification = formatActionVerification(action)
  let followUp = formatComputerFollowUpCommand(v, target)
  let unverified = !action["verification"]["state"].isString("verified")
  let outcome = unverified ? "attempted" : "completed"
  let status = v["screenshotStatus"]
  let screenshotFailure = status["state"].isString("failed")
    ? " Screenshot failed (\(status["code"].templateString)): \(status["message"].templateString)." : ""
  let inspectTail = unverified
    ? "Inspect with the command above or use the --json result before assuming it worked."
    : "Use the --json result or rerun state before choosing the next element index."
  return "\(formatActionVerb(verb)) \(outcome)\(path)\(verification); \(v["snapshot"]["elementCount"].templateString) visible elements in current window.\(screenshotFailure) Use `\(followUp)` to inspect. \(inspectTail)"
}

func formatActionVerification(_ action: JSONValue?) -> String {
  guard let action, action.truthy else { return ", unverified (verification metadata unavailable)" }
  let verification = action["verification"]
  guard verification.truthy else {
    return ", unverified (\(UNVERIFIED_ACTION_REASONS[action["path"].templateString] ?? "undefined"))"
  }
  if verification["state"].isString("verified") {
    return ", verified \(verification["property"].templateString)"
  }
  return ", unverified (\(verification["reason"].templateString.replacingUnderscores()))"
}

extension String {
  func replacingUnderscores() -> String { String(map { $0 == "_" ? " " : $0 }) }
}

func formatComputerFollowUpCommand(_ v: JSONValue?, _ target: JSONObject) -> String {
  let snapshot = v["snapshot"]
  let action = v["action"]
  let appName = snapshot["app"]["bundleId"].isNullish ? snapshot["app"]["name"] : snapshot["app"]["bundleId"]
  var args = ["orca", "computer", "get-app-state", "--app", quoteCliCommandArgument(appName.templateString)]
  if case .string(let session)? = target["session"], !session.raw.isEmpty {
    args += ["--session", quoteCliCommandArgument(session.string)]
  } else if case .string(let worktree)? = target["worktree"], !worktree.raw.isEmpty {
    args += ["--worktree", quoteCliCommandArgument(worktree.string)]
  }
  let windowChanged = action["verification"]["state"].isString("unverified")
    && action["verification"]["reason"].isString("window_changed")
  if !windowChanged, let windowId = target["windowId"] {
    args += ["--window-id", Optional(windowId).templateString]
  } else if !windowChanged, let windowIndex = target["windowIndex"] {
    args += ["--window-index", Optional(windowIndex).templateString]
  } else {
    let windowId = action["targetWindowId"].isNullish ? snapshot["window"]["id"] : action["targetWindowId"]
    let windowIndex = action["targetWindowIndex"].isNullish ? snapshot["window"]["index"] : action["targetWindowIndex"]
    if !windowId.isNullish {
      args += ["--window-id", windowId.templateString]
    } else if !windowIndex.isNullish {
      args += ["--window-index", windowIndex.templateString]
    }
  }
  if target["restoreWindow"].truthy { args.append("--restore-window") }
  return args.joined(separator: " ")
}

/// quoteCliCommandArgument on a POSIX host.
func quoteCliCommandArgument(_ value: String) -> String {
  let plain = !value.isEmpty && value.utf8.allSatisfy { c in
    (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A)
      || c == 0x2E || c == 0x5F || c == 0x3A || c == 0x2F || c == 0x40 || c == 0x2D
  }
  if plain { return value }
  var out = "'"
  for ch in value {
    if ch == "'" { out += "'\\''" } else { out.append(ch) }
  }
  return out + "'"
}

func formatActionVerb(_ verb: String) -> String {
  verb.split(separator: "-", omittingEmptySubsequences: false).map { part in
    guard let first = part.first else { return "" }
    return first.uppercased() + part.dropFirst()
  }.joined(separator: " ")
}
