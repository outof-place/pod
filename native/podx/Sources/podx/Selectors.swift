import PodxCore

// Port of src/cli/selectors.ts for a local (unpaired) runtime.

extension Invocation {
  func resolveCurrentWorktreeSelector() throws(CliError) -> String {
    guard isASCII(cwd) else { throw CliError.needsNode }
    let currentPath = resolvePosixPath(cwd, cwd: cwd)
    let response = try call("worktree.list", [("limit", .int(10_000))], readOnly: true)
    var enclosingId: JSONValue?
    var enclosingLength = -1
    for worktree in response["result"]?["worktrees"]?.arrayValue ?? [] {
      // Why: NFC folding and Windows/WSL spellings change the comparison; Node owns those.
      guard let raw = worktree["path"]?.stringValue?.string, isASCII(raw), !raw.hasPrefix("//") else {
        throw CliError.needsNode
      }
      let worktreePath = resolvePosixPath(raw, cwd: cwd)
      if !isPathInsideOrEqual(worktreePath, currentPath) || worktreePath.utf8.count <= enclosingLength {
        continue
      }
      enclosingId = worktree["id"]
      enclosingLength = worktreePath.utf8.count
    }
    guard enclosingLength >= 0 else {
      throw CliError.client(
        code: "selector_not_found",
        message: "No Orca-managed worktree contains the current directory: \(currentPath)", data: nil)
    }
    return "id:" + Optional(enclosingId ?? .null).templateString
  }

  /// normalizeWorktreeSelectorForCaller; WSL path rewriting only applies to `path:/mnt/<x>`.
  func normalizeWorktreeSelector(_ selector: String) throws(CliError) -> String {
    if selector.hasPrefix("path:/mnt/") { throw CliError.needsNode }
    return selector
  }

  func browserWorktreeSelector() throws(CliError) -> String? {
    let value = try optString("worktree")
    if value == "all" { return nil }
    if let value {
      if value == "active" || value == "current" {
        return try resolveCurrentWorktreeSelector()
      }
      return try normalizeWorktreeSelector(value)
    }
    do {
      return try resolveCurrentWorktreeSelector()
    } catch {
      if case .needsNode = error { throw error }
      return nil
    }
  }

  /// getBrowserCommandTarget as ordered params.
  func browserCommandTarget() throws(CliError) -> [(String, JSONValue?)] {
    guard let page = try optString("page") else {
      return [("worktree", try browserWorktreeSelector().json)]
    }
    let explicit = try optString("worktree")
    guard let explicit, explicit != "all" else {
      return [("page", .str(page))]
    }
    if explicit == "active" || explicit == "current" {
      return [("page", .str(page)), ("worktree", .str(try resolveCurrentWorktreeSelector()))]
    }
    return [("page", .str(page)), ("worktree", .str(try normalizeWorktreeSelector(explicit)))]
  }

  /// Validates the flags browserCommandTarget reads, before any request.
  func checkBrowserTargetFlags() throws(CliError) {
    _ = try optString("page")
    _ = try optString("worktree")
  }
}

func isPathInsideOrEqual(_ root: String, _ candidate: String) -> Bool {
  if candidate == root { return true }
  let boundary = root == "/" ? "/" : root + "/"
  return candidate.utf8.starts(with: boundary.utf8)
}
