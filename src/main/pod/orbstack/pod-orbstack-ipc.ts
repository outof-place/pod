import { statSync } from 'node:fs'
import { ipcMain } from 'electron'
import { POD_ORBSTACK_IPC } from '../../../shared/pod-orbstack-types'
import type { PodOrbstackActionResult, PodOrbstackStatus } from '../../../shared/pod-orbstack-types'
import type { Repo } from '../../../shared/repo-types'
import { getRepoIdFromWorktreeId, splitWorktreeIdForFilesystem } from '../../../shared/worktree/id'
import type { PodOrbstackMachines, PodOrbstackWorktreeTarget } from './pod-orbstack-machines'
import type { PodOrbstackRegistry } from './pod-orbstack-registry'

export type PodOrbstackIpcDeps = {
  isEnabled: () => boolean
  getRepos: () => Repo[]
  readStatus: () => Promise<PodOrbstackStatus>
  machines: PodOrbstackMachines
  registry: PodOrbstackRegistry
}

const DISABLED: PodOrbstackActionResult = { ok: false, error: 'OrbStack support is off.' }

function readString(args: unknown, key: string): string | null {
  const value = typeof args === 'object' && args !== null ? Reflect.get(args, key) : undefined
  return typeof value === 'string' && value.length > 0 ? value : null
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Machines open the worktree in place, so only a local checkout on this Mac qualifies. */
export function resolveLocalWorktreeTarget(
  worktreeId: string,
  displayName: string | null,
  repos: readonly Repo[],
  isDir: (path: string) => boolean = isDirectory
): PodOrbstackWorktreeTarget | string {
  const repo = repos.find((entry) => entry.id === getRepoIdFromWorktreeId(worktreeId))
  if (!repo) {
    return 'Unknown worktree.'
  }
  if (repo.connectionId || (repo.executionHostId && repo.executionHostId !== 'local')) {
    return 'OrbStack machines are for worktrees on this Mac, not remote ones.'
  }
  const parsed = splitWorktreeIdForFilesystem(worktreeId)
  if (!parsed || !parsed.worktreePath.startsWith('/') || !isDir(parsed.worktreePath)) {
    return 'The worktree folder does not exist.'
  }
  return { worktreeId, worktreePath: parsed.worktreePath, displayName: displayName ?? '' }
}

export function registerPodOrbstackIpc(deps: PodOrbstackIpcDeps): void {
  ipcMain.handle(POD_ORBSTACK_IPC.enabled, (): boolean => deps.isEnabled())

  ipcMain.handle(POD_ORBSTACK_IPC.status, (): Promise<PodOrbstackStatus> | null =>
    deps.isEnabled() ? deps.readStatus() : null
  )

  ipcMain.handle(
    POD_ORBSTACK_IPC.createMachine,
    async (_event, args: unknown): Promise<PodOrbstackActionResult> => {
      const worktreeId = readString(args, 'worktreeId')
      if (!deps.isEnabled() || !worktreeId) {
        return DISABLED
      }
      const target = resolveLocalWorktreeTarget(
        worktreeId,
        readString(args, 'displayName'),
        deps.getRepos()
      )
      return typeof target === 'string'
        ? { ok: false, error: target }
        : deps.machines.create(target)
    }
  )

  ipcMain.handle(
    POD_ORBSTACK_IPC.removeMachine,
    (_event, args: unknown): Promise<PodOrbstackActionResult> | PodOrbstackActionResult => {
      const worktreeId = readString(args, 'worktreeId')
      return deps.isEnabled() && worktreeId ? deps.machines.remove(worktreeId) : DISABLED
    }
  )

  ipcMain.handle(
    POD_ORBSTACK_IPC.startMachine,
    (_event, args: unknown): Promise<PodOrbstackActionResult> | PodOrbstackActionResult => {
      const name = readString(args, 'name')
      return deps.isEnabled() && name ? deps.machines.start(name) : DISABLED
    }
  )

  ipcMain.handle(
    POD_ORBSTACK_IPC.stopMachine,
    (_event, args: unknown): Promise<PodOrbstackActionResult> | PodOrbstackActionResult => {
      const name = readString(args, 'name')
      return deps.isEnabled() && name ? deps.machines.stop(name) : DISABLED
    }
  )

  ipcMain.handle(
    POD_ORBSTACK_IPC.setDockerPin,
    (_event, args: unknown): PodOrbstackActionResult => {
      const worktreeId = readString(args, 'worktreeId')
      const pinned = typeof args === 'object' && args !== null && Reflect.get(args, 'pinned')
      if (!deps.isEnabled() || !worktreeId || typeof pinned !== 'boolean') {
        return DISABLED
      }
      deps.registry.setDockerPin(worktreeId, pinned)
      return { ok: true }
    }
  )
}
