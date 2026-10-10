import { dirname, delimiter } from 'node:path'
import type { OrcaVmRecipe } from '../../../shared/orca-yaml-hook-types'
import type { PodOrbstackActionResult } from '../../../shared/pod-orbstack-types'
import { redactEphemeralVmRecipeDiagnosticText } from '../../../shared/ephemeral-vm-recipe-diagnostics'
import { runEphemeralVmRecipeStart } from '../../../shared/ephemeral-vm-recipe-runner'
import {
  isValidPodOrbstackMachineName,
  POD_ORBSTACK_BUILTIN_RECIPE,
  podOrbstackMachineName
} from './pod-orbstack-recipe'
import type { PodOrbstackMachineKind, PodOrbstackRegistry } from './pod-orbstack-registry'
import type { SandboxClaudeRelease } from './pod-orbstack-claude-release'
import { provisionSandbox, resolveSandboxMounts } from './pod-orbstack-sandbox'
import {
  cloneSandbox,
  cloneSharedMachine,
  prewarmPodOrbstackTemplates,
  sandboxTemplate,
  sharedTemplate
} from './pod-orbstack-template-machines'
import type { PodOrbstackTemplates } from './pod-orbstack-templates'
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
  /** The release of the Mac's Claude Code version a new sandbox installs; null skips Claude (E2E). */
  prepareClaudeRelease?: () => Promise<SandboxClaudeRelease | null>
  provision?: typeof provisionSandbox
  resolveMounts?: typeof resolveSandboxMounts
  /** Mints the sandbox's hook token once it is ready. */
  onSandboxCreated?: (name: string) => void
  /** Stops anything Pod runs against a sandbox (its relay, its token) before the machine goes. */
  onSandboxRemoved?: (name: string) => void
  /** Clone sources; without them every create builds its machine from the image. */
  templates?: PodOrbstackTemplates
  log?: (message: string) => void
  /** Create steps, in words a user reads, for `orbstack.subscribe`. */
  onProgress?: (worktreeId: string, kind: PodOrbstackMachineKind, step: string) => void
  now?: () => number
}

function lastLines(text: string, count = 6): string {
  return redactEphemeralVmRecipeDiagnosticText(text).trim().split('\n').slice(-count).join('\n')
}

