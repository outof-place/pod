import Darwin

// Port of src/cli/runtime/transport.ts + client.ts for the local owner socket: one NDJSON
// request per connection, keepalive frames refresh the timer, the zod envelope is mirrored.

public enum CliError: Error {
  /// Nothing irreversible happened yet; the Node CLI can redo the command from scratch.
  case needsNode
  /// RuntimeClientError(code, message, data).
  case client(code: String, message: String, data: JSONValue?)
  /// RuntimeRpcFailureError: the stripped, redacted failure envelope.
  case rpcFailure(JSONObject)
}

public struct RuntimeMetadata {
  public let runtimeId: String?
  public let pid: Int?
  public let endpoint: String
  public let authToken: String
}

public func userDataPath() -> String {
  if let path = env("ORCA_USER_DATA_PATH"), !path.isEmpty {
    return path
  }
  // Why: the bash launcher defaulted ORCA_USER_DATA_PATH to Pod's profile before Node ran.
  return (env("HOME") ?? "") + "/Library/Application Support/" + PRODUCT_USER_DATA_NAME
}

public func readRuntimeMetadata(_ userData: String) throws(CliError) -> RuntimeMetadata {
  guard let bytes = readFile(userData + "/orca-runtime.json"),
    let root = try? parseJSON(bytes), let object = root.objectValue
  else { throw .needsNode }
  var endpoint: String?
  if let transports = object["transports"]?.arrayValue {
    for transport in transports {
      guard let kind = transport["kind"]?.stringValue else { continue }
      if kind.equals("unix") || kind.equals("named-pipe") {
        guard kind.equals("unix"), let value = transport["endpoint"]?.stringValue else {
          throw .needsNode
        }
        endpoint = value.string
        break
      }
    }
  } else {
    throw .needsNode
  }
  guard let endpoint, let token = object["authToken"]?.stringValue, !token.raw.isEmpty else {
    throw .needsNode
  }
  var pid: Int?
  if case .number(let raw)? = object["pid"] { pid = Int(raw) }
  return RuntimeMetadata(
    runtimeId: object["runtimeId"]?.stringValue?.string, pid: pid, endpoint: endpoint,
    authToken: token.string)
}

public final class RuntimeClient {
  public let userData: String
  public let requestTimeoutMs: Int
  /// Set once a non-read-only request reached the runtime; falling back to Node would repeat it.
  public private(set) var sentMutation = false

  public init(userData: String = userDataPath(), requestTimeoutMs: Int = 60_000) {
    self.userData = userData
    self.requestTimeoutMs = requestTimeoutMs
  }

  /// RuntimeClient.call for a method whose recovery wrapping is the identity (no durable mutation).
  public func call(
    _ method: String, _ params: JSONValue?, timeoutMs: Int? = nil, readOnly: Bool = false
  ) throws(CliError) -> JSONObject {
    let metadata: RuntimeMetadata
    do {
      metadata = try readRuntimeMetadata(userData)
    } catch {
      if sentMutation { throw .client(code: "runtime_unavailable", message: "Could not read Orca runtime metadata at \(userData)/orca-runtime.json. Start the Orca app first.", data: nil) }
      throw .needsNode
    }
    let response = try sendRequest(metadata, method, params, timeoutMs ?? requestTimeoutMs, readOnly: readOnly)
    if case .bool(false)? = response["ok"] {
      throw .rpcFailure(response)
    }
    return response
  }

  /// transport.sendRequest: the stripped envelope whether ok or not; throws transport errors.
  public func send(_ metadata: RuntimeMetadata, _ method: String, _ params: JSONValue?, timeoutMs: Int) throws(CliError) -> JSONObject {
    try sendRequest(metadata, method, params, timeoutMs, readOnly: true, fallbackOnConnectFailure: false)
  }

