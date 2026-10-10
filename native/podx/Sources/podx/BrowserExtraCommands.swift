import PodxCore

// Ports of the remaining one-call browser handlers in browser-env.ts and browser-interact.ts.

extension Invocation {
  /// getRequiredFiniteNumber for canonical spellings.
  func reqNumber(_ name: String) throws(CliError) -> JSONValue {
    guard let value = try optNumber(name), case .string? = flags[name] else { throw .needsNode }
    return value
  }

  func reqPositiveNumber(_ name: String) throws(CliError) -> JSONValue {
    let value = try reqNumber(name)
    if case .number(let raw) = value, raw.hasPrefix("-") || raw == "0" { throw .needsNode }
    return value
  }

  func optPositiveNumberString(_ name: String) throws(CliError) -> JSONValue? {
    guard let raw = try optString(name) else { return nil }
    guard isCanonicalDecimal(raw), !raw.hasPrefix("-"), raw != "0" else { throw .needsNode }
    return .number(raw)
  }
}

func targetHandler(
  _ method: String, _ params: @escaping @Sendable (Invocation) throws(CliError) -> [(String, JSONValue?)],
  timeoutMs: Int? = nil, _ format: @escaping @Sendable (Invocation, JSONValue?) -> String
) -> Handler {
  { inv in
    let own = try params(inv)
    try inv.checkBrowserTargetFlags()
    let r = try inv.call(method, own + (try inv.browserCommandTarget()), timeoutMs: timeoutMs)
    inv.printResult(r) { v in format(inv, v) }
  }
}

func stringOrStringify(_ v: JSONValue?) -> String {
  if case .string(let s)? = v { return s.string }
  return String(decoding: stringifyResult(v), as: UTF8.self)
}

let BROWSER_EXTRA_HANDLERS: [String: Handler] = [
  "viewport": targetHandler("browser.viewport", { inv throws(CliError) in
    var params: [(String, JSONValue?)] = [("width", try inv.reqPositiveNumber("width")), ("height", try inv.reqPositiveNumber("height"))]
    if let scale = try inv.optPositiveNumberString("scale") { params.append(("deviceScaleFactor", scale)) }
    if inv.flags.has("mobile") { params.append(("mobile", .bool(true))) }
    return params
  }) { _, v in "Viewport set to \(v["width"].templateString)×\(v["height"].templateString)\(v["mobile"].truthy ? " (mobile)" : "")" },
  "set device": targetHandler("browser.setDevice", { inv throws(CliError) in [("name", .str(try inv.reqString("name")))] }) {
    inv, _ in "Device emulation set to \((try? inv.reqString("name")) ?? "")"
  },
  "set offline": targetHandler("browser.setOffline", { inv throws(CliError) in [("state", try inv.optString("state").json)] }) {
    inv, _ in "Offline mode \(((try? inv.optString("state")) ?? nil) ?? "toggled")"
  },
  "set headers": targetHandler("browser.setHeaders", { inv throws(CliError) in [("headers", .str(try inv.reqString("headers")))] }) {
    _, _ in "Extra HTTP headers set"
  },
  "set credentials": targetHandler("browser.setCredentials", { inv throws(CliError) in
    [("user", .str(try inv.reqString("user"))), ("pass", .str(try inv.reqStringAllowingEmpty("pass")))]
  }) { inv, _ in "HTTP auth credentials set for \((try? inv.reqString("user")) ?? "")" },
  "set media": targetHandler("browser.setMedia", { inv throws(CliError) in
    [("colorScheme", try inv.optString("color-scheme").json), ("reducedMotion", try inv.optString("reduced-motion").json)]
  }) { _, _ in "Media preferences set" },
  "mouse move": targetHandler("browser.mouseMove", { inv throws(CliError) in
    [("x", try inv.reqNumber("x")), ("y", try inv.reqNumber("y"))]
  }) { inv, _ in "Mouse moved to \(inv.flagText("x")),\(inv.flagText("y"))" },
  "mouse down": targetHandler("browser.mouseDown", { inv throws(CliError) in [("button", try inv.optString("button").json)] }) {
    inv, _ in "Mouse button \(((try? inv.optString("button")) ?? nil) ?? "left") pressed"
  },
  "mouse up": targetHandler("browser.mouseUp", { inv throws(CliError) in [("button", try inv.optString("button").json)] }) {
    inv, _ in "Mouse button \(((try? inv.optString("button")) ?? nil) ?? "left") released"
  },
  "mouse wheel": targetHandler("browser.mouseWheel", { inv throws(CliError) in
    [("dy", try inv.reqNumber("dy")), ("dx", try inv.optNumber("dx"))]
  }) { inv, _ in
    let dx = (try? inv.optNumber("dx")) ?? nil
    return "Mouse wheel scrolled dy=\(inv.flagText("dy"))\(dx != nil ? " dx=\(inv.flagText("dx"))" : "")"
  },
  "scrollintoview": targetHandler("browser.scrollIntoView", { inv throws(CliError) in [("element", .str(try inv.reqString("element")))] }) {
    inv, _ in "Scrolled \(inv.flagText("element")) into view"
  },
  "get": targetHandler("browser.get", { inv throws(CliError) in
    [("what", .str(try inv.reqString("what"))), ("selector", try inv.optString("element").json)]
  }) { _, v in stringOrStringify(v) },
  "is": targetHandler("browser.is", { inv throws(CliError) in
    [("what", .str(try inv.reqString("what"))), ("selector", .str(try inv.reqString("element")))]
  }) { _, v in v.templateString },
  "inserttext": targetHandler("browser.keyboardInsertText", { inv throws(CliError) in [("text", .str(try inv.reqString("text")))] }) {
    _, _ in "Text inserted"
  },
  "select": targetHandler("browser.select", { inv throws(CliError) in
    [("element", .str(try inv.reqString("element"))), ("value", .str(try inv.reqString("value")))]
  }) { _, v in "Selected \(v["selected"].templateString)" },
  "check": targetHandler("browser.check", { inv throws(CliError) in
    [("element", .str(try inv.reqString("element"))), ("checked", .bool(true))]
  }) { inv, v in v["checked"].truthy ? "Checked \(inv.flagText("element"))" : "Unchecked \(inv.flagText("element"))" },
  "uncheck": targetHandler("browser.check", { inv throws(CliError) in
    [("element", .str(try inv.reqString("element"))), ("checked", .bool(false))]
  }) { inv, v in v["checked"].truthy ? "Checked \(inv.flagText("element"))" : "Unchecked \(inv.flagText("element"))" },
  "highlight": targetHandler("browser.highlight", { inv throws(CliError) in [("selector", .str(try inv.reqString("selector")))] }) {
    inv, _ in "Highlighted \(inv.flagText("selector"))"
  },
  "clipboard read": targetHandler("browser.clipboardRead", { _ throws(CliError) in [] }) { _, v in
    String(decoding: stringifyResult(v), as: UTF8.self)
  },
  "clipboard write": targetHandler("browser.clipboardWrite", { inv throws(CliError) in [("text", .str(try inv.reqString("text")))] }) {
    _, _ in "Clipboard updated"
  },
  "dialog accept": targetHandler("browser.dialogAccept", { inv throws(CliError) in [("text", try inv.optString("text").json)] }) {
    _, _ in "Dialog accepted"
  },
  "dialog dismiss": targetHandler("browser.dialogDismiss", { _ throws(CliError) in [] }) { _, _ in "Dialog dismissed" },
]

extension Invocation {
  /// A flag value already validated by the handler's params closure.
  func flagText(_ name: String) -> String {
    if case .string(let value)? = flags[name] { return value }
    return ""
  }
}
