// Ports of src/cli/args.ts and src/shared/cli-argument-boundary.ts. The native client only
// dispatches what these agree is a valid, fully understood invocation; anything else goes to
// the Node CLI before a request is sent, so its own error text and exit code stay authoritative.

public struct CommandSpec: Sendable {
  public let path: [String]
  public let aliases: [[String]]
  public let passthrough: Bool
  public let hidden: Bool
  public let allowedFlags: [String]
  public let repeatableFlags: [String]
  public let positionalArgs: [String]
  public let identityFlags: [String]

  public init(
    path: [String], aliases: [[String]], passthrough: Bool, hidden: Bool, allowedFlags: [String],
    repeatableFlags: [String], positionalArgs: [String], identityFlags: [String]
  ) {
    self.path = path
    self.aliases = aliases
    self.passthrough = passthrough
    self.hidden = hidden
    self.allowedFlags = allowedFlags
    self.repeatableFlags = repeatableFlags
    self.positionalArgs = positionalArgs
    self.identityFlags = identityFlags
  }

  var paths: [[String]] { [path] + aliases }
}

public enum FlagValue: Equatable, Sendable {
  case bool
  case string(String)
}

/// Insertion-ordered flag map with JS Map semantics.
public struct Flags: Sendable {
  public private(set) var entries: [(name: String, value: FlagValue)] = []

  public init() {}

  public subscript(name: String) -> FlagValue? {
    entries.first(where: { $0.name == name })?.value
  }

  public func has(_ name: String) -> Bool { self[name] != nil }

  public mutating func set(_ name: String, _ value: FlagValue) {
    if let i = entries.firstIndex(where: { $0.name == name }) {
      entries[i].value = value
    } else {
      entries.append((name, value))
    }
  }
}

public struct ParsedArgs: Sendable {
  public var commandPath: [String]
  public var flags: Flags
  public var positionalFlagConflicts: [String] = []
}

let REPEATED_FLAG_SEPARATOR = "\u{0000}"
let REPEATABLE_STRING_FLAGS: Set<String> = ["label", "skill"]

/// parseArgs for argv that starts with a command token. Pre-command flags make `commandIndex`
/// matter, which the native client never needs, so the caller hands those to Node.
public func parseArgs(_ argv: [String], specs: [CommandSpec]) -> ParsedArgs {
  var commandPath: [String] = []
  var flagEntries: [(String, FlagValue)] = []
  var i = 0
  while i < argv.count {
    let token = argv[i]
    if !token.hasPrefix("--") {
      commandPath.append(token)
      i += 1
      continue
    }
    let assignment = String(token.dropFirst(2))
    if let eq = assignment.firstIndex(of: "=") {
      flagEntries.append((String(assignment[..<eq]), .string(String(assignment[assignment.index(after: eq)...]))))
      i += 1
      continue
    }
    if CLI_BOOLEAN_FLAGS.contains(assignment) {
      flagEntries.append((assignment, .bool))
      i += 1
      continue
    }
    if i + 1 >= argv.count || argv[i + 1].hasPrefix("--") {
      flagEntries.append((assignment, .bool))
      i += 1
      continue
    }
    flagEntries.append((assignment, .string(argv[i + 1])))
    i += 2
  }

  var repeatable = REPEATABLE_STRING_FLAGS
  if let declared = specForPathPrefix(specs, commandPath)?.repeatableFlags {
    repeatable.formUnion(declared)
  }
  var flags = Flags()
  for (name, value) in flagEntries {
    if case .string(let text) = value, case .string(let existing)? = flags[name], repeatable.contains(name) {
      flags.set(name, .string(existing + REPEATED_FLAG_SEPARATOR + text))
    } else {
      flags.set(name, value)
    }
  }
  return ParsedArgs(commandPath: commandPath, flags: flags)
}

func specForPathPrefix(_ specs: [CommandSpec], _ path: [String]) -> CommandSpec? {
  var best: (spec: CommandSpec, length: Int)?
  for spec in specs {
    for candidate in spec.paths
    where candidate.count <= path.count && zip(candidate, path).allSatisfy({ $0 == $1 })
      && (best == nil || candidate.count > best!.length)
    {
      best = (spec, candidate.count)
    }
  }
  return best?.spec
}

public func normalizeCommandPositionals(_ specs: [CommandSpec], _ parsed: ParsedArgs) -> ParsedArgs {
  for spec in specs {
    if spec.positionalArgs.isEmpty && spec.aliases.isEmpty {
      continue
    }
    for base in spec.paths {
      let positionalCount = parsed.commandPath.count - base.count
      if positionalCount < 0 || positionalCount > spec.positionalArgs.count {
        continue
      }
      if Array(parsed.commandPath.prefix(base.count)) != base {
        continue
      }
      var flags = parsed.flags
      let values = Array(parsed.commandPath.dropFirst(base.count))
      let conflicts = values.indices.map { spec.positionalArgs[$0] }.filter { parsed.flags.has($0) }
      for (index, value) in values.enumerated() where !flags.has(spec.positionalArgs[index]) {
        flags.set(spec.positionalArgs[index], .string(value))
      }
      return ParsedArgs(commandPath: spec.path, flags: flags, positionalFlagConflicts: conflicts)
    }
  }
  return parsed
}

public func findCommandSpec(_ specs: [CommandSpec], _ commandPath: [String]) -> CommandSpec? {
  specs.first(where: { $0.paths.contains(commandPath) })
}

/// True when validateCommandAndFlags would accept the invocation and no help path applies.
public func isPlainValidInvocation(_ specs: [CommandSpec], _ parsed: ParsedArgs) -> Bool {
  if parsed.commandPath.isEmpty || parsed.commandPath.first == "help" || parsed.flags.has("help") {
    return false
  }
  guard let spec = findCommandSpec(specs, parsed.commandPath), !spec.passthrough else {
    return false
  }
  if !parsed.positionalFlagConflicts.isEmpty {
    return false
  }
  let pageAllowed = supportsBrowserPageFlag(spec.path)
  for (flag, value) in parsed.flags.entries {
    if CLI_GLOBAL_VALUE_FLAGS.contains(flag) {
      if case .string(let text) = value, !text.isEmpty {} else { return false }
    }
    if !CLI_GLOBAL_FLAGS.contains(flag) && !spec.allowedFlags.contains(flag) && !(flag == "page" && pageAllowed) {
      return false
    }
  }
  return true
}

let PAGE_FLAG_EXCLUDED_GROUPS: Set<String> = [
  "account", "artifacts", "automations", "project", "repo", "worktree", "terminal", "file",
  "orchestration", "computer", "emulator", "note", "diagnostics", "linear", "skills", "search",
  "agent-context",
]
let PAGE_FLAG_EXCLUDED_COMMANDS: Set<String> = [
  "tab list", "tab create", "tab current", "tab profile list", "tab profile create", "tab profile delete",
]

public func supportsBrowserPageFlag(_ commandPath: [String]) -> Bool {
  guard let first = commandPath.first else { return true }
  if first == "open" || first == "status" || PAGE_FLAG_EXCLUDED_GROUPS.contains(first) {
    return false
  }
  return !PAGE_FLAG_EXCLUDED_COMMANDS.contains(commandPath.joined(separator: " "))
}
