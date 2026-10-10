// Fork-only (Pod): new terminals of a worktree with a Pod OrbStack machine open inside that machine,
// and its Claude launches can run in its isolated agent sandbox.
import { buildShellCommandFromArgv } from '../../../shared/tui-agent-startup-shell'
import { buildRelayWait } from './pod-orbstack-relay'

export type PodOrbstackTerminalTarget = {
  /** Absolute path of the `orb` CLI. */
  orbPath: string
  machine: string | null
  dockerPinned: boolean
  /** HOME for the orb shell process only; null keeps the terminal's. */
  orbHome: string | null
  sandbox: { machine: string; agentsByDefault: boolean } | null
}

type TerminalTargetResolver = (worktreeId: string) => PodOrbstackTerminalTarget | null

/** Extra env (and so ORBENV keys) for a sandboxed agent, e.g. a credential proxy's settings. */
type SandboxAgentEnvProvider = (context: {
  worktreeId: string
  machine: string
}) => Record<string, string> | null

/**
 * Starts (or reuses) the sandbox's hook relay to this hook server. Returns the nonce a launch waits
 * for and the sandbox's own hook token, which stands in for the server's inside the VM.
 */
type SandboxRelayStarter = (
  machine: string,
  hookServer: { port: number; token: string }
) => { nonce: string; sandboxToken: string } | null

let resolveTarget: TerminalTargetResolver | null = null
let sandboxAgentEnv: SandboxAgentEnvProvider | null = null
let startSandboxRelay: SandboxRelayStarter | null = null

export function setPodOrbstackTerminalResolver(resolver: TerminalTargetResolver | null): void {
  resolveTarget = resolver
}

export function setPodSandboxAgentEnvProvider(provider: SandboxAgentEnvProvider | null): void {
  sandboxAgentEnv = provider
}

export function setPodSandboxRelayStarter(starter: SandboxRelayStarter | null): void {
  startSandboxRelay = starter
}

/** Per-launch override: `1` runs this Claude launch in the sandbox, `0` keeps it on the Mac. */
export const POD_ORBSTACK_SANDBOX_LAUNCH_ENV = 'POD_ORBSTACK_SANDBOX'
/** Carries the sandbox's hook token into the VM, where it becomes ORCA_AGENT_HOOK_TOKEN. */
export const POD_SANDBOX_HOOK_TOKEN_ENV = 'POD_SANDBOX_HOOK_TOKEN'

// Why: orb passes only ORBENV-listed variables into Linux; these route hook posts to this pane.
export const SANDBOX_FORWARDED_ENV = [
  'ORCA_PANE_KEY',
  'ORCA_TAB_ID',
  'ORCA_WORKTREE_ID',
  'ORCA_TERMINAL_HANDLE',
  'ORCA_AGENT_LAUNCH_TOKEN',
  'ORCA_AGENT_HOOK_PORT',
  'ORCA_AGENT_HOOK_ENV',
  'ORCA_AGENT_HOOK_VERSION',
  'ORCA_AGENT_HOOK_TRANSPORT',
  'COLORTERM'
] as const

/** `ORBENV=… orb -m <sandbox> -w <cwd> bash -lc 'exec <command>'`, typed into the pane's Mac shell. */
export function buildSandboxAgentCommand(args: {
  orbPath: string
  machine: string
  cwd: string
  command: string
  forwardEnv: readonly string[]
  /** HOME for the orb process only (E2E profiles); null keeps the shell's. */
  orbHome?: string | null
  /** The relay nonce to wait for before the agent starts, so its first hook post gets through. */
  relayNonce?: string | null
}): string {
  // Why exec: the agent replaces the login shell, so its exit ends orb and the Mac sees it exit.
  const relay = args.relayNonce
    ? `${buildRelayWait(args.relayNonce)} export ORCA_AGENT_HOOK_TOKEN="$${POD_SANDBOX_HOOK_TOKEN_ENV}"; unset ${POD_SANDBOX_HOOK_TOKEN_ENV}; `
    : ''
  const inner = `${relay}export DISABLE_AUTOUPDATER=1; exec ${args.command}`
  const argv = [args.orbPath, '-m', args.machine, '-w', args.cwd, 'bash', '-lc', inner]
  const home = args.orbHome ? `HOME=${buildShellCommandFromArgv([args.orbHome], 'posix')} ` : ''
  return `ORBENV=${args.forwardEnv.join(':')} ${home}${buildShellCommandFromArgv(argv, 'posix')}`
}

