import PodxCore

// Ports of the read-side handlers in src/cli/handlers/terminal.ts and terminal-format.ts.

let DEFAULT_TERMINAL_WAIT_RPC_TIMEOUT_MS = 5 * 60 * 1000

extension Invocation {
  /// getTerminalHandle: explicit --terminal, else the active terminal of the cwd's worktree.
  func terminalHandle() throws(CliError) -> String {
    if let explicit = try optString("terminal") {
      return explicit
    }
    _ = try optString("worktree")
    let worktree = try browserWorktreeSelector()
    let r = try call("terminal.resolveActive", [("worktree", worktree.json)], readOnly: true)
    let result: JSONValue? = r["result"]
    return result["handle"].templateString
  }

  func optWorktreeSelector(_ name: String) throws(CliError) -> String? {
    guard let value = try optString(name) else { return nil }
    if value == "active" || value == "current" {
      return try resolveCurrentWorktreeSelector()
    }
    return try normalizeWorktreeSelector(value)
  }
}

let TERMINAL_HANDLERS: [String: Handler] = [
  "terminal read": { inv in
    let cursorFlag = try inv.optString("cursor")
    var cursor: Int?
    if let cursorFlag {
      let digits = Array(cursorFlag.utf8)
      guard digits.count <= 15, digits.allSatisfy({ $0 >= 0x30 && $0 <= 0x39 }) else { throw CliError.needsNode }
      cursor = Int(cursorFlag)
    }
    let screen = inv.flags["screen"] == .bool
    if screen && cursorFlag != nil { throw CliError.needsNode }
    _ = try inv.optString("terminal")
    let limit = try inv.optPositiveInt("limit")
    let terminal = try inv.terminalHandle()
    var params: [(String, JSONValue?)] = [("terminal", .str(terminal))]
    if let cursor { params.append(("cursor", .int(cursor))) }
    if screen { params.append(("screen", .bool(true))) }
    params.append(("limit", limit.json))
    let r = try inv.call("terminal.read", params)
    if screen, r["result"]?["terminal"]?["source"] == nil {
      throw CliError.client(
        code: "incompatible_runtime",
        message: "This Orca host does not support --screen reads, so it answered with accumulated output instead of the rendered screen. Update Orca on the host, or drop --screen to read accumulated output deliberately.",
        data: nil)
    }
    inv.printResult(r, bytes: formatTerminalRead)
  },
  "terminal wait": { inv in
    let timeoutMs = try inv.optPositiveInt("timeout-ms")
    let condition = try inv.reqString("for")
    _ = try inv.optString("terminal")
    let terminal = try inv.terminalHandle()
    let r = try inv.call(
      "terminal.wait", [("terminal", .str(terminal)), ("for", .str(condition)), ("timeoutMs", timeoutMs.json)],
      timeoutMs: timeoutMs.map { $0 + 5000 } ?? DEFAULT_TERMINAL_WAIT_RPC_TIMEOUT_MS)
    inv.printResult(r, formatTerminalWait)
    if case .bool(false)? = r["result"]?["wait"]?["satisfied"] {
      inv.out.exitCode = 1
    }
  },
  "terminal list": { inv in
    let limit = try inv.optPositiveInt("limit")
    _ = try inv.optString("worktree")
    let worktree = try inv.optWorktreeSelector("worktree")
    let includeVisualLayouts = !inv.json || inv.flags.has("include-visual-layouts")
    let r = try inv.call(
      "terminal.list",
      [("worktree", worktree.json), ("limit", limit.json), ("includeVisualLayouts", .bool(includeVisualLayouts))],
      readOnly: true)
    // Why: omitted hosts are annotated from the local pairing store and SSH registry; Node does that.
    if let omitted = r["result"]?["hostScope"]?["omittedHostIds"]?.arrayValue, !omitted.isEmpty {
      throw CliError.needsNode
    }
    inv.printResult(r, formatTerminalList)
  },
  "terminal show": { inv in
    _ = try inv.optString("terminal")
    let terminal = try inv.terminalHandle()
    let r = try inv.call("terminal.show", [("terminal", .str(terminal))], readOnly: true)
    inv.printResult(r, formatTerminalShow)
  },
]

