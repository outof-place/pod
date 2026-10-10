// Fork-only (Pod): Pod machines made from templates. Each create path goes through its template and
// falls back to the full build when the template cannot be made or cloned.
import { z } from 'zod'
import type { SandboxClaudeRelease } from './pod-orbstack-claude-release'
import { provisionSandboxBase, provisionSandboxWorktree } from './pod-orbstack-sandbox'
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
  release: SandboxClaudeRelease | null
): Promise<PodOrbstackTemplate | null> {
  const key = podOrbstackTemplateKey('sandbox', release?.version ?? null)
  return (
    (await templates.find(key)) ??
    (await templates.build('sandbox', key, (name) =>
      provisionSandboxBase({ run, name, mounts: [], release })
    ))
  )
}

/** The plain machine the built-in recipe makes: Ubuntu with git, sharing /Users. */
export async function sharedTemplate(
  run: OrbstackToolRunner,
  templates: PodOrbstackTemplates
): Promise<PodOrbstackTemplate | null> {
  const key = podOrbstackTemplateKey('shared', null)
  return (
    (await templates.find(key)) ??
    (await templates.build('shared', key, async (name) => {
      await orbStep(run, 'orb create', ['create', 'ubuntu:24.04', name])
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
    }))
  )
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
}): Promise<{ agentVersion: string | null }> {
  const { run, name, mounts, template } = args
  await args.templates.clone(template, name, mounts)
  const info = MachineIsolationSchema.safeParse(
    JSON.parse(await orbStep(run, 'orb info', ['info', name, '--format', 'json']))
  )
  // The template was made isolated; a clone that is not must never run an agent.
  if (
    !info.success ||
    !info.data.record.config.isolated ||
    !info.data.record.config.isolate_network
  ) {
    throw new Error(`${name} did not keep the template's network isolation.`)
  }
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
}): Promise<true> {
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
