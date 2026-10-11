// Fork-only (Pod): Pod machines made from templates. Each create path goes through its template and
// falls back to the full build when the template cannot be made or cloned.
import { z } from 'zod'
import type { OrcaVmRecipe } from '../../../shared/orca-yaml-hook-types'
import type { PodOrbstackMachineKind } from '../../../shared/pod-orbstack-types'
import { parseOrbctlStatus } from './pod-orbstack-inventory'
import { POD_ORBSTACK_BUILTIN_RECIPE } from './pod-orbstack-recipe'
import type { SandboxClaudeRelease } from './pod-orbstack-claude-release'
import {
  installSandboxClaude,
  provisionSandboxBase,
  provisionSandboxWorktree
} from './pod-orbstack-sandbox'
import {
  podOrbstackTemplateKey,
  type PodOrbstackTemplate,
  type PodOrbstackTemplates
} from './pod-orbstack-templates'
import type { OrbstackToolRunner } from './pod-orbstack-tools'

const STEP_MS = 10 * 60_000

const MachineIsolationSchema = z.object({
  record: z.object({ config: z.object({ isolated: z.boolean(), isolate_network: z.boolean() }) })
})

async function orbStep(run: OrbstackToolRunner, label: string, args: string[], input?: string) {
  const result = await run('orb', args, { timeoutMs: STEP_MS, ...(input ? { input } : {}) })
  if (result.code !== 0) {
    const detail = result.timedOut ? 'timed out' : result.stderr.trim().split('\n').at(-1)
    throw new Error(`${label}: ${detail || 'failed'}`)
  }
  return result.stdout
}

/** The ready template for the sandbox's Claude version, built now (and kept) when there is none. */
export async function sandboxTemplate(
  run: OrbstackToolRunner,
  templates: PodOrbstackTemplates,
  release: SandboxClaudeRelease | null,
  onStep?: (step: string) => void
): Promise<PodOrbstackTemplate | null> {
  const key = podOrbstackTemplateKey('sandbox', release?.version ?? null)
  const ready = await templates.find(key)
  if (ready) {
    return ready
  }
  onStep?.('Building the template')
  return templates.build(
    'sandbox',
    key,
    (name) => provisionSandboxBase({ run, name, mounts: [], release, onStep }),
    release ? (name) => updateSandboxTemplate({ run, name, release, onStep }) : undefined
  )
}

/** The older sandbox template, renamed to `name`: still isolated, now with `release` only. */
async function updateSandboxTemplate(args: {
  run: OrbstackToolRunner
  name: string
  release: SandboxClaudeRelease
  onStep?: (step: string) => void
}): Promise<{ agentVersion: string | null }> {
  args.onStep?.('Updating the template')
  await orbStep(args.run, 'orb start', ['start', args.name])
  await assertIsolated(args.run, args.name, 'The template')
  return { agentVersion: await installSandboxClaude(args) }
}

async function assertIsolated(run: OrbstackToolRunner, name: string, what: string): Promise<void> {
  const info = MachineIsolationSchema.safeParse(
    JSON.parse(await orbStep(run, 'orb info', ['info', name, '--format', 'json']))
  )
  if (
    !info.success ||
    !info.data.record.config.isolated ||
    !info.data.record.config.isolate_network
  ) {
    throw new Error(`${what} ${name} did not keep its network isolation.`)
  }
}

/** The plain machine the built-in recipe makes: Ubuntu with git, sharing /Users. */
export async function sharedTemplate(
  run: OrbstackToolRunner,
  templates: PodOrbstackTemplates,
  onStep?: (step: string) => void
): Promise<PodOrbstackTemplate | null> {
  const key = podOrbstackTemplateKey('shared', null)
  const ready = await templates.find(key)
  if (ready) {
    return ready
  }
  onStep?.('Building the template')
  return await templates.build('shared', key, async (name) => {
    onStep?.('Creating the machine')
    await orbStep(run, 'orb create', ['create', 'ubuntu:24.04', name])
    onStep?.('Installing git')
    await orbStep(run, 'install git', [
      'run',
      '-m',
      name,
      '-u',
      'root',
      'sh',
      '-c',
      'command -v git >/dev/null || { apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git; }'
    ])
    return { agentVersion: null }
  })
}

/**
 * A sandbox from its template: clone, confirm the isolation came along, then the per-worktree
 * steps. Throws on any failure; the caller deletes `name`.
 */
export async function cloneSandbox(args: {
  run: OrbstackToolRunner
  templates: PodOrbstackTemplates
  template: PodOrbstackTemplate
  name: string
  mounts: readonly string[]
  onStep?: (step: string) => void
}): Promise<{ agentVersion: string | null }> {
  const { run, name, mounts, template } = args
  args.onStep?.('Cloning the template')
  await args.templates.clone(template, name, mounts)
  // The template was made isolated; a clone that is not must never run an agent.
  await assertIsolated(run, name, 'The clone')
  args.onStep?.('Setting up the worktree')
  await provisionSandboxWorktree({ run, name, mounts, agentVersion: template.agentVersion })
  return { agentVersion: template.agentVersion }
}

/** A worktree machine from the shared template; it sees the worktree through OrbStack's /Users share. */
export async function cloneSharedMachine(args: {
  run: OrbstackToolRunner
  templates: PodOrbstackTemplates
  template: PodOrbstackTemplate
  name: string
  worktreePath: string
  onStep?: (step: string) => void
}): Promise<true> {
  args.onStep?.('Cloning the template')
  await args.templates.clone(args.template, args.name, [])
  await orbStep(args.run, 'check the worktree', [
    'run',
    '-m',
    args.name,
    'test',
    '-d',
    args.worktreePath
  ])
  return true
}

/**
 * Builds the templates the next creates need, for kinds Pod already has machines of (after the
 * Mac's Claude Code moved, say). Never starts OrbStack for it.
 */
export async function prewarmPodOrbstackTemplates(args: {
  run: OrbstackToolRunner
  templates: PodOrbstackTemplates
  kinds: ReadonlySet<PodOrbstackMachineKind>
  prepareRelease?: () => Promise<SandboxClaudeRelease | null>
  loadRecipe: () => OrcaVmRecipe
}): Promise<void> {
  const status = await args.run('orbctl', ['status'])
  if (!args.templates.enabled() || parseOrbctlStatus(status.code, status.stdout) !== 'running') {
    return
  }
  if (args.kinds.has('sandbox')) {
    const release = await (args.prepareRelease?.() ?? null)?.catch(() => undefined)
    if (release !== undefined) {
      await sandboxTemplate(args.run, args.templates, release)
    }
  }
  const builtin = (() => {
    try {
      return args.loadRecipe() === POD_ORBSTACK_BUILTIN_RECIPE
    } catch {
      return false
    }
  })()
  if (args.kinds.has('shared') && builtin) {
    await sharedTemplate(args.run, args.templates)
  }
}
