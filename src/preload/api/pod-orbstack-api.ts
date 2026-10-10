import type { PodOrbstackActionResult, PodOrbstackStatus } from '../../shared/pod-orbstack-types'

/** Fork-only (Pod, macOS): OrbStack machines and containers, and per-worktree machine links. */
export type PodOrbstackApi = {
  isEnabled: () => Promise<boolean>
  /** null while OrbStack support is off. */
  getStatus: () => Promise<PodOrbstackStatus | null>
  createMachine: (args: {
    worktreeId: string
    displayName: string
  }) => Promise<PodOrbstackActionResult>
  removeMachine: (args: { worktreeId: string }) => Promise<PodOrbstackActionResult>
  startMachine: (args: { name: string }) => Promise<PodOrbstackActionResult>
  stopMachine: (args: { name: string }) => Promise<PodOrbstackActionResult>
  setDockerPin: (args: { worktreeId: string; pinned: boolean }) => Promise<PodOrbstackActionResult>
}
