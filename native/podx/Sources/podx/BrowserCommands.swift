import PodxCore

// Ports of src/cli/handlers/browser-nav.ts, browser-interact.ts, browser-tab.ts and the
// formatters in browser-format.ts they print with.

typealias Handler = @Sendable (Invocation) throws -> Void

let DEFAULT_BROWSER_WAIT_RPC_TIMEOUT_MS = 60_000

let BROWSER_HANDLERS: [String: Handler] = [
  "snapshot": { inv in
    try inv.checkBrowserTargetFlags()
    let r = try inv.call("browser.snapshot", try inv.browserCommandTarget())
    inv.printResult(r) { v in
      "page: \(v["browserPageId"].templateString)\n\(v["title"].templateString) — \(v["url"].templateString)\n"
        + (v["snapshot"].templateString)
    }
  },
  "screenshot": { inv in
    let format = try inv.optString("format")
    try inv.checkBrowserTargetFlags()
    let r = try inv.call("browser.screenshot", [("format", format == "jpeg" ? .str("jpeg") : nil)] + (try inv.browserCommandTarget()))
    inv.printResult(r) { v in
      "Screenshot captured (\(v["format"].templateString), \(base64PayloadByteCount(v["data"])))"
    }
  },
  "goto": { inv in
    let url = try inv.reqString("url")
    try inv.checkBrowserTargetFlags()
    let r = try inv.call("browser.goto", [("url", .str(url))] + (try inv.browserCommandTarget()), timeoutMs: 60_000)
    inv.printResult(r) { v in "Navigated to \(v["url"].templateString) — \(v["title"].templateString)" }
  },
  "back": navHandler("browser.back", timeoutMs: nil) { v in "Back to \(v["url"].templateString) — \(v["title"].templateString)" },
  "reload": navHandler("browser.reload", timeoutMs: 60_000) { v in "Reloaded \(v["url"].templateString) — \(v["title"].templateString)" },
  "forward": navHandler("browser.forward", timeoutMs: nil) { v in
    let url = v["url"]
    return url.truthy ? "Navigated forward to \(url.templateString)" : "Navigated forward"
  },
  "eval": { inv in
    let expression = try inv.reqString("expression")
    try inv.checkBrowserTargetFlags()
    let r = try inv.call("browser.eval", [("expression", .str(expression))] + (try inv.browserCommandTarget()))
    try inv.printConsoleLogValue(r, r["result"]?["result"])
  },
  "scroll": { inv in
    let direction = try inv.reqString("direction")
    guard direction == "up" || direction == "down" else { throw CliError.needsNode }
    let amount = try inv.optPositiveInt("amount")
    try inv.checkBrowserTargetFlags()
    let r = try inv.call(
      "browser.scroll", [("direction", .str(direction)), ("amount", amount.json)] + (try inv.browserCommandTarget()))
    inv.printResult(r) { v in "Scrolled \(v["scrolled"].templateString)" }
  },
  "wait": { inv in
    let selector = try inv.optString("selector")
    let timeout = try inv.optPositiveInt("timeout")
    let text = try inv.optString("text")
    let url = try inv.optString("url")
    let load = try inv.optString("load")
    let fn = try inv.optString("fn")
    let state = try inv.optString("state")
    try inv.checkBrowserTargetFlags()
    let params: [(String, JSONValue?)] = [
      ("selector", selector.json), ("timeout", timeout.json), ("text", text.json), ("url", url.json),
      ("load", load.json), ("fn", fn.json), ("state", state.json),
    ]
    let r = try inv.call(
      "browser.wait", params + (try inv.browserCommandTarget()),
      timeoutMs: timeout.map { $0 + 5000 } ?? DEFAULT_BROWSER_WAIT_RPC_TIMEOUT_MS)
    inv.printResult(r, bytes: { v in stringifyResult(v) })
  },
  "click": elementHandler("browser.click") { v, _ in "Clicked \(v["clicked"].templateString)" },
  "dblclick": elementHandler("browser.dblclick") { _, element in "Double-clicked \(element)" },
  "focus": elementHandler("browser.focus") { v, _ in "Focused \(v["focused"].templateString)" },
  "clear": elementHandler("browser.clear") { v, _ in "Cleared \(v["cleared"].templateString)" },
  "select-all": elementHandler("browser.selectAll") { v, _ in "Selected all in \(v["selected"].templateString)" },
  "hover": elementHandler("browser.hover") { v, _ in "Hovered \(v["hovered"].templateString)" },
  "fill": { inv in
    let element = try inv.reqString("element")
    let value = try inv.reqString("value")
    try inv.checkBrowserTargetFlags()
    let r = try inv.call("browser.fill", [("element", .str(element)), ("value", .str(value))] + (try inv.browserCommandTarget()))
    inv.printResult(r) { v in "Filled \(v["filled"].templateString)" }
  },
  "type": { inv in
    let input = try inv.reqString("input")
    try inv.checkBrowserTargetFlags()
    let r = try inv.call("browser.type", [("input", .str(input))] + (try inv.browserCommandTarget()))
    inv.printResult(r) { _ in "Typed input" }
  },
  "keypress": { inv in
    let key = try inv.reqString("key")
    try inv.checkBrowserTargetFlags()
    let r = try inv.call("browser.keypress", [("key", .str(key))] + (try inv.browserCommandTarget()))
    inv.printResult(r) { v in "Pressed \(v["pressed"].templateString)" }
  },
  "tab list": { inv in
    _ = try inv.optString("worktree")
    let r = try inv.call("browser.tabList", [("worktree", try inv.browserWorktreeSelector().json)])
    let showProfile = inv.flags.has("show-profile")
    inv.printResult(r) { v in formatTabList(v, showProfile: showProfile) }
  },
  "tab show": { inv in
    try inv.checkBrowserTargetFlags()
    let r = try inv.call("browser.tabShow", try inv.browserCommandTarget())
    inv.printResult(r, formatTabShow)
  },
  "tab current": { inv in
    _ = try inv.optString("worktree")
    let r = try inv.call("browser.tabCurrent", [("worktree", try inv.browserWorktreeSelector().json)])
    inv.printResult(r, formatTabShow)
  },
  "tab switch": { inv in
    let index = try inv.optNonNegativeInt("index")
    let page = try inv.optString("page")
    if index == nil && page == nil { throw CliError.needsNode }
    try inv.checkBrowserTargetFlags()
    var params: [(String, JSONValue?)] = [("index", index.json), ("page", page.json)]
    if inv.flags.has("focus") { params.append(("focus", .bool(true))) }
    let r = try inv.call("browser.tabSwitch", params + (try inv.browserCommandTarget()))
    inv.printResult(r) { v in
      "Switched to tab \(v["switched"].templateString) (\(v["browserPageId"].templateString))"
    }
  },
  "tab create": { inv in
    let url = try inv.optString("url")
    let profile = try inv.optString("profile")
    _ = try inv.optString("worktree")
    let worktree = try inv.browserWorktreeSelector()
    let r = try inv.call(
      "browser.tabCreate", [("url", url.json), ("worktree", worktree.json), ("profileId", profile.json)],
      timeoutMs: 60_000)
    inv.printResult(r) { v in "Created tab \(v["browserPageId"].templateString)" }
  },
  "tab close": { inv in
    let index = try inv.optNonNegativeInt("index")
    try inv.checkBrowserTargetFlags()
    let r = try inv.call("browser.tabClose", [("index", index.json)] + (try inv.browserCommandTarget()))
    inv.printResult(r) { _ in "Tab closed" }
  },
  "open-url": { inv in
    let url = try inv.reqString("url")
    _ = try inv.optString("worktree")
    let worktree = try inv.browserWorktreeSelector()
    let r = try inv.call("browser.openUrl", [("url", .str(url)), ("worktree", worktree.json)], timeoutMs: 60_000)
    inv.printResult(r) { v in "Opened URL in tab \(v["browserPageId"].templateString)" }
  },
  "exec": { inv in
    let command = try inv.reqString("command")
    try inv.checkBrowserTargetFlags()
    let r = try inv.call("browser.exec", [("command", .str(command))] + (try inv.browserCommandTarget()))
    inv.printResult(r, bytes: { v in stringifyResult(v) })
  },
]

