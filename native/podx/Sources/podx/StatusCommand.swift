import Darwin
import PodxCore

// Port of `status` (handlers/core.ts) over runtime/status.ts getCliStatus for a local runtime.

let STATUS_HANDLERS: [String: Handler] = [
  "status": { inv in
    // Why: an agent session adds orchestration.callerShow and its refusal mapping; Node owns that.
    if envSet("ORCA_AGENT_SESSION_ID") { throw CliError.needsNode }
    let status = try cliStatus(inv.client)
    let reachable = status["runtime"]["reachable"].truthy
    if !inv.json && !reachable {
      inv.out.exitCode = 1
    }
    var envelope = JSONObject()
    envelope.set("id", .str("local-status"))
    envelope.set("ok", .bool(true))
    envelope.set("result", status)
    let runtimeId = status["runtime"]["runtimeId"]
    envelope.set("_meta", .object(JSONObject([(JSONString("runtimeId"), runtimeId.isNullish ? .str("none") : runtimeId!)])))
    inv.printResult(envelope, formatCliStatus)
  }
]

func cliStatus(_ client: RuntimeClient) throws(CliError) -> JSONValue {
  let userData = client.userData
  guard let bytes = readFile(userData + "/orca-runtime.json") else {
    return statusResult(running: false, pid: .null, runtime: notRunningRuntime(stale: false), graph: "not_running")
  }
  guard let parsed = try? parseJSON(bytes) else {
    return statusResult(running: false, pid: .null, runtime: notRunningRuntime(stale: false), graph: "not_running")
  }
  guard case .object(let metadata) = parsed else {
    if case .null = parsed {
      return statusResult(running: false, pid: .null, runtime: notRunningRuntime(stale: false), graph: "not_running")
    }
    throw CliError.needsNode
  }
  guard metadata["transports"]?.arrayValue != nil else { throw CliError.needsNode }
  let runtimeMetadata: RuntimeMetadata
  do {
    runtimeMetadata = try readRuntimeMetadata(userData)
  } catch {
    // Missing unix transport or token: the file exists, so Orca ran at some point.
    if hasUsableTransportShape(metadata) { throw CliError.needsNode }
    return statusResult(running: false, pid: .null, runtime: notRunningRuntime(stale: true), graph: "not_running")
  }
  let pidValue: JSONValue? = metadata["pid"]
  do throws(CliError) {
    let response = try client.send(runtimeMetadata, "status.get", nil, timeoutMs: 1000)
    guard case .bool(true)? = response["ok"] else {
      if response["error"]?["code"].isString("runtime_access_denied") ?? false { throw CliError.needsNode }
      throw CliError.client(code: "rpc_failure", message: "", data: nil)
    }
    let r: JSONValue? = response["result"]
    let graphState = r["graphStatus"]
    var app = JSONObject()
    app.set("running", .bool(true))
    if let pidValue { app.set("pid", pidValue) }
    if let windowStatus = desktopWindowStatus(r) { app.set("desktopWindowStatus", windowStatus) }
    var runtime = JSONObject()
    runtime.set("state", .str(graphState.isString("ready") ? "ready" : "graph_not_ready"))
    runtime.set("reachable", .bool(true))
    runtime.set("connectionState", .str(runtimeHostConnectionState(r)))
    if let runtimeId = r["runtimeId"] { runtime.set("runtimeId", runtimeId) }
    for key in ["appVersion", "remoteUpdateSupport", "capabilities", "degradations"] {
      if let value = r?.objectValue?.value(forKey: key), Optional(value).truthy { runtime.set(key, value) }
    }
    var graph = JSONObject()
    if let graphState { graph.set("state", graphState) }
    return withTarget(app: app, runtime: runtime, graph: graph)
  } catch {
    if case .needsNode = error { throw error }
    let running = try isProcessRunning(pidValue)
    var runtime = JSONObject()
    runtime.set("state", .str(running ? "starting" : "stale_bootstrap"))
    runtime.set("reachable", .bool(false))
    runtime.set("connectionState", .str("disconnected"))
    runtime.set("runtimeId", .null)
    return statusResult(running: running, pid: running ? pidValue ?? .null : .null, runtime: runtime, graph: running ? "starting" : "not_running")
  }
}