func formatTerminalRead(_ v: JSONValue?) -> [UInt8] {
  let t = v["terminal"]
  var header: [String] = ["handle: \(t["handle"].templateString)", "status: \(t["status"].templateString)"]
  if (t["source"]).truthy { header.append("source: \(t["source"].templateString)") }
  if let draft = t["draft"], draft.truthy {
    header.append("draft: " + String(decoding: draft.stringify(indent: nil), as: UTF8.self))
  }
  if !t["nextCursor"].isNull { header.append("cursor: \(t["nextCursor"].templateString)") }
  if (t["oldestCursor"]).isString { header.append("oldest cursor: \(t["oldestCursor"].templateString)") }
  if (t["latestCursor"]).isString { header.append("latest cursor: \(t["latestCursor"].templateString)") }
  if (t["truncated"]).truthy { header.append("warning: older output is no longer retained") }
  if let limited = terminalReadLimitedWarning(t) { header.append(limited) }
  if t["source"].isString("screen-unavailable") {
    header.append("warning: no rendered screen was available, so this is accumulated output; repainted lines may appear as stacked fragments")
  }
  var out: [UInt8] = []
  for line in header {
    out += Array(line.utf8)
    out.append(0x0A)
  }
  // [...header, '', ...tail].join('\n')
  for line in t["tail"].arrayValue ?? [] {
    out.append(0x0A)
    switch line {
    case .string(let s): out += s.utf8
    case .null: break
    default: out += Array(line.templateString.utf8)
    }
  }
  return out
}

func terminalReadLimitedWarning(_ t: JSONValue?) -> String? {
  guard (t["limited"]).truthy else { return nil }
  let next = t["nextCursor"]?.stringValue
  let latest = t["latestCursor"]?.stringValue
  let oldest = t["oldestCursor"]?.stringValue
  if let next, let latest, next != latest {
    return "warning: output limited; continue with --cursor \(next.string)"
  }
  if let oldest, let latest, oldest != latest {
    return "warning: output limited; page retained output with --cursor \(oldest.string) --limit <count>"
  }
  return "warning: output limited"
}

func formatTerminalWait(_ v: JSONValue?) -> String {
  let w = v["wait"]
  var lines = [
    "handle: \(w["handle"].templateString)",
    "condition: \(w["condition"].templateString)",
    "satisfied: \(w["satisfied"].templateString)",
    "status: \(w["status"].templateString)",
    "exitCode: \(w["exitCode"].nullish("null"))",
  ]
  if let reason = w["blockedReason"], reason.truthy {
    lines.append("blockedReason: \(describeTerminalWaitBlockedReason(reason.templateString))")
  }
  return lines.joined(separator: "\n")
}

let LEGACY_CODEX_REASON_ALIASES: [String: String] = [
  "codex-update-prompt": "agent-update-prompt",
  "codex-trust-workspace": "agent-trust-workspace",
  "codex-cwd-prompt": "agent-cwd-prompt",
  "codex-hooks-review-prompt": "agent-hooks-review-prompt",
  "codex-interactive-prompt": "agent-interactive-prompt",
]

func describeTerminalWaitBlockedReason(_ reason: String) -> String {
  guard let neutral = LEGACY_CODEX_REASON_ALIASES[reason] else { return reason }
  return "\(reason) (\(neutral))"
}

func formatTerminalShow(_ v: JSONValue?) -> String {
  let t = v["terminal"]
  let preview = t["preview"]
  return [
    "handle: \(t["handle"].templateString)",
    "title: \(t["title"].nullish("(untitled)"))",
    "worktree: \(t["worktreePath"].templateString)",
    "branch: \(t["branch"].templateString)",
    "leaf: \(t["leafId"].templateString)",
    "ptyId: \(t["ptyId"].nullish("none"))",
    "connected: \(t["connected"].templateString)",
    "writable: \(t["writable"].templateString)",
    "agentWait: \(formatAgentWait(t["agentWait"]))",
    "preview: \(preview.truthy ? preview.templateString : "<empty>")",
  ].joined(separator: "\n")
}