type SpawnOptionsLike = {
  env?: Record<string, string>
  cwd?: string
  command?: string
  launchAgent?: string
  shellOverride?: string
  terminalShellArgs?: string[]
}

function wantsSandbox(env: Record<string, string> | undefined, byDefault: boolean): boolean {
  const marker = env?.[POD_ORBSTACK_SANDBOX_LAUNCH_ENV]
  return marker === '1' || (marker !== '0' && byDefault)
}

/**
 * Both spawn-option builders (renderer IPC and runtime) call this last. Plain local shells move
 * into the worktree's machine; Claude launches move into its sandbox when asked; agent launches,
 * explicit shells and SSH terminals otherwise keep their own.
 */
export function applyPodOrbstackTerminalOverride(
  spawnOptions: SpawnOptionsLike,
  request: {
    worktreeId?: string
    connectionId?: string | null
    /** The shell the caller asked for explicitly; it wins over the machine. */
    shellOverride?: string
  },
  launchCommand: string | undefined
): void {
  if (!resolveTarget || !request.worktreeId || request.connectionId) {
    return
  }
  const target = resolveTarget(request.worktreeId)
  if (!target) {
    return
  }
  if (target.dockerPinned && spawnOptions.env && spawnOptions.env.DOCKER_CONTEXT === undefined) {
    spawnOptions.env.DOCKER_CONTEXT = 'orbstack'
  }
  if (launchCommand) {
    const { sandbox } = target
    if (
      sandbox &&
      target.orbPath &&
      spawnOptions.launchAgent === 'claude' &&
      spawnOptions.command &&
      spawnOptions.cwd &&
      wantsSandbox(spawnOptions.env, sandbox.agentsByDefault)
    ) {
      const extra = sandboxAgentEnv?.({ worktreeId: request.worktreeId, machine: sandbox.machine })
      const env = spawnOptions.env ?? {}
      Object.assign(env, extra ?? {})
      const hookPort = Number(env.ORCA_AGENT_HOOK_PORT)
      const hookToken = env.ORCA_AGENT_HOOK_TOKEN
      const relay =
        Number.isInteger(hookPort) && hookPort > 0 && hookToken
          ? (startSandboxRelay?.(sandbox.machine, { port: hookPort, token: hookToken }) ?? null)
          : null
      // The server's token stays on the Mac; the VM gets the sandbox's, which the relay swaps back.
      if (relay) {
        env[POD_SANDBOX_HOOK_TOKEN_ENV] = relay.sandboxToken
      }
      spawnOptions.command = buildSandboxAgentCommand({
        orbPath: target.orbPath,
        machine: sandbox.machine,
        cwd: spawnOptions.cwd,
        command: spawnOptions.command,
        forwardEnv: [
          ...SANDBOX_FORWARDED_ENV,
          ...(relay ? [POD_SANDBOX_HOOK_TOKEN_ENV] : []),
          ...Object.keys(extra ?? {})
        ],
        orbHome: target.orbHome,
        relayNonce: relay?.nonce ?? null
      })
    }
    return
  }
  if (!target.machine || request.shellOverride) {
    return
  }
  // Why args, not a command: `orb -m` is the shell itself, so exiting it closes the pane.
  spawnOptions.shellOverride = target.orbPath
  spawnOptions.terminalShellArgs = ['-m', target.machine]
  if (target.orbHome && spawnOptions.env) {
    spawnOptions.env.HOME = target.orbHome
  }
}