/// A transport the native client cannot use (named pipe) but Node would.
func hasUsableTransportShape(_ metadata: JSONObject) -> Bool {
  for transport in metadata["transports"]?.arrayValue ?? [] {
    if transport["kind"].isString("named-pipe") { return true }
    if transport["kind"].isString("unix") { return metadata["authToken"].truthy }
  }
  return false
}

func notRunningRuntime(stale: Bool) -> JSONObject {
  var runtime = JSONObject()
  runtime.set("state", .str(stale ? "stale_bootstrap" : "not_running"))
  runtime.set("reachable", .bool(false))
  runtime.set("runtimeId", .null)
  return runtime
}

func statusResult(running: Bool, pid: JSONValue, runtime: JSONObject, graph: String) -> JSONValue {
  var app = JSONObject()
  app.set("running", .bool(running))
  app.set("pid", pid)
  var graphObject = JSONObject()
  graphObject.set("state", .str(graph))
  return withTarget(app: app, runtime: runtime, graph: graphObject)
}

func withTarget(app: JSONObject, runtime: JSONObject, graph: JSONObject) -> JSONValue {
  var result = JSONObject()
  result.set("target", .object(JSONObject([(JSONString("kind"), .str("local"))])))
  result.set("app", .object(app))
  result.set("runtime", .object(runtime))
  result.set("graph", .object(graph))
  return .object(result)
}

/// resolveDesktopWindowStatus.
func desktopWindowStatus(_ status: JSONValue?) -> JSONValue? {
  if let explicit = status["desktopWindowStatus"], Optional(explicit).truthy { return explicit }
  if case .number(let raw)? = status["authoritativeWindowId"], let id = Double(raw), id > 0 {
    return .str("available")
  }
  return nil
}

/// runtimeHostConnectionState({ hasStatusEntry: true, status }) with no client-side remote control.
func runtimeHostConnectionState(_ status: JSONValue?) -> String {
  let remoteState = status["remoteControl"]["state"]
  if remoteState.isString("reconnecting") { return "reconnecting" }
  if remoteState.isString("closed") { return "disconnected" }
  if let remote = status["remoteControl"], !remote.isNull, !remoteState.isString("ready") { return "checking" }
  if !status["graphStatus"].isString("ready") && status["desktopWindowStatus"].isString("openable") {
    return "workspace-window-closed"
  }
  return "connected"
}

/// runtime-pid-liveness.ts isProcessRunning.
func isProcessRunning(_ pid: JSONValue?) throws(CliError) -> Bool {
  guard let pid, pid.truthy else { return false }
  // Why: process.kill on a non-integer pid throws a non-ESRCH error, which Node counts as running.
  guard case .number(let raw) = pid, let value = Double(raw), value <= Double(Int32.max), value == value.rounded()
  else { throw CliError.needsNode }
  if value <= 0 { return false }
  if kill(pid_t(value), 0) == 0 { return true }
  return errno != ESRCH
}

func formatCliStatus(_ v: JSONValue?) -> String {
  [
    "appRunning: \(v["app"]["running"].templateString)",
    "pid: \(v["app"]["pid"].nullish("none"))",
    "desktopWindowStatus: \(v["app"]["desktopWindowStatus"].nullish("unknown"))",
    "runtimeState: \(v["runtime"]["state"].templateString)",
    "runtimeReachable: \(v["runtime"]["reachable"].templateString)",
    "runtimeConnectionState: \(v["runtime"]["connectionState"].nullish("unknown"))",
    "runtimeId: \(v["runtime"]["runtimeId"].nullish("none"))",
    "graphState: \(v["graph"]["state"].templateString)",
  ].joined(separator: "\n")
}
