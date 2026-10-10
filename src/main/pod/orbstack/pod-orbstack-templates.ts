// Fork-only (Pod): stopped template machines that new Pod machines are cloned from. `orb clone`
// copies on demand, so a create skips the image, apt and the Claude Code install (~20 s → ~1 s).
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import { writeFileAtomically } from '../../codex-accounts/fs-utils'
import type { OrbstackToolResult, OrbstackToolRunner } from './pod-orbstack-tools'

export type PodOrbstackTemplateKind = 'sandbox' | 'shared'

/** Bump when what a template holds changes, so older templates are rebuilt, never reused. */
const PROVISION_VERSION = 1
const IMAGE = 'ubuntu:24.04'
const LONG_STEP_MS = 10 * 60_000
const STEP_MS = 120_000
// Why the suffix: worktree machine names end in their hash or -sbx, so no worktree can take this.
const TEMPLATE_PATTERN = /^pod-(sbx|vm)-[0-9a-f]{8}-tmpl$/

const EntrySchema = z.object({
  name: z.string().regex(TEMPLATE_PATTERN),
  kind: z.enum(['sandbox', 'shared']),
  key: z.string().min(1),
  createdAt: z.number(),
  // Why keep creating: a crash mid-build must still let Pod delete what it started.
  state: z.enum(['creating', 'ready']),
  /** Claude Code version verified in a sandbox template. */
  agentVersion: z.string().nullable().default(null)
})

const FileSchema = z.object({ version: z.literal(1), templates: z.array(EntrySchema) })

export type PodOrbstackTemplate = z.infer<typeof EntrySchema>

export function podOrbstackTemplateKey(
  kind: PodOrbstackTemplateKind,
  claudeVersion: string | null
): string {
  return `${IMAGE}|${kind}|claude=${claudeVersion ?? 'none'}|p${PROVISION_VERSION}`
}

export function podOrbstackTemplateName(kind: PodOrbstackTemplateKind, key: string): string {
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 8)
  return `pod-${kind === 'sandbox' ? 'sbx' : 'vm'}-${hash}-tmpl`
}

export function isPodOrbstackTemplateName(name: string): boolean {
  return TEMPLATE_PATTERN.test(name)
}

function detail(result: OrbstackToolResult): string {
  return result.timedOut ? 'timed out' : result.stderr.trim().split('\n').at(-1) || 'failed'
}

/** Builds the template's content in a fresh machine `name`; returns the verified Claude version. */
export type PodOrbstackTemplateProvisioner = (
  name: string
) => Promise<{ agentVersion: string | null }>

