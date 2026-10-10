import PodxCore

// Ports of read-side handlers in src/cli/handlers/worktree.ts and workspace-format.ts.

let WORKSPACE_HANDLERS: [String: Handler] = [
  "worktree list": { inv in
    let repo = try inv.optString("repo")
    let limit = try inv.optPositiveInt("limit")
    let r = try inv.call("worktree.list", [("repo", repo.json), ("limit", limit.json)], readOnly: true)
    if let omitted = r["result"]?["hostScope"]?["omittedHostIds"]?.arrayValue, !omitted.isEmpty {
      throw CliError.needsNode
    }
    inv.printResult(r, formatWorktreeList)
  },
  "worktree show": { inv in
    guard let selector = try inv.optString("worktree") else { throw CliError.needsNode }
    let worktree =
      selector == "active" || selector == "current"
      ? try inv.resolveCurrentWorktreeSelector() : try inv.normalizeWorktreeSelector(selector)
    let r = try inv.call("worktree.show", [("worktree", .str(worktree))], readOnly: true)
    inv.printResult(r, formatWorktreeShow)
  },
  "worktree current": { inv in
    let worktree = try inv.resolveCurrentWorktreeSelector()
    let r = try inv.call("worktree.show", [("worktree", .str(worktree))], readOnly: true)
    inv.printResult(r, formatWorktreeShow)
  },
]

func formatWorktreeList(_ v: JSONValue?) -> String {
  let scope = formatListingHostScope(v["hostScope"])
  let worktrees = v["worktrees"].arrayValue ?? []
  if worktrees.isEmpty {
    return "No worktrees found.\n\(scope)"
  }
  let body = worktrees.map { w -> String in
    let children = w["childWorktreeIds"]
    let childCount = children.arrayValue?.count ?? 0
    return "\(w["id"].templateString)  \(w["branch"].templateString)  host=\(w["hostId"].nullish("unverifiable"))  \(w["path"].templateString)\n"
      + "displayName: \(w["displayName"].nullish(""))\n"
      + "parentWorktreeId: \(w["parentWorktreeId"].nullish("null"))\n"
      + "childWorktreeIds: \(childCount > 0 ? jsJoin(children.arrayValue ?? [], ",") : "[]")\n"
      + "linkedIssue: \(w["linkedIssue"].nullish("null"))\n"
      + "comment: \(w["comment"].nullish(""))"
  }.joined(separator: "\n\n")
  let bodyWithScope = "\(body)\n\n\(scope)"
  if v["truncated"].truthy {
    return "\(bodyWithScope)\ntruncated: showing \(worktrees.count) of \(v["totalCount"].templateString)"
  }
  return bodyWithScope
}

func formatWorktreeShow(_ v: JSONValue?) -> String {
  guard let entries = v["worktree"]?.objectValue?.entries else { return "" }
  return entries.map { entry -> String in
    let value: String
    switch entry.value {
    case .object, .array, .null: value = String(decoding: entry.value.stringify(indent: nil), as: UTF8.self)
    default: value = entry.value.templateString
    }
    return "\(entry.key.string): \(value)"
  }.joined(separator: "\n")
}
