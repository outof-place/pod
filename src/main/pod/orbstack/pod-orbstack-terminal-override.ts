// Fork-only (Pod): new terminals of a worktree with a Pod OrbStack machine open inside that machine.

export type PodOrbstackTerminalTarget = {
  /** Absolute path of the `orb` CLI. */
  orbPath: string
  machine: string | null
  dockerPinned: boolean
  /** HOME for the orb shell process only; null keeps the terminal's. */
  orbHome: string | null
}

type TerminalTargetResolver = (worktreeId: string) => PodOrbstackTerminalTarget | null

let resolveTarget: TerminalTargetResolver | null = null

export function setPodOrbstackTerminalResolver(resolver: TerminalTargetResolver | null): void {
  resolveTarget = resolver
}

type SpawnOptionsLike = {
  env?: Record<string, string>
  shellOverride?: string
  terminalShellArgs?: string[]
}

/**
 * Both spawn-option builders (renderer IPC and runtime) call this last. Only fresh, local,
 * plain-shell spawns change: agent launches, explicit shells and SSH terminals keep their own.
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
  if (!target.machine || request.shellOverride || launchCommand) {
    return
  }
  // Why args, not a command: `orb -m` is the shell itself, so exiting it closes the pane.
  spawnOptions.shellOverride = target.orbPath
  spawnOptions.terminalShellArgs = ['-m', target.machine]
  if (target.orbHome && spawnOptions.env) {
    spawnOptions.env.HOME = target.orbHome
  }
}
