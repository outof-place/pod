import { join } from 'node:path'
import { app } from 'electron'
import type { Repo } from '../../../shared/repo-types'
import { isPodOrbstackEnabled } from './pod-orbstack-flag'
import { registerPodOrbstackIpc } from './pod-orbstack-ipc'
import { createPodOrbstackMachines } from './pod-orbstack-machines'
import { loadPodOrbstackRecipe } from './pod-orbstack-recipe'
import { PodOrbstackRegistry } from './pod-orbstack-registry'
import { readPodOrbstackStatus } from './pod-orbstack-status'
import { setPodOrbstackTerminalResolver } from './pod-orbstack-terminal-override'
import {
  createOrbstackToolRunner,
  resolveOrbstackHomeOverride,
  resolveOrbstackToolPaths
} from './pod-orbstack-tools'

let installed = false

/** Idempotent. Registers IPC and the terminal resolver; nothing runs or reads disk until asked. */
export function installPodOrbstack(store: { getRepos(): Repo[] }): void {
  if (installed) {
    return
  }
  installed = true
  const enabled = isPodOrbstackEnabled()
  const dataDir = join(app.getPath('userData'), 'pod-orbstack')
  const registry = new PodOrbstackRegistry(join(dataDir, 'registry.json'))
  // Re-resolved per use: OrbStack can be installed or moved while Pod runs.
  const paths = (): ReturnType<typeof resolveOrbstackToolPaths> => resolveOrbstackToolPaths()
  const home = resolveOrbstackHomeOverride()
  const run = createOrbstackToolRunner(paths, home)
  const machines = createPodOrbstackMachines({
    paths,
    run,
    registry,
    home,
    loadRecipe: () => loadPodOrbstackRecipe(join(dataDir, 'recipe.json'))
  })

  registerPodOrbstackIpc({
    isEnabled: () => enabled,
    getRepos: () => store.getRepos(),
    readStatus: () =>
      readPodOrbstackStatus({
        paths: paths(),
        run,
        registry,
        busyWorktreeIds: machines.busyWorktreeIds()
      }),
    machines,
    registry
  })

  if (!enabled) {
    return
  }
  setPodOrbstackTerminalResolver((worktreeId) => {
    const entry = registry.findByWorktree(worktreeId)
    const machine = entry?.state === 'ready' ? entry.name : null
    const dockerPinned = registry.isDockerPinned(worktreeId)
    if (!machine && !dockerPinned) {
      return null
    }
    const orbPath = machine ? paths().orb : null
    return {
      orbPath: orbPath ?? '',
      machine: orbPath ? machine : null,
      dockerPinned,
      orbHome: home
    }
  })
}
