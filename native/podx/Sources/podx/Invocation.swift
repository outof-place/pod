import PodxCore

// HandlerContext plus the Node CLI's flag accessors. An accessor that would throw in Node
// throws .needsNode instead, so the Node CLI reports that error in its own words.

final class Invocation {
  let commandPath: [String]
  let flags: Flags
  let client: RuntimeClient
  let cwd: String
  let json: Bool
  var out = ConsoleOutput()

  init(commandPath: [String], flags: Flags, client: RuntimeClient, cwd: String, json: Bool) {
    self.commandPath = commandPath
    self.flags = flags
    self.client = client
    self.cwd = cwd
    self.json = json
  }

  func optString(_ name: String) throws(CliError) -> String? {
    switch flags[name] {
    case nil: return nil
    case .bool?: throw CliError.needsNode
    case .string(let value)?: return value.isEmpty ? nil : value
    }
  }

  func reqString(_ name: String) throws(CliError) -> String {
    guard let value = try optString(name) else { throw CliError.needsNode }
    return value
  }

  /// getOptionalPositiveIntegerFlag for plain decimal spellings; anything else is Node's call.
  func optPositiveInt(_ name: String) throws(CliError) -> Int? {
    guard let value = try optRawNumber(name) else { return nil }
    guard value > 0 else { throw CliError.needsNode }
    return value
  }

  func optNonNegativeInt(_ name: String) throws(CliError) -> Int? {
    try optRawNumber(name)
  }

  private func optRawNumber(_ name: String) throws(CliError) -> Int? {
    switch flags[name] {
    case nil: return nil
    case .bool?: throw CliError.needsNode
    case .string(let value)?:
      if value.isEmpty { return nil }
      let digits = Array(value.utf8)
      guard digits.count <= 15, digits.allSatisfy({ $0 >= 0x30 && $0 <= 0x39 }),
        digits.count == 1 || digits[0] != 0x30, let number = Int(value)
      else { throw CliError.needsNode }
      return number
    }
  }

  func call(
    _ method: String, _ params: [(String, JSONValue?)], timeoutMs: Int? = nil, readOnly: Bool = false
  ) throws(CliError) -> JSONObject {
    try client.call(method, .object(paramsObject(params)), timeoutMs: timeoutMs, readOnly: readOnly)
  }

  /// printResult: the whole stripped envelope with --json, the formatter's text otherwise.
  func printResult(_ response: JSONObject, _ format: (JSONValue?) -> String) {
    if json {
      out.log(bytes: JSONValue.object(response).stringify())
    } else {
      out.log(format(response["result"]))
    }
  }

  func printResult(_ response: JSONObject, bytes format: (JSONValue?) -> [UInt8]) {
    if json {
      out.log(bytes: JSONValue.object(response).stringify())
    } else {
      out.log(bytes: format(response["result"]))
    }
  }
}

/// An object literal whose undefined members JSON.stringify drops.
func paramsObject(_ params: [(String, JSONValue?)]) -> JSONObject {
  var object = JSONObject()
  for (key, value) in params {
    if let value { object.set(key, value) }
  }
  return object
}

extension Optional where Wrapped == String {
  var json: JSONValue? { map { .str($0) } }
}

extension Optional where Wrapped == Int {
  var json: JSONValue? { map { .int($0) } }
}