func navHandler(_ method: String, timeoutMs: Int?, _ format: @escaping @Sendable (JSONValue?) -> String) -> Handler {
  { inv in
    try inv.checkBrowserTargetFlags()
    let r = try inv.call(method, try inv.browserCommandTarget(), timeoutMs: timeoutMs)
    inv.printResult(r, format)
  }
}

func elementHandler(_ method: String, _ format: @escaping @Sendable (JSONValue?, String) -> String) -> Handler {
  { inv in
    let element = try inv.reqString("element")
    try inv.checkBrowserTargetFlags()
    let r = try inv.call(method, [("element", .str(element))] + (try inv.browserCommandTarget()))
    inv.printResult(r) { v in format(v, element) }
  }
}

/// JSON.stringify(v, null, 2); JSON.stringify(undefined) is undefined, which console.log prints.
func stringifyResult(_ value: JSONValue?) -> [UInt8] {
  guard let value else { return Array("undefined".utf8) }
  return value.stringify()
}

extension Invocation {
  /// console.log(value) for a value typed string; other primitives print as util.inspect does.
  func printConsoleLogValue(_ response: JSONObject, _ value: JSONValue?) throws(CliError) {
    if json {
      out.log(bytes: JSONValue.object(response).stringify())
      return
    }
    switch value {
    case .string(let s)?: out.log(bytes: s.utf8)
    case .number(let raw)?: out.log(raw)
    case .bool(let b)?: out.log(b ? "true" : "false")
    case .null?: out.log("null")
    case nil: out.log("undefined")
    case .array?, .object?:
      // util.inspect formatting is not ported; the eval contract returns strings.
      out.log(bytes: value!.stringify(indent: nil))
    }
  }
}

