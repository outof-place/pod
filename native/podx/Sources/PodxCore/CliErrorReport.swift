// Port of src/cli/cli-error.ts for the errors the native client can raise after a request
// was sent: runtime failures (RuntimeRpcFailureError) and transport errors (RuntimeClientError).

public struct CliErrorContext {
  public let commandPath: [String]
  public let worktreeSelector: String?

  public init(commandPath: [String], worktreeSelector: String?) {
    self.commandPath = commandPath
    self.worktreeSelector = worktreeSelector
  }
}

public struct ConsoleOutput {
  public var stdout: [UInt8] = []
  public var stderr: [UInt8] = []
  public var exitCode: Int32 = 0

  public init() {}

  /// console.log(text)
  public mutating func log(_ text: String) {
    stdout += Array(text.utf8)
    stdout.append(0x0A)
  }

  public mutating func log(bytes: [UInt8]) {
    stdout += bytes
    stdout.append(0x0A)
  }

  /// console.error(text)
  public mutating func error(_ text: String) {
    stderr += Array(text.utf8)
    stderr.append(0x0A)
  }
}

struct ErrorView {
  let code: String
  let message: String
  let data: JSONValue?
  /// The failure envelope for RuntimeRpcFailureError; nil for a local RuntimeClientError.
  let response: JSONObject?

  init(_ error: CliError) {
    switch error {
    case .needsNode:
      preconditionFailure("needsNode is never reported")
    case .client(let code, let message, let data):
      self.code = code
      self.message = message
      self.data = data.map(redactSecrets)
      self.response = nil
    case .rpcFailure(let response):
      let errorObject = response["error"]?.objectValue
      self.code = errorObject?["code"]?.stringValue?.string ?? ""
      self.message = errorObject?["message"]?.stringValue?.string ?? ""
      self.data = errorObject?["data"]
      self.response = response
    }
  }
}

public func reportCliError(_ error: CliError, json: Bool, context: CliErrorContext, into out: inout ConsoleOutput) {
  let view = ErrorView(error)
  let selector = selectorRecovery(view.code, context)
  if json {
    if var response = view.response {
      response = withAutomationOwnerConflictRecovery(response)
      if let selector, var errorObject = response["error"]?.objectValue {
        errorObject.set("data", mergeSelectorRecovery(errorObject["data"], selector))
        response.set("error", .object(errorObject))
      }
      out.log(bytes: JSONValue.object(response).stringify())
    } else {
      var errorObject = JSONObject()
      errorObject.set("code", .str(matchAutomationOwnerConflict(view) ?? view.code))
      errorObject.set("message", .str(stripAutomationOwnerConflictCode(view.message)))
      if let data = localCliErrorData(view, selector: selector, context: context) {
        errorObject.set("data", data)
      }
      var response = JSONObject()
      response.set("id", .str("local"))
      response.set("ok", .bool(false))
      response.set("error", .object(errorObject))
      response.set("_meta", .object(JSONObject([(JSONString("runtimeId"), .null)])))
      out.log(bytes: JSONValue.object(response).stringify())
    }
  } else {
    out.error(formatCliError(view, selector: selector, context: context))
  }
  out.exitCode = 1
}

func formatCliError(_ view: ErrorView, selector: JSONValue?, context: CliErrorContext) -> String {
  if let selector {
    return formatMessageWithNextSteps(view.message, nextStepsFromData(mergeSelectorRecovery(view.data, selector)))
  }
  if view.code == "runtime_unavailable" {
    if case .string? = view.data?["orchestrationRequestId"] {
      return view.message
    }
    return "\(view.message)\nOrca is not running. Run 'orca open' first."
  }
  if let code = matchAutomationOwnerConflict(view), let steps = conflictRecovery(code) {
    return formatMessageWithNextSteps(stripAutomationOwnerConflictCode(view.message), steps)
  }
  let steps = nextStepsFromData(view.data)
  if !steps.isEmpty {
    return formatMessageWithNextSteps(view.message, steps)
  }
  if view.code == "invalid_argument" && context.commandPath.first == "computer" {
    return formatMessageWithNextSteps(view.message, COMPUTER_INVALID_ARGUMENT_NEXT_STEPS)
  }
  return view.message
}

func formatMessageWithNextSteps(_ message: String, _ steps: [String]) -> String {
  if steps.isEmpty { return message }
  return message + "\n" + steps.map { "Next step: \($0)" }.joined(separator: "\n")
}

func nextStepsFromData(_ data: JSONValue?) -> [String] {
  guard let steps = data?["nextSteps"]?.arrayValue else { return [] }
  return steps.compactMap { $0.stringValue?.string }
}

func selectorRecovery(_ code: String, _ context: CliErrorContext) -> JSONValue? {
  guard code == "selector_not_found", let selector = context.worktreeSelector, !selector.isEmpty else {
    return nil
  }
  return worktreeSelectorRecovery(selector)
}

let SELECTOR_PREFIXES = ["id:", "path:", "name:", "branch:", "identity:", "issue:"]

