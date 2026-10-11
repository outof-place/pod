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

const FileSchema = z.object({
  version: z.literal(1),
  /** Settings › OrbStack switch; off deletes every template and creates build in full. */
  enabled: z.boolean().default(true),
  templates: z.array(EntrySchema)
})

/**
 * Run as root in a template before it stops: nothing per machine may reach a clone. An empty
 * machine-id makes each clone's first boot mint its own; host keys, if an image has any, go too.
 */
export const SEAL_TEMPLATE = `set -eu
truncate -s 0 /etc/machine-id
rm -f /etc/ssh/ssh_host_*
`

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

/** Keys that differ only in the Claude Code version: such a template can be updated in place. */
function sameBuild(a: string, b: string): boolean {
  const base = (key: string) => key.replace(/\|claude=[^|]*\|/, '|')
  return base(a) === base(b)
}

function detail(result: OrbstackToolResult): string {
  return result.timedOut ? 'timed out' : result.stderr.trim().split('\n').at(-1) || 'failed'
}

/** Builds the template's content in a fresh machine `name`; returns the verified Claude version. */
export type PodOrbstackTemplateProvisioner = (
  name: string
) => Promise<{ agentVersion: string | null }>

/** Brings an older template, already renamed to `name`, to the new key; returns its Claude version. */
export type PodOrbstackTemplateUpdater = PodOrbstackTemplateProvisioner

export function createPodOrbstackTemplates(deps: {
  run: OrbstackToolRunner
  file: string
  now?: () => number
  log?: (message: string) => void
  /** The template set or the switch moved. */
  onChange?: () => void
}) {
  let data: z.infer<typeof FileSchema> | null = null
  const building = new Map<string, Promise<PodOrbstackTemplate | null>>()
  // `orb clone` calls reading each template: a rename or delete waits for them (~30 ms each).
  const clones = new Map<string, Set<Promise<unknown>>>()
  const clonesOf = (name: string) =>
    Promise.allSettled(clones.get(name) ?? new Set<Promise<unknown>>())
  const claimed = new Set<string>()

  const load = (): z.infer<typeof FileSchema> => {
    if (!data) {
      let parsed: unknown
      try {
        parsed = JSON.parse(readFileSync(deps.file, 'utf8'))
      } catch {
        parsed = undefined
      }
      const result = FileSchema.safeParse(parsed)
      data = result.success ? result.data : { version: 1, enabled: true, templates: [] }
    }
    return data
  }
  const save = (): void => {
    mkdirSync(dirname(deps.file), { recursive: true })
    writeFileAtomically(deps.file, `${JSON.stringify(load(), null, 2)}\n`)
    deps.onChange?.()
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
    if (!load().enabled) {
      return null
    }
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

  /**
   * Renames an older template of the kind to `name`. Why: the machine keeps its address, while a new
   * one takes a fresh address and OrbStack 2.2.3 holds a deleted machine's for about a day (#2688).
   */
  const adopt = async (kind: PodOrbstackTemplateKind, key: string, name: string) => {
    const previous = load().templates.find(
      (t) =>
        t.kind === kind &&
        t.state === 'ready' &&
        t.key !== key &&
        sameBuild(t.key, key) &&
        !claimed.has(t.name)
    )
    if (!previous) {
      return false
    }
    claimed.add(previous.name)
    try {
      await clonesOf(previous.name)
      const renamed = await deps.run('orb', ['rename', previous.name, name], { timeoutMs: STEP_MS })
      if (renamed.code !== 0) {
        deps.log?.(`could not rename template ${previous.name}: ${detail(renamed)}`)
        return false
      }
      drop(previous.name)
      return true
    } finally {
      claimed.delete(previous.name)
    }
  }

  const buildOnce = async (
    kind: PodOrbstackTemplateKind,
    key: string,
    provision: PodOrbstackTemplateProvisioner,
    update?: PodOrbstackTemplateUpdater
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
      const { agentVersion } =
        update && (await adopt(kind, key, name)) ? await update(name) : await provision(name)
      const sealed = await deps.run('orb', [
        'run',
        '-m',
        name,
        '-u',
        'root',
        'sh',
        '-c',
        SEAL_TEMPLATE
      ])
      if (sealed.code !== 0) {
        throw new Error(`seal: ${detail(sealed)}`)
      }
      const stopped = await deps.run('orb', ['stop', name], { timeoutMs: STEP_MS })
      if (stopped.code !== 0) {
        throw new Error(`orb stop: ${detail(stopped)}`)
      }
      const ready = { ...entry, state: 'ready' as const, agentVersion }
      put(ready)
      // Clones do not depend on their template, so older templates of this kind can go.
      for (const stale of load().templates.filter((t) => t.kind === kind && t.key !== key)) {
        await clonesOf(stale.name)
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

  /**
   * Builds the template for `key` once; concurrent callers share the build. With `update`, an older
   * template that differs only in its Claude Code version is updated in place instead.
   */
  const build = (
    kind: PodOrbstackTemplateKind,
    key: string,
    provision: PodOrbstackTemplateProvisioner,
    update?: PodOrbstackTemplateUpdater
  ): Promise<PodOrbstackTemplate | null> => {
    if (!load().enabled) {
      return Promise.resolve(null)
    }
    const pending =
      building.get(key) ??
      buildOnce(kind, key, provision, update).finally(() => {
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
    const cloned = step('orb clone', 'orb', ['clone', template.name, name])
    const reading = clones.get(template.name) ?? new Set<Promise<unknown>>()
    clones.set(template.name, reading.add(cloned))
    try {
      await cloned
    } finally {
      reading.delete(cloned)
      if (reading.size === 0) {
        clones.delete(template.name)
      }
    }
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

  const deleteAll = async (): Promise<void> => {
    for (const entry of load().templates) {
      await clonesOf(entry.name)
      await remove(entry.name)
    }
  }

  return {
    find,
    build,
    clone,
    enabled: (): boolean => load().enabled,
    /** Off deletes every template (after builds in flight end); creates then build in full. */
    setEnabled: async (enabled: boolean): Promise<void> => {
      load().enabled = enabled
      save()
      if (!enabled) {
        await Promise.allSettled(building.values())
        await deleteAll()
      }
    },
    building: (key: string): boolean => building.has(key),
    list: (): readonly PodOrbstackTemplate[] => load().templates,
    /** Every recorded template (tests, and the Settings switch). */
    deleteAll
  }
}

export type PodOrbstackTemplates = ReturnType<typeof createPodOrbstackTemplates>