  func sendRequest(
    _ metadata: RuntimeMetadata, _ method: String, _ params: JSONValue?, _ timeoutMs: Int, readOnly: Bool,
    fallbackOnConnectFailure: Bool = true
  ) throws(CliError) -> JSONObject {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { throw sentMutation ? connectError() : .needsNode }
    defer { close(fd) }
    var on: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))

    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    let pathBytes = Array(metadata.endpoint.utf8)
    let capacity = MemoryLayout.size(ofValue: addr.sun_path)
    guard pathBytes.count < capacity else { throw sentMutation ? connectError() : .needsNode }
    withUnsafeMutableBytes(of: &addr.sun_path) { raw in
      raw.copyBytes(from: pathBytes)
      raw[pathBytes.count] = 0
    }
    let connected = withUnsafePointer(to: &addr) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
      }
    }
    guard connected == 0 else {
      // Why: a sandbox denial gets Node's runtime_access_denied wording and pid check.
      if errno == EPERM || errno == EACCES { throw .needsNode }
      throw sentMutation || !fallbackOnConnectFailure ? connectError() : .needsNode
    }

    let requestId = randomUUID()
    var request = JSONObject()
    request.set("id", .str(requestId))
    request.set("authToken", .str(metadata.authToken))
    request.set("method", .str(method))
    if let params { request.set("params", params) }
    var line = JSONValue.object(request).stringify(indent: nil)
    line.append(0x0A)
    let wrote = line.withUnsafeBytes { buffer -> Bool in
      var offset = 0
      while offset < buffer.count {
        let n = write(fd, buffer.baseAddress! + offset, buffer.count - offset)
        if n < 0 {
          if errno == EINTR { continue }
          return false
        }
        offset += n
      }
      return true
    }
    if !readOnly { sentMutation = true }
    guard wrote else { throw connectError() }

    var pending: [UInt8] = []
    var chunk = [UInt8](repeating: 0, count: 256 << 10)
    var deadline = monotonicMs() + Int64(timeoutMs)
    while true {
      var scan = 0
      while let nl = pending[scan...].firstIndex(of: 0x0A) {
        let frame = Array(pending[scan..<nl])
        scan = nl + 1
        if frame.allSatisfy({ $0 == 0x20 || $0 == 0x09 || $0 == 0x0D }) { continue }
        guard let value = try? parseJSON(frame) else { throw invalidFrame() }
        if case .bool(true)? = value["_keepalive"] {
          deadline = monotonicMs() + Int64(timeoutMs)
          continue
        }
        let response = try stripEnvelope(value)
        guard let id = response["id"]?.stringValue, id.equals(requestId) else {
          throw .client(code: "invalid_runtime_response", message: "The Orca runtime returned a mismatched response id.", data: nil)
        }
        if let runtimeId = response["_meta"]?["runtimeId"]?.stringValue, !runtimeId.raw.isEmpty,
          !runtimeId.equals(metadata.runtimeId ?? "\u{0}")
        {
          throw .client(code: "runtime_unavailable", message: "The Orca runtime changed while the request was in flight. Retry the command.", data: nil)
        }
        return response
      }
      if scan > 0 { pending.removeFirst(scan) }

      let remaining = deadline - monotonicMs()
      if remaining <= 0 {
        throw .client(code: "runtime_timeout", message: "Timed out waiting for the Orca runtime to respond.", data: nil)
      }
      var pfd = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
      let ready = poll(&pfd, 1, Int32(min(remaining, Int64(Int32.max))))
      if ready < 0 {
        if errno == EINTR { continue }
        throw connectError()
      }
      if ready == 0 { continue }
      let n = chunk.withUnsafeMutableBytes { read(fd, $0.baseAddress, $0.count) }
      if n < 0 {
        if errno == EINTR || errno == EAGAIN { continue }
        throw connectError()
      }
      if n == 0 {
        throw .client(code: "runtime_unavailable", message: "The Orca runtime closed the connection before responding. Restart Orca and try again.", data: nil)
      }
      pending.append(contentsOf: chunk[0..<n])
    }
  }

  private func connectError() -> CliError {
    .client(code: "runtime_unavailable", message: "Could not connect to the running Orca app. Restart Orca and try again.", data: nil)
  }

  private func invalidFrame() -> CliError {
    .client(code: "invalid_runtime_response", message: "The Orca runtime returned an invalid response frame.", data: nil)
  }

  /// RuntimeRpcEnvelopeSchema.safeParse(...).data, then RuntimeRpcFailureError's redaction.
  private func stripEnvelope(_ value: JSONValue) throws(CliError) -> JSONObject {
    guard let object = value.objectValue, case .string(let id)? = object["id"] else { throw invalidFrame() }
    switch object["ok"] {
    case .bool(true)?:
      guard let meta = object["_meta"]?.objectValue, case .string(let runtimeId)? = meta["runtimeId"] else {
        throw invalidFrame()
      }
      var out = JSONObject()
      out.set("id", .string(id))
      out.set("ok", .bool(true))
      if let result = object["result"] { out.set("result", result) }
      out.set("_meta", .object(JSONObject([(JSONString("runtimeId"), .string(runtimeId))])))
      return out
    case .bool(false)?:
      guard let error = object["error"]?.objectValue, case .string(let code)? = error["code"],
        case .string(let message)? = error["message"]
      else { throw invalidFrame() }
      var strippedError = JSONObject()
      strippedError.set("code", .string(code))
      strippedError.set("message", .string(message))
      if let data = error["data"] { strippedError.set("data", redactSecrets(data)) }
      var out = JSONObject()
      out.set("id", .string(id))
      out.set("ok", .bool(false))
      out.set("error", .object(strippedError))
      if let meta = object["_meta"] {
        guard let metaObject = meta.objectValue else { throw invalidFrame() }
        switch metaObject["runtimeId"] {
        case .string(let runtimeId)?:
          out.set("_meta", .object(JSONObject([(JSONString("runtimeId"), .string(runtimeId))])))
        case .null?:
          out.set("_meta", .object(JSONObject([(JSONString("runtimeId"), .null)])))
        default: throw invalidFrame()
        }
      }
      return out
    default:
      throw invalidFrame()
    }
  }
}

/// redactOrchestrationCompatibilitySecrets.
public func redactSecrets(_ value: JSONValue) -> JSONValue {
  switch value {
  case .array(let items): return .array(items.map(redactSecrets))
  case .object(let object):
    return .object(JSONObject(object.entries.map { entry in
      (entry.key, SECRET_KEYS.contains(entry.key.string) ? .str("[redacted]") : redactSecrets(entry.value))
    }))
  default: return value
  }
}
