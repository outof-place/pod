import type {
  PodOrbstackActionResult,
  PodOrbstackEvent,
  PodOrbstackMachineKind,
  PodOrbstackRelayRow,
  PodOrbstackStats,
  PodOrbstackStatus
} from '../../../shared/pod-orbstack-types'
import type { Repo } from '../../../shared/repo-types'
import type { PodOrbstackMachines } from './pod-orbstack-machines'
import type { PodOrbstackRegistry } from './pod-orbstack-registry'
import { resolveLocalWorktreeTarget } from './pod-orbstack-worktree-target'

/** The one OrbStack API: runtime RPC methods wrap it for the renderer, the CLI and the native shell. */
export type PodOrbstackService = {
  isEnabled(): boolean
  /** `containers: false` skips docker ps/stats. */
  snapshot(options?: { containers?: boolean }): Promise<PodOrbstackStatus>
  stats(names?: readonly string[]): Promise<PodOrbstackStats>
  create(args: {
    worktreeId: string
    displayName?: string
    kind?: PodOrbstackMachineKind
  }): Promise<PodOrbstackActionResult>
  remove(worktreeId: string, kind?: PodOrbstackMachineKind): Promise<PodOrbstackActionResult>
  start(name: string): Promise<PodOrbstackActionResult>
  stop(name: string): Promise<PodOrbstackActionResult>
  setDockerPin(worktreeId: string, pinned: boolean): PodOrbstackActionResult
  setAgentSandbox(worktreeId: string, enabled: boolean): PodOrbstackActionResult
  setSandboxClaudeLogin(enabled: boolean): PodOrbstackActionResult
  setTemplates(enabled: boolean): Promise<PodOrbstackActionResult>
  /** Drops the cached status and tells subscribers something moved. */
  invalidate(): void
  /** Starts an event stream: the relay log so far, then every event. */
  subscribe(emit: (event: PodOrbstackEvent) => void): {
    seed: PodOrbstackRelayRow[]
    stop: () => void
  }
}

// Why: status, machines and containers are separate methods; one read serves a burst of them.
const SNAPSHOT_TTL_MS = 2_000

export function createPodOrbstackService(deps: {
  enabled: boolean
  getRepos: () => Repo[]
  machines: PodOrbstackMachines
  registry: PodOrbstackRegistry
  readStatus: (options: { containers: boolean }) => Promise<PodOrbstackStatus>
  readStats?: (names?: readonly string[]) => Promise<PodOrbstackStats>
  setTemplates?: (enabled: boolean) => Promise<void>
  /** Every mutation and registry or template change: `orbstack.subscribe` sends `changed`. */
  onChanged?: () => void
  subscribe?: PodOrbstackService['subscribe']
  now?: () => number
}): PodOrbstackService {
  const now = deps.now ?? Date.now
  const cached = new Map<boolean, { at: number; value: Promise<PodOrbstackStatus> }>()
  const changed = (): void => {
    cached.clear()
    deps.onChanged?.()
  }
  const invalidate = <T>(result: T): T => {
    changed()
    return result
  }
  const target = (worktreeId: string, displayName?: string) =>
    resolveLocalWorktreeTarget(worktreeId, displayName ?? null, deps.getRepos())

  return {
    isEnabled: () => deps.enabled,
    snapshot: (options) => {
      const containers = options?.containers !== false
      const hit = cached.get(containers)
      if (hit && now() - hit.at <= SNAPSHOT_TTL_MS) {
        return hit.value
      }
      const value = deps.readStatus({ containers })
      cached.set(containers, { at: now(), value })
      // A failed read must not be served from the cache.
      value.catch(() => {
        if (cached.get(containers)?.value === value) {
          cached.delete(containers)
        }
      })
      return value
    },
    stats: (names) =>
      deps.readStats?.(names) ??
      Promise.resolve({ tick: 0, sampledAt: now(), machines: [], errors: ['no stats here'] }),
    create: async ({ worktreeId, displayName, kind }) => {
      const resolved = target(worktreeId, displayName)
      if (typeof resolved === 'string') {
        return { ok: false, error: resolved }
      }
      return invalidate(
        await (kind === 'sandbox'
          ? deps.machines.createSandbox(resolved)
          : deps.machines.create(resolved))
      )
    },
    remove: async (worktreeId, kind) => invalidate(await deps.machines.remove(worktreeId, kind)),
    start: async (name) => invalidate(await deps.machines.start(name)),
    stop: async (name) => invalidate(await deps.machines.stop(name)),
    setDockerPin: (worktreeId, pinned) => {
      const resolved = target(worktreeId)
      if (typeof resolved === 'string') {
        return { ok: false, error: resolved }
      }
      deps.registry.setDockerPin(worktreeId, pinned)
      return invalidate({ ok: true })
    },
    setAgentSandbox: (worktreeId, enabled) => {
      if (enabled && deps.registry.findByWorktree(worktreeId, 'sandbox')?.state !== 'ready') {
        return { ok: false, error: 'Create the agent sandbox first.' }
      }
      deps.registry.setSandboxAgents(worktreeId, enabled)
      return invalidate({ ok: true })
    },
    setSandboxClaudeLogin: (enabled) => {
      deps.registry.setSandboxClaudeLogin(enabled)
      return invalidate({ ok: true })
    },
    setTemplates: async (enabled) => {
      if (!deps.setTemplates) {
        return { ok: false, error: 'Templates are off in this build.' }
      }
      await deps.setTemplates(enabled)
      return invalidate({ ok: true })
    },
    invalidate: changed,
    subscribe: (emit) => deps.subscribe?.(emit) ?? { seed: [], stop: () => undefined }
  }
}

let current: PodOrbstackService | null = null

export function setPodOrbstackService(service: PodOrbstackService | null): void {
  current = service
}

export function getPodOrbstackService(): PodOrbstackService | null {
  return current
}