export function createPodOrbstackMachines(deps: MachineDeps) {
  const busy = new Set<string>()
  // Machines with a start or stop in flight; a stats read must not touch them.
  const moving = new Set<string>()
  const runRecipe = deps.runRecipe ?? runEphemeralVmRecipeStart

  const guardOwned = (name: string): string | null =>
    isValidPodOrbstackMachineName(name) && deps.registry.isPodOwned(name)
      ? null
      : `${name} was not created by Pod, so Pod leaves it alone.`

  const deleteMachine = (name: string) =>
    deps.run('orb', ['delete', '--force', name], { timeoutMs: MACHINE_COMMAND_TIMEOUT_MS })

  const machineExists = async (name: string): Promise<boolean> =>
    (await deps.run('orb', ['info', name, '--format', 'json'])).code === 0

  /** Runs a template path; on failure deletes what it made, so the full build starts clean. */
  const fromTemplate = async <T>(name: string, make: (t: PodOrbstackTemplates) => Promise<T>) => {
    if (!deps.templates) {
      return null
    }
    try {
      return await make(deps.templates)
    } catch (error) {
      deps.log?.(`${name} from template failed, building it: ${String(error)}`)
      await deleteMachine(name)
      return null
    }
  }

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
      // A recipe.json override keeps its own lifecycle; only the built-in one has a template.
      const onStep = (step: string) => deps.onProgress?.(target.worktreeId, 'shared', step)
      if (recipe === POD_ORBSTACK_BUILTIN_RECIPE && !(await machineExists(name))) {
        const cloned = await fromTemplate(name, async (templates) => {
          const template = await sharedTemplate(deps.run, templates, onStep)
          return template
            ? cloneSharedMachine({
                run: deps.run,
                templates,
                template,
                name,
                worktreePath: target.worktreePath,
                onStep
              })
            : null
        })
        if (cloned !== null) {
          deps.registry.upsert({ ...entry, state: 'ready' })
          return { ok: true }
        }
      }
      onStep('Running the recipe')
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

  const createSandbox = (target: PodOrbstackWorktreeTarget): Promise<PodOrbstackActionResult> =>
    withBusy(target.worktreeId, async () => {
      if (!deps.paths().orb) {
        return { ok: false, error: 'OrbStack is not installed.' }
      }
      if (deps.registry.findByWorktree(target.worktreeId, 'sandbox')) {
        return { ok: false, error: 'This worktree already has an agent sandbox.' }
      }
      const name = podOrbstackMachineName(target.worktreeId, target.worktreePath, 'sandbox')
      if (!isValidPodOrbstackMachineName(name) || deps.registry.findByName(name)) {
        return { ok: false, error: `Cannot use the machine name ${name}.` }
      }
      // A machine Pod did not record is the user's, even with Pod's name: leave it alone.
      if (await machineExists(name)) {
        return { ok: false, error: `${name} already exists in OrbStack.` }
      }
      const mounts = await (deps.resolveMounts ?? resolveSandboxMounts)(target.worktreePath)
      if (mounts.some((path) => path.includes(':'))) {
        return { ok: false, error: 'OrbStack cannot share a folder whose path contains ":".' }
      }
      const onStep = (step: string) => deps.onProgress?.(target.worktreeId, 'sandbox', step)
      // Downloaded before the machine exists, so a network failure leaves nothing to clean up.
      let release: SandboxClaudeRelease | null
      onStep('Preparing Claude Code')
      try {
        release = (await deps.prepareClaudeRelease?.()) ?? null
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
      const entry = {
        name,
        worktreeId: target.worktreeId,
        worktreePath: target.worktreePath,
        createdAt: (deps.now ?? Date.now)(),
        kind: 'sandbox' as const,
        networkIsolated: true
      }
      deps.registry.upsert({ ...entry, state: 'creating' })
      try {
        const cloned = await fromTemplate(name, async (templates) => {
          const template = await sandboxTemplate(deps.run, templates, release, onStep)
          return template
            ? cloneSandbox({ run: deps.run, templates, template, name, mounts, onStep })
            : null
        })
        const { agentVersion } =
          cloned ??
          (await (deps.provision ?? provisionSandbox)({
            run: deps.run,
            name,
            mounts,
            release,
            onStep
          }))
        deps.registry.upsert({
          ...entry,
          state: 'ready',
          ...(agentVersion ? { agentVersion } : {})
        })
        deps.onSandboxCreated?.(name)
        return { ok: true }
      } catch (error) {
        // This call created the machine (it did not exist above), so it may delete it.
        await deleteMachine(name)
        if (!(await machineExists(name))) {
          deps.registry.remove(name)
        }
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

  const remove = (
    worktreeId: string,
    kind: PodOrbstackMachineKind = 'shared'
  ): Promise<PodOrbstackActionResult> =>
    withBusy(worktreeId, async () => {
      const entry = deps.registry.findByWorktree(worktreeId, kind)
      if (!entry) {
        return { ok: false, error: 'This worktree has no Pod machine of that kind.' }
      }
      const refusal = guardOwned(entry.name)
      if (refusal) {
        return { ok: false, error: refusal }
      }
      if (kind === 'sandbox') {
        deps.onSandboxRemoved?.(entry.name)
      }
      if (await machineExists(entry.name)) {
        const result = await deleteMachine(entry.name)
        if (result.code !== 0) {
          return { ok: false, error: lastLines(result.stderr) || `Could not delete ${entry.name}.` }
        }
      }
      deps.registry.remove(entry.name)
      if (kind === 'sandbox') {
        deps.registry.setSandboxAgents(worktreeId, false)
      }
      return { ok: true }
    })

  const setRunning = async (name: string, running: boolean): Promise<PodOrbstackActionResult> => {
    const refusal = guardOwned(name)
    if (refusal) {
      return { ok: false, error: refusal }
    }
    moving.add(name)
    const result = await deps
      .run('orb', [running ? 'start' : 'stop', name], { timeoutMs: MACHINE_COMMAND_TIMEOUT_MS })
      .finally(() => moving.delete(name))
    return result.code === 0
      ? { ok: true }
      : { ok: false, error: lastLines(result.stderr) || `Could not change ${name}.` }
  }

  const prewarm = async (): Promise<void> => {
    if (deps.templates) {
      await prewarmPodOrbstackTemplates({
        run: deps.run,
        templates: deps.templates,
        kinds: new Set(deps.registry.machines().map((entry) => entry.kind)),
        prepareRelease: deps.prepareClaudeRelease,
        loadRecipe: deps.loadRecipe
      })
    }
  }

  return {
    create,
    createSandbox,
    remove,
    start: (name: string) => setRunning(name, true),
    stop: (name: string) => setRunning(name, false),
    busyWorktreeIds: (): string[] => [...busy],
    /** Machines being started, stopped, created or deleted right now. */
    busyMachines: (): string[] => [
      ...moving,
      ...deps.registry
        .machines()
        .filter((entry) => busy.has(entry.worktreeId))
        .map((entry) => entry.name)
    ],
    prewarm
  }
}

export type PodOrbstackMachines = ReturnType<typeof createPodOrbstackMachines>