func formatAgentWait(_ agentWait: JSONValue?) -> String {
  guard let agentWait else { return "unknown (not evaluated)" }
  if !agentWait.truthy { return "none" }
  let reason = agentWait["reason"]
  if !reason.truthy {
    return "interactive prompt (via \(agentWait["source"].templateString))"
  }
  return "\(describeTerminalWaitBlockedReason(reason.templateString)) (via \(agentWait["source"].templateString))"
}

func formatTerminalList(_ v: JSONValue?) -> String {
  let scope = formatListingHostScope(v["hostScope"])
  let terminals = v["terminals"].arrayValue ?? []
  if terminals.isEmpty {
    return "No terminals listed.\n\(scope)"
  }
  let body = terminals.map { t in
    let preview = t["preview"]
    return "\(t["handle"].templateString)  \(t["title"].nullish("(untitled)"))  \(t["connected"].truthy ? "connected" : "disconnected")  host=\(t["executionHostId"].nullish("unverifiable"))  \(t["worktreePath"].templateString)\n\(preview.truthy ? "preview: \(preview.templateString)" : "preview: <empty>")"
  }.joined(separator: "\n\n")
  let layout = formatTerminalVisualLayouts(v["visualLayouts"])
  let bodyWithLayout = layout.map { "\(body)\n\nvisual layout:\n\($0)" } ?? body
  let bodyWithScope = "\(bodyWithLayout)\n\n\(scope)"
  if (v["truncated"]).truthy {
    return "\(bodyWithScope)\ntruncated: showing \(terminals.count) of \(v["totalCount"].templateString)"
  }
  return bodyWithScope
}

func formatTerminalVisualLayouts(_ layouts: JSONValue?) -> String? {
  guard let items = layouts?.arrayValue, !items.isEmpty else { return nil }
  return items.map { layout in
    let path = layout["worktreePath"]
    let header = "worktree: \(path.truthy ? path.templateString : layout["worktreeId"].templateString)"
    return ([header] + formatVisualLayoutNode(layout["root"], 0)).joined(separator: "\n")
  }.joined(separator: "\n\n")
}

func indentOf(_ depth: Int) -> String { String(repeating: "  ", count: depth) }

func formatVisualLayoutNode(_ node: JSONValue?, _ depth: Int) -> [String] {
  let indent = indentOf(depth)
  if node["type"].isString("split") {
    return ["\(indent)split \(node["direction"].templateString)"]
      + formatVisualLayoutNode(node["first"], depth + 1)
      + formatVisualLayoutNode(node["second"], depth + 1)
  }
  let tabs = node["tabs"].arrayValue ?? []
  return ["\(indent)group \(node["groupId"].nullish("(default)"))"]
    + tabs.flatMap { tab in
      ["\(indentOf(depth + 1))tab \(tab["tabId"].templateString)  \(tab["title"].nullish("(untitled)"))"]
        + formatVisualPaneNode(tab["panes"], depth + 2)
    }
}

func formatVisualPaneNode(_ node: JSONValue?, _ depth: Int) -> [String] {
  let indent = indentOf(depth)
  if node["type"].isString("pane-split") {
    return ["\(indent)pane split \(node["direction"].templateString)"]
      + formatVisualPaneNode(node["first"], depth + 1)
      + formatVisualPaneNode(node["second"], depth + 1)
  }
  let marker = (node["active"]).truthy ? "* " : "  "
  return [
    "\(indent)\(marker)\(node["handle"].templateString)  \(node["title"].nullish("(untitled)"))  tab=\(node["tabId"].templateString) leaf=\(node["leafId"].templateString)"
  ]
}

/// formatListingHostScope for a scope with no omitted hosts (others go to Node).
func formatListingHostScope(_ scope: JSONValue?) -> String {
  guard let scope, scope.isObject else {
    return "scope: unverifiable — this host does not report which hosts it lists"
  }
  let hostIds = scope["hostIds"]?.arrayValue ?? []
  let covered = hostIds.isEmpty ? "none" : jsJoin(hostIds, ", ")
  return "scope: \(covered)"
}