func worktreeSelectorRecovery(_ selector: String) -> JSONValue {
  var suggestions: [String]
  if selector.hasPrefix("id:") {
    suggestions = containsSubsequence(selector, "::") ? [] : ["id:\(selector.dropFirst(3))::<absolute-path>", "path:<absolute-path>"]
  } else if SELECTOR_PREFIXES.contains(where: { selector.hasPrefix($0) }) {
    suggestions = []
  } else if selector.hasPrefix("/") || isWindowsDrivePath(selector) {
    suggestions = ["path:\(selector)"]
  } else {
    suggestions = ["id:\(selector)::<absolute-path>", "name:\(selector)", "branch:\(selector)"]
  }
  var nextSteps = ["No Orca workspace matched the worktree selector \"\(selector)\"."]
  if !suggestions.isEmpty {
    nextSteps.append("Did you mean: \(suggestions.joined(separator: ", "))")
  }
  nextSteps.append("Valid selector forms: \(WORKTREE_SELECTOR_FORMS.joined(separator: ", ")).")
  nextSteps.append("List the exact values with `orca worktree list --json`; a bare repository id is not a worktree id.")
  var object = JSONObject()
  object.set("selector", .str(selector))
  object.set("validSelectorForms", .array(WORKTREE_SELECTOR_FORMS.map { .str($0) }))
  object.set("suggestions", .array(suggestions.map { .str($0) }))
  object.set("nextSteps", .array(nextSteps.map { .str($0) }))
  return .object(object)
}

func isWindowsDrivePath(_ s: String) -> Bool {
  let u = Array(s.utf8.prefix(3))
  guard u.count == 3 else { return false }
  let letter = (u[0] >= 0x41 && u[0] <= 0x5A) || (u[0] >= 0x61 && u[0] <= 0x7A)
  return letter && u[1] == 0x3A && (u[2] == 0x5C || u[2] == 0x2F)
}

func mergeSelectorRecovery(_ data: JSONValue?, _ selector: JSONValue) -> JSONValue {
  guard let data, case .object(let dataObject) = data, var merged = selector.objectValue else {
    return selector
  }
  for entry in dataObject.entries {
    merged.set(entry.key.string, entry.value)
  }
  let steps = nextStepsFromData(selector) + nextStepsFromData(data)
  merged.set("nextSteps", .array(steps.map { .str($0) }))
  return .object(merged)
}

func localCliErrorData(_ view: ErrorView, selector: JSONValue?, context: CliErrorContext) -> JSONValue? {
  if let data = view.data {
    return selector.map { mergeSelectorRecovery(data, $0) } ?? data
  }
  if let selector { return selector }
  if let code = matchAutomationOwnerConflict(view), let steps = conflictRecovery(code) {
    return .object(JSONObject([(JSONString("nextSteps"), .array(steps.map { .str($0) }))]))
  }
  return nil
}

// MARK: - Automation owner conflicts (src/shared/automation-owner-conflict.ts)

func conflictRecovery(_ code: String) -> [String]? {
  AUTOMATION_OWNER_CONFLICT_RECOVERY.first(where: { $0.code == code })?.nextSteps
}

func matchAutomationOwnerConflict(_ view: ErrorView) -> String? {
  for row in AUTOMATION_OWNER_CONFLICT_RECOVERY {
    if view.code == row.code || endsWithCodeToken(view.message, row.code) {
      return row.code
    }
  }
  return nil
}

func withAutomationOwnerConflictRecovery(_ response: JSONObject) -> JSONObject {
  guard var errorObject = response["error"]?.objectValue else { return response }
  let code = errorObject["code"]?.stringValue?.string ?? ""
  let message = errorObject["message"]?.stringValue?.string ?? ""
  guard let match = AUTOMATION_OWNER_CONFLICT_RECOVERY.first(where: { code == $0.code || endsWithCodeToken(message, $0.code) })
  else { return response }
  errorObject.set("code", .str(match.code))
  errorObject.set("message", .str(stripAutomationOwnerConflictCode(message)))
  if errorObject["data"] == nil {
    errorObject.set("data", .object(JSONObject([(JSONString("nextSteps"), .array(match.nextSteps.map { .str($0) }))])))
  }
  var out = response
  out.set("error", .object(errorObject))
  return out
}

func stripAutomationOwnerConflictCode(_ message: String) -> String {
  let trimmed = jsTrimEnd(message)
  for row in AUTOMATION_OWNER_CONFLICT_RECOVERY {
    let suffix = ": \(row.code)"
    if trimmed.hasSuffix(suffix) {
      return String(trimmed.dropLast(suffix.count))
    }
  }
  return message
}

func endsWithCodeToken(_ text: String, _ code: String) -> Bool {
  let trimmed = jsTrimEnd(text)
  guard trimmed.hasSuffix(code) else { return false }
  let prefix = String(trimmed.dropLast(code.count))
  if jsTrim(prefix).isEmpty { return true }
  // CODE_TOKEN_BOUNDARY = /(?:: |\n)[ \t]*$/
  var tail = Substring(prefix)
  while true {
    if tail.hasSuffix(": ") || tail.hasSuffix("\n") { return true }
    guard let last = tail.last, last == " " || last == "\t" else { return false }
    tail = tail.dropLast()
  }
}

func isJSWhitespace(_ c: Character) -> Bool {
  for scalar in c.unicodeScalars {
    switch scalar.value {
    case 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
      continue
    default:
      return false
    }
  }
  return true
}

func jsTrimEnd(_ s: String) -> String {
  var end = s.endIndex
  while end > s.startIndex {
    let before = s.index(before: end)
    if !isJSWhitespace(s[before]) { break }
    end = before
  }
  return String(s[..<end])
}

func jsTrim(_ s: String) -> String {
  let tail = jsTrimEnd(s)
  return String(tail.drop(while: isJSWhitespace))
}

func containsSubsequence(_ s: String, _ needle: String) -> Bool {
  let hay = Array(s.utf8)
  let n = Array(needle.utf8)
  guard hay.count >= n.count else { return false }
  for i in 0...(hay.count - n.count) where hay[i..<(i + n.count)].elementsEqual(n) {
    return true
  }
  return false
}
