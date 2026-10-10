// Fork-only (Pod): new terminals of a worktree with a Pod OrbStack machine open inside that machine,
// and its Claude launches can run in its isolated agent sandbox.
import { buildShellCommandFromArgv } from '../../../shared/tui-agent-startup-shell'
import { buildRelayWait, type SandboxRelayRoute } from './pod-orbstack-relay'

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

/** What a credential proxy adds to a sandboxed launch: env (so ORBENV keys) and relay routes. */
export type SandboxAgentAccess = {
  env?: Record<string, string>
  routes?: readonly SandboxRelayRoute[]
}

type SandboxAgentEnvProvider = (context: {
  worktreeId: string
  machine: string
}) => SandboxAgentAccess | null

/** Starts (or reuses) the sandbox's relay for these routes; returns the nonce a launch waits for. */
type SandboxRelayStarter = (machine: string, routes: readonly SandboxRelayRoute[]) => string | null

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

// Why: orb passes only ORBENV-listed variables into Linux; these route hook posts to this pane.
export const SANDBOX_FORWARDED_ENV = [
  'ORCA_PANE_KEY',
  'ORCA_TAB_ID',
  'ORCA_WORKTREE_ID',
  'ORCA_TERMINAL_HANDLE',
  'ORCA_AGENT_LAUNCH_TOKEN',
  'ORCA_AGENT_HOOK_PORT',
  'ORCA_AGENT_HOOK_TOKEN',
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
  const wait = args.relayNonce ? `${buildRelayWait(args.relayNonce)} ` : ''
  const inner = `${wait}export DISABLE_AUTOUPDATER=1; exec ${args.command}`
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
      const access = sandboxAgentEnv?.({ worktreeId: request.worktreeId, machine: sandbox.machine })
      const extra = access?.env ?? {}
      if (spawnOptions.env) {
        Object.assign(spawnOptions.env, extra)
      }
      const hookPort = Number(spawnOptions.env?.ORCA_AGENT_HOOK_PORT)
      const routes = [
        ...(Number.isInteger(hookPort) && hookPort > 0
          ? [{ vmPort: hookPort, hostPort: hookPort }]
          : []),
        ...(access?.routes ?? [])
      ]
      spawnOptions.command = buildSandboxAgentCommand({
        orbPath: target.orbPath,
        machine: sandbox.machine,
        cwd: spawnOptions.cwd,
        command: spawnOptions.command,
        forwardEnv: [...SANDBOX_FORWARDED_ENV, ...Object.keys(extra)],
        orbHome: target.orbHome,
        relayNonce:
          routes.length > 0 ? (startSandboxRelay?.(sandbox.machine, routes) ?? null) : null
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
