import Darwin
import PodxCore

// Native front for Pod's `podx`/`orca` CLI: ported commands talk to the runtime socket
// directly; everything else, and POD_NATIVE_CLI=0, execs the Node CLI unchanged.

func run(_ args: [String]) -> Never {
  if env("POD_NATIVE_CLI") == "0" {
    execNodeCli(args)
  }
  if args.count == 1, args[0] == "--version" || args[0] == "-v" {
    guard let version = readCliVersion() else { execNodeCli(args) }
    writeAll(1, Array((version + "\n").utf8))
    exit(0)
  }
  // Remote targets, SSH bridges, relayed cwds and pre-command flags take Node-only paths.
  guard let first = args.first, !first.hasPrefix("--"),
    !envSet("ORCA_PAIRING_CODE"), !envSet("ORCA_REMOTE_PAIRING"), !envSet("ORCA_ENVIRONMENT"),
    !envSet("ORCA_SSH_BRIDGE_CREDENTIAL"), !envSet("ORCA_CLI_CWD")
  else { execNodeCli(args) }

  let parsed = normalizeCommandPositionals(COMMAND_SPECS, parseArgs(args, specs: COMMAND_SPECS))
  guard isPlainValidInvocation(COMMAND_SPECS, parsed),
    let spec = findCommandSpec(COMMAND_SPECS, parsed.commandPath), spec.identityFlags.isEmpty,
    !parsed.flags.has("host"),
    let handler = NATIVE_HANDLERS[spec.path.joined(separator: " ")],
    let cwd = currentDirectory()
  else { execNodeCli(args) }

  let invocation = Invocation(
    commandPath: spec.path, flags: parsed.flags, client: RuntimeClient(), cwd: cwd, json: parsed.flags.has("json"))
  do {
    try handler(invocation)
  } catch {
    guard let error = error as? CliError else { preconditionFailure("unexpected error \(error)") }
    if case .needsNode = error {
      if invocation.client.sentMutation {
        preconditionFailure("needsNode after a mutation was sent")
      }
      execNodeCli(args)
    }
    var selector: String?
    if case .string(let value)? = parsed.flags["worktree"] { selector = value }
    reportCliError(
      error, json: invocation.json, context: CliErrorContext(commandPath: spec.path, worktreeSelector: selector),
      into: &invocation.out)
  }
  writeAll(1, invocation.out.stdout)
  writeAll(2, invocation.out.stderr)
  exit(invocation.out.exitCode)
}

let NATIVE_HANDLERS: [String: Handler] = BROWSER_HANDLERS.merging(TERMINAL_HANDLERS) { a, _ in a }
  .merging(WORKSPACE_HANDLERS) { a, _ in a }
  .merging(STATUS_HANDLERS) { a, _ in a }
  .merging(COMPUTER_HANDLERS) { a, _ in a }
  .merging(BROWSER_EXTRA_HANDLERS) { a, _ in a }
