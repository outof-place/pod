import type {
  PodOrbstackActionResult,
  PodOrbstackMachineKind,
  PodOrbstackStatus
} from '../../../shared/pod-orbstack-types'
import type { Repo } from '../../../shared/repo-types'
import type { PodOrbstackMachines } from './pod-orbstack-machines'
import type { PodOrbstackRegistry } from './pod-orbstack-registry'
import { resolveLocalWorktreeTarget } from './pod-orbstack-worktree-target'

/** The one OrbStack API: runtime RPC methods wrap it for the renderer, the CLI and the native shell. */
export type PodOrbstackService = {
  isEnabled(): boolean
  snapshot(): Promise<PodOrbstackStatus>
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
}

// Why: status, machines and containers are separate methods; one read serves a burst of them.
const SNAPSHOT_TTL_MS = 2_000

export function createPodOrbstackService(deps: {
  enabled: boolean
  getRepos: () => Repo[]
  machines: PodOrbstackMachines
  registry: PodOrbstackRegistry
  readStatus: () => Promise<PodOrbstackStatus>
  now?: () => number
}): PodOrbstackService {
  const now = deps.now ?? Date.now
  let cached: { at: number; value: Promise<PodOrbstackStatus> } | null = null
  const invalidate = <T>(result: T): T => {
    cached = null
    return result
  }
  const target = (worktreeId: string, displayName?: string) =>
    resolveLocalWorktreeTarget(worktreeId, displayName ?? null, deps.getRepos())

  return {
    isEnabled: () => deps.enabled,
    snapshot: () => {
      if (!cached || now() - cached.at > SNAPSHOT_TTL_MS) {
        const value = deps.readStatus()
        cached = { at: now(), value }
        // A failed read must not be served from the cache.
        value.catch(() => {
          if (cached?.value === value) {
            cached = null
          }
        })
      }
      return cached.value
    },
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
    }
  }
}

let current: PodOrbstackService | null = null

export function setPodOrbstackService(service: PodOrbstackService | null): void {
  current = service
}

export function getPodOrbstackService(): PodOrbstackService | null {
  return current
}