export function createPodOrbstackTemplates(deps: {
  run: OrbstackToolRunner
  file: string
  now?: () => number
  log?: (message: string) => void
}) {
  let data: z.infer<typeof FileSchema> | null = null
  const building = new Map<string, Promise<PodOrbstackTemplate | null>>()

  const load = (): z.infer<typeof FileSchema> => {
    if (!data) {
      let parsed: unknown
      try {
        parsed = JSON.parse(readFileSync(deps.file, 'utf8'))
      } catch {
        parsed = undefined
      }
      const result = FileSchema.safeParse(parsed)
      data = result.success ? result.data : { version: 1, templates: [] }
    }
    return data
  }
  const save = (): void => {
    mkdirSync(dirname(deps.file), { recursive: true })
    writeFileAtomically(deps.file, `${JSON.stringify(load(), null, 2)}\n`)
  }
  const put = (entry: PodOrbstackTemplate): void => {
    const file = load()
    file.templates = [...file.templates.filter((t) => t.name !== entry.name), entry]
    save()
  }
  const drop = (name: string): void => {
    const file = load()
    file.templates = file.templates.filter((t) => t.name !== name)
    save()
  }
  const exists = async (name: string): Promise<boolean> =>
    (await deps.run('orb', ['info', name, '--format', 'json'])).code === 0
  /** Only recorded templates with the template name shape are Pod's to delete. */
  const remove = async (name: string): Promise<void> => {
    if (!isPodOrbstackTemplateName(name) || !load().templates.some((t) => t.name === name)) {
      return
    }
    if (await exists(name)) {
      const result = await deps.run('orb', ['delete', '--force', name], { timeoutMs: STEP_MS })
      if (result.code !== 0) {
        deps.log?.(`could not delete template ${name}: ${detail(result)}`)
        return
      }
    }
    drop(name)
  }

  /** A ready template for `key` whose machine still exists; drops the record of a vanished one. */
  const find = async (key: string): Promise<PodOrbstackTemplate | null> => {
    const entry = load().templates.find((t) => t.key === key && t.state === 'ready')
    if (!entry) {
      return null
    }
    if (await exists(entry.name)) {
      return entry
    }
    drop(entry.name)
    return null
  }

  const buildOnce = async (
    kind: PodOrbstackTemplateKind,
    key: string,
    provision: PodOrbstackTemplateProvisioner
  ): Promise<PodOrbstackTemplate | null> => {
    const name = podOrbstackTemplateName(kind, key)
    // A machine with this name Pod did not record is not Pod's: leave it alone.
    if (!load().templates.some((t) => t.name === name) && (await exists(name))) {
      deps.log?.(`${name} exists but is not a recorded template; not building`)
      return null
    }
    await remove(name)
    const entry: PodOrbstackTemplate = {
      name,
      kind,
      key,
      createdAt: (deps.now ?? Date.now)(),
      state: 'creating',
      agentVersion: null
    }
    put(entry)
    try {
      const { agentVersion } = await provision(name)
      const stopped = await deps.run('orb', ['stop', name], { timeoutMs: STEP_MS })
      if (stopped.code !== 0) {
        throw new Error(`orb stop: ${detail(stopped)}`)
      }
      const ready = { ...entry, state: 'ready' as const, agentVersion }
      put(ready)
      // Clones do not depend on their template, so older templates of this kind can go.
      for (const stale of load().templates.filter((t) => t.kind === kind && t.key !== key)) {
        await remove(stale.name)
      }
      return ready
    } catch (error) {
      deps.log?.(
        `template ${name} failed: ${error instanceof Error ? error.message : String(error)}`
      )
      await remove(name)
      return null
    }
  }

  /** Builds the template for `key` once; concurrent callers share the build. */
  const build = (
    kind: PodOrbstackTemplateKind,
    key: string,
    provision: PodOrbstackTemplateProvisioner
  ): Promise<PodOrbstackTemplate | null> => {
    const pending =
      building.get(key) ??
      buildOnce(kind, key, provision).finally(() => {
        building.delete(key)
      })
    building.set(key, pending)
    return pending
  }

  /**
   * Clones the template into a new stopped machine, points its mounts at `mounts` (same path on
   * both sides) and starts it. Throws on any failure; the caller deletes `name`.
   */
  const clone = async (
    template: PodOrbstackTemplate,
    name: string,
    mounts: readonly string[]
  ): Promise<void> => {
    const step = async (label: string, tool: 'orb' | 'orbctl', args: string[]) => {
      const result = await deps.run(tool, args, { timeoutMs: LONG_STEP_MS })
      if (result.code !== 0) {
        throw new Error(`${label}: ${detail(result)}`)
      }
    }
    if (mounts.some((path) => path.includes(':') || path.includes(','))) {
      throw new Error('OrbStack cannot share a folder whose path contains ":" or ",".')
    }
    await step('orb clone', 'orb', ['clone', template.name, name])
    const [first, ...rest] = mounts
    if (first) {
      await step('set mounts', 'orbctl', [
        'config',
        'set',
        `machine.${name}.mounts`,
        `${first}:${first}`
      ])
    }
    for (const path of rest) {
      await step('add mount', 'orbctl', [
        'config',
        'add',
        `machine.${name}.mounts`,
        `${path}:${path}`
      ])
    }
    await step('orb start', 'orb', ['start', name])
  }

  return {
    find,
    build,
    clone,
    building: (key: string): boolean => building.has(key),
    list: (): readonly PodOrbstackTemplate[] => load().templates,
    /** Every recorded template (tests, and a reset from Settings). */
    deleteAll: async (): Promise<void> => {
      for (const entry of load().templates) {
        await remove(entry.name)
      }
    }
  }
}

export type PodOrbstackTemplates = ReturnType<typeof createPodOrbstackTemplates>
