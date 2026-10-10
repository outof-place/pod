import { join } from 'node:path'
import { app } from 'electron'
import type { Repo } from '../../../shared/repo-types'
import { isPodOrbstackEnabled } from './pod-orbstack-flag'
import { createPodOrbstackMachines } from './pod-orbstack-machines'
import { loadPodOrbstackRecipe } from './pod-orbstack-recipe'
import { PodOrbstackRegistry } from './pod-orbstack-registry'
import { createPodOrbstackService, setPodOrbstackService } from './pod-orbstack-service'
import { readPodOrbstackStatus } from './pod-orbstack-status'
import { setPodOrbstackTerminalResolver } from './pod-orbstack-terminal-override'
import {
  createOrbstackToolRunner,
  resolveOrbstackHomeOverride,
  resolveOrbstackToolPaths,
  type OrbstackToolPaths
} from './pod-orbstack-tools'

let installed = false

/** Idempotent. Backs the orbstack.* RPC methods and the terminal resolver; nothing runs until asked. */
export function installPodOrbstack(store: { getRepos(): Repo[] }): void {
  if (installed) {
    return
  }
  installed = true
  const enabled = isPodOrbstackEnabled()
  const dataDir = join(app.getPath('userData'), 'pod-orbstack')
  const registry = new PodOrbstackRegistry(join(dataDir, 'registry.json'))
  // Re-resolved per use: OrbStack can be installed or moved while Pod runs.
  const paths = (): OrbstackToolPaths => resolveOrbstackToolPaths()
  const home = resolveOrbstackHomeOverride()
  const run = createOrbstackToolRunner(paths, home)
  const machines = createPodOrbstackMachines({
    paths,
    run,
    registry,
    home,
    loadRecipe: () => loadPodOrbstackRecipe(join(dataDir, 'recipe.json'))
  })
  setPodOrbstackService(
    createPodOrbstackService({
      enabled,
      getRepos: () => store.getRepos(),
      machines,
      registry,
      readStatus: () =>
        readPodOrbstackStatus({
          paths: paths(),
          run,
          registry,
          busyWorktreeIds: machines.busyWorktreeIds()
        })
    })
  )
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