/// formatBase64PayloadByteCount: Buffer.byteLength(base64, 'base64').
func base64PayloadByteCount(_ value: JSONValue?) -> String {
  guard case .string(let s)? = value else { return "NaN bytes" }
  var bytes = s.utf16Count
  if bytes > 0, s.raw.last == 0x3D { bytes -= 1 }
  if bytes > 1, s.raw.count >= 2, s.raw[s.raw.count - 2] == 0x3D, s.raw.last == 0x3D { bytes -= 1 }
  return "\(UInt32(truncatingIfNeeded: bytes * 3) >> 2) bytes"
}

func formatTabList(_ v: JSONValue?, showProfile: Bool) -> String {
  let tabs = v["tabs"].arrayValue ?? []
  if tabs.isEmpty { return "No browser tabs open." }
  return tabs.map { t in
    let marker = t["active"].truthy ? "* " : "  "
    let profile = showProfile ? "  [\(t["profileLabel"].isNullish ? t["profileId"].nullish("Unknown") : t["profileLabel"].templateString)]" : ""
    return "\(marker)[\(t["index"].templateString)] \(t["browserPageId"].templateString)  \(t["title"].templateString) — \(t["url"].templateString)\(profile)"
  }.joined(separator: "\n")
}

func formatTabShow(_ v: JSONValue?) -> String {
  let tab = v["tab"]
  let profile = tab["profileLabel"].isNullish ? tab["profileId"].nullish("unknown") : tab["profileLabel"].templateString
  return [
    "page: \(tab["browserPageId"].templateString)",
    "title: \(tab["title"].templateString)",
    "url: \(tab["url"].templateString)",
    "active: \(tab["active"].templateString)",
    "worktree: \(tab["worktreeId"].nullish("unknown"))",
    "profile: \(profile)",
  ].joined(separator: "\n")
}
