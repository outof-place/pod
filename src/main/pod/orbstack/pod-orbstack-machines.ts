import { dirname, delimiter } from 'node:path'
import type { OrcaVmRecipe } from '../../../shared/orca-yaml-hook-types'
import type { PodOrbstackActionResult } from '../../../shared/pod-orbstack-types'
import { redactEphemeralVmRecipeDiagnosticText } from '../../../shared/ephemeral-vm-recipe-diagnostics'
import { runEphemeralVmRecipeStart } from '../../../shared/ephemeral-vm-recipe-runner'
import { isValidPodOrbstackMachineName, podOrbstackMachineName } from './pod-orbstack-recipe'
import type { PodOrbstackRegistry } from './pod-orbstack-registry'
import type { OrbstackToolPaths, OrbstackToolRunner } from './pod-orbstack-tools'

const MACHINE_COMMAND_TIMEOUT_MS = 120_000

export type PodOrbstackWorktreeTarget = {
  worktreeId: string
  worktreePath: string
  displayName: string
}

type MachineDeps = {
  paths: () => OrbstackToolPaths
  run: OrbstackToolRunner
  registry: PodOrbstackRegistry
  loadRecipe: () => OrcaVmRecipe
  runRecipe?: typeof runEphemeralVmRecipeStart
  /** HOME for the recipe's orb calls; null keeps the inherited one. */
  home?: string | null
  now?: () => number
}

function lastLines(text: string, count = 6): string {
  return redactEphemeralVmRecipeDiagnosticText(text).trim().split('\n').slice(-count).join('\n')
}

export function createPodOrbstackMachines(deps: MachineDeps) {
  const busy = new Set<string>()
  const runRecipe = deps.runRecipe ?? runEphemeralVmRecipeStart

  const guardOwned = (name: string): string | null =>
    isValidPodOrbstackMachineName(name) && deps.registry.isPodOwned(name)
      ? null
      : `${name} was not created by Pod, so Pod leaves it alone.`

  const machineExists = async (name: string): Promise<boolean> =>
    (await deps.run('orb', ['info', name, '--format', 'json'])).code === 0

  const withBusy = async (
    worktreeId: string,
    action: () => Promise<PodOrbstackActionResult>
  ): Promise<PodOrbstackActionResult> => {
    if (busy.has(worktreeId)) {
      return { ok: false, error: 'This worktree already has an OrbStack change in progress.' }
    }
    busy.add(worktreeId)
    try {
      return await action()
    } finally {
      busy.delete(worktreeId)
    }
  }

  const create = (target: PodOrbstackWorktreeTarget): Promise<PodOrbstackActionResult> =>
    withBusy(target.worktreeId, async () => {
      const orbPath = deps.paths().orb
      if (!orbPath) {
        return { ok: false, error: 'OrbStack is not installed.' }
      }
      if (deps.registry.findByWorktree(target.worktreeId)) {
        return { ok: false, error: 'This worktree already has a Pod machine.' }
      }
      const name = podOrbstackMachineName(target.worktreeId, target.worktreePath)
      if (!isValidPodOrbstackMachineName(name) || deps.registry.findByName(name)) {
        return { ok: false, error: `Cannot use the machine name ${name}.` }
      }
      let recipe: OrcaVmRecipe
      try {
        recipe = deps.loadRecipe()
      } catch (error) {
        return { ok: false, error: `The OrbStack recipe is invalid: ${String(error)}` }
      }
      const entry = {
        name,
        worktreeId: target.worktreeId,
        worktreePath: target.worktreePath,
        createdAt: (deps.now ?? Date.now)()
      }
      // Recorded before create, so a crash still leaves Pod allowed to delete the machine.
      deps.registry.upsert({ ...entry, state: 'creating' })
      const start = await runRecipe({
        recipe,
        repoPath: target.worktreePath,
        context: { instanceId: name, workspaceName: target.displayName },
        env: {
          PATH: [dirname(orbPath), process.env.PATH ?? ''].join(delimiter),
          ...(deps.home ? { HOME: deps.home } : {})
        }
      })
      if (start.ok) {
        deps.registry.upsert({ ...entry, state: 'ready' })
        return { ok: true }
      }
      // The recipe deletes its machine on failure; keep the record only if that did not happen.
      if (!(await machineExists(name))) {
        deps.registry.remove(name)
      }
      const detail = lastLines(start.stderr)
      return { ok: false, error: detail ? `${start.error}\n${detail}` : start.error }
    })

  const remove = (worktreeId: string): Promise<PodOrbstackActionResult> =>
    withBusy(worktreeId, async () => {
      const entry = deps.registry.findByWorktree(worktreeId)
      if (!entry) {
        return { ok: false, error: 'This worktree has no Pod machine.' }
      }
      const refusal = guardOwned(entry.name)
      if (refusal) {
        return { ok: false, error: refusal }
      }
      if (await machineExists(entry.name)) {
        const result = await deps.run('orb', ['delete', '--force', entry.name], {
          timeoutMs: MACHINE_COMMAND_TIMEOUT_MS
        })
        if (result.code !== 0) {
          return { ok: false, error: lastLines(result.stderr) || `Could not delete ${entry.name}.` }
        }
      }
      deps.registry.remove(entry.name)
      return { ok: true }
    })

  const setRunning = async (name: string, running: boolean): Promise<PodOrbstackActionResult> => {
    const refusal = guardOwned(name)
    if (refusal) {
      return { ok: false, error: refusal }
    }
    const result = await deps.run('orb', [running ? 'start' : 'stop', name], {
      timeoutMs: MACHINE_COMMAND_TIMEOUT_MS
    })
    return result.code === 0
      ? { ok: true }
      : { ok: false, error: lastLines(result.stderr) || `Could not change ${name}.` }
  }

  return {
    create,
    remove,
    start: (name: string) => setRunning(name, true),
    stop: (name: string) => setRunning(name, false),
    busyWorktreeIds: (): string[] => [...busy]
  }
}

export type PodOrbstackMachines = ReturnType<typeof createPodOrbstackMachines>
