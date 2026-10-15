// Fork-only (Pod): the settings a native client edits, read, written and followed over podSettings.*.
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { normalizeComputerAwakeMode } from '../../../shared/computer-awake-mode'
import { normalizeProxyUrl } from '../../../shared/network-proxy'
import { normalizeSourceControlAiSettings } from '../../../shared/source-control-ai-settings'
import { isTuiAgent } from '../../../shared/tui-agent-config'
import {
  POD_SETTINGS_FIELDS,
  PodSettingsValuesSchema,
  type PodSettingsKey,
  type PodSettingsValues
} from '../../../shared/pod-settings-schema'
import { POD_SETTINGS_PAGES } from '../../../shared/pod-settings-pages'
import { POD_SETTINGS_SECRET_KEYS } from '../../../shared/pod-settings-classification'
import {
  projectPodSettingsReadOnly,
  type PodSettingsReadOnly
} from '../../../shared/pod-settings-read-only'

export type PodSettingsStore = {
  getSettings(): GlobalSettings
  onSettingsChanged(listener: (updates: Partial<GlobalSettings>) => void): () => void
}

/** The write path `settings:set` uses (pod-settings-writer.ts): same sanitizing and side effects. */
export type PodSettingsWrite = (values: Partial<GlobalSettings>) => Promise<GlobalSettings>

/** `readOnly`: a mirror of fields for clients from before they were fields (pod-settings-read-only.ts). */
export type PodSettingsSnapshot = {
  revision: string
  values: PodSettingsValues
  readOnly: PodSettingsReadOnly
}

export type PodSettingsSetResult =
  | ({ ok: true } & PodSettingsSnapshot)
  | ({
      ok: false
      reason: 'conflict'
      /** The written keys someone else changed since `baseRevision` (all of them when unknown). */
      conflictingKeys: PodSettingsKey[]
    } & PodSettingsSnapshot)

/** What Pod's network settings show; the URL can carry a password. */
export type PodNetworkProxy = { httpProxyUrl: string; httpProxyBypassRules: string }

export type PodSettingsChange = {
  revision: string
  values: PodSettingsValues
  /** Keys that no longer have a value (the client shows the default). */
  cleared: PodSettingsKey[]
  /** All of them, when one moved. */
  readOnly?: PodSettingsReadOnly
}

// The pages list every field once (pod-settings-pages.test.ts), in a stable order.
const FIELD_KEYS: readonly PodSettingsKey[] = POD_SETTINGS_PAGES.flatMap((page) =>
  page.sections.flatMap((section) => section.keys)
)
const FIELD_SET = new Set<string>(FIELD_KEYS)
const SECRET_KEYS = new Set<string>(POD_SETTINGS_SECRET_KEYS)
/** Written as partial updates merged into what is stored; every other field is written whole. */
const OBJECT_KEYS = new Set<PodSettingsKey>(
  FIELD_KEYS.filter((key) => POD_SETTINGS_FIELDS[key] instanceof z.ZodObject)
)
/** Snapshots kept to tell which keys moved since a client's revision. */
const REMEMBERED_REVISIONS = 64
/** A burst of writes (a slider drag, an import) reaches a subscriber as one change. */
export const POD_SETTINGS_COALESCE_MS = 50

export class PodSettingsRefusedError extends Error {}

export class PodSettingsService {
  private readonly jsonSchema = z.toJSONSchema(PodSettingsValuesSchema, { io: 'input' })
  private writes: Promise<unknown> = Promise.resolve()
  /** Values by the revisions handed out, oldest first. */
  private readonly seen = new Map<string, PodSettingsValues>()

  constructor(
    private readonly store: PodSettingsStore,
    private readonly write: PodSettingsWrite
  ) {}

  schema(): { version: string; jsonSchema: unknown; pages: typeof POD_SETTINGS_PAGES } {
    const version = digest({ jsonSchema: this.jsonSchema, pages: POD_SETTINGS_PAGES })
    return { version, jsonSchema: this.jsonSchema, pages: POD_SETTINGS_PAGES }
  }

  get(): PodSettingsSnapshot {
    const settings = this.store.getSettings()
    const values = project(settings)
    const readOnly = projectPodSettingsReadOnly(settings)
    const revision = revisionOf(values, readOnly)
    this.seen.delete(revision)
    this.seen.set(revision, values)
    if (this.seen.size > REMEMBERED_REVISIONS) {
      this.seen.delete(this.seen.keys().next().value ?? revision)
    }
    return { revision, values, readOnly }
  }

  /**
   * Writes unless one of the keys it writes changed since `baseRevision`; then it writes nothing
   * and hands back the current values. Keys it doesn't write may have moved meanwhile. A revision
   * this runtime no longer remembers (restarted, or 64 snapshots ago) counts as all keys changed.
   */
  set(values: unknown, baseRevision: string): Promise<PodSettingsSetResult> {
    const run = this.writes.then(() => this.setNow(values, baseRevision))
    this.writes = run.catch(() => {})
    return run
  }

  private async setNow(values: unknown, baseRevision: string): Promise<PodSettingsSetResult> {
    const keys = Object.keys(values ?? {})
    const secret = keys.filter((key) => SECRET_KEYS.has(key))
    if (secret.length > 0) {
      throw new PodSettingsRefusedError(`podSettings.set refuses ${secret.join(', ')}`)
    }
    const unknown = keys.filter((key) => !FIELD_SET.has(key))
    if (unknown.length > 0) {
      throw new PodSettingsRefusedError(
        `podSettings.set refuses unknown keys: ${unknown.join(', ')}`
      )
    }
    const parsed = PodSettingsValuesSchema.safeParse(values)
    if (!parsed.success) {
      throw new PodSettingsRefusedError(`podSettings.set refuses: ${parsed.error.message}`)
    }
    const current = this.get()
    const conflicting = this.movedSince(baseRevision, current.values, parsed.data)
    if (conflicting.length > 0) {
      return { ok: false, reason: 'conflict', conflictingKeys: conflicting, ...current }
    }
    // settings:set from a window bypasses this queue. From this check to the store update the write
    // doesn't yield, so nothing lands between, except for alwaysForceDeleteWorktrees: it waits for
    // the durable write queue, and a window's write to it in that wait wins unseen.
    const settings = this.store.getSettings()
    const update: Partial<GlobalSettings> = {}
    for (const key of FIELD_KEYS) {
      const value = parsed.data[key]
      if (value !== undefined) {
        // Spelled out whole: the store replaces most objects, and normalizes a partial one to defaults.
        const merged = OBJECT_KEYS.has(key)
          ? { ...asRecord(stored(settings, key)), ...asRecord(value) }
          : value
        Object.assign(update, { [key]: merged })
      }
    }
    await this.write(update)
    return { ok: true, ...this.get() }
  }

  /** For this machine's own clients only (the RPC refuses paired devices). */
  networkProxy(): PodNetworkProxy {
    const settings = this.store.getSettings()
    return {
      httpProxyUrl: settings.httpProxyUrl ?? '',
      httpProxyBypassRules: settings.httpProxyBypassRules ?? ''
    }
  }

  /** The URL as the network settings pane commits it: trimmed and checked, or refused with its message. */
  setNetworkProxy(url: string): Promise<PodNetworkProxy> {
    const run = this.writes.then(async () => {
      const normalized = normalizeProxyUrl(url)
      if (!normalized.ok) {
        throw new PodSettingsRefusedError(normalized.message)
      }
      await this.write({ httpProxyUrl: normalized.value })
      return this.networkProxy()
    })
    this.writes = run.catch(() => {})
    return run
  }

  /** The written keys (and, for an object, its written fields) that differ from `base`'s values. */
  private movedSince(
    baseRevision: string,
    current: PodSettingsValues,
    written: PodSettingsValues
  ): PodSettingsKey[] {
    const keys = FIELD_KEYS.filter((key) => written[key] !== undefined)
    const base = this.seen.get(baseRevision)
    if (!base) {
      return revisionOf(current, projectPodSettingsReadOnly(this.store.getSettings())) ===
        baseRevision
        ? []
        : keys
    }
    return keys.filter((key) => {
      if (OBJECT_KEYS.has(key)) {
        const fields = Object.keys(asRecord(written[key]))
        return fields.some(
          (field) =>
            JSON.stringify(asRecord(base[key])[field]) !==
            JSON.stringify(asRecord(current[key])[field])
        )
      }
      return JSON.stringify(base[key]) !== JSON.stringify(current[key])
    })
  }

  /**
   * `onChange` gets the changed fields only, coalesced; never hidden or secret keys. A read that
   * fails goes to `onError` and the subscription stays: the next change tries again.
   */
  subscribe(
    onChange: (change: PodSettingsChange) => void,
    onError: (message: string) => void = () => {}
  ): {
    snapshot: PodSettingsSnapshot
    unsubscribe: () => void
  } {
    let last = this.get()
    let timer: ReturnType<typeof setTimeout> | null = null
    const flush = (): void => {
      timer = null
      let next: PodSettingsSnapshot
      try {
        next = this.get()
      } catch (error) {
        onError(error instanceof Error ? error.message : String(error))
        return
      }
      if (next.revision === last.revision) {
        return
      }
      const change = diff(last.values, next.values)
      const readOnlyMoved = JSON.stringify(last.readOnly) !== JSON.stringify(next.readOnly)
      last = next
      onChange({
        revision: next.revision,
        ...change,
        ...(readOnlyMoved && { readOnly: next.readOnly })
      })
    }
    const stop = this.store.onSettingsChanged(() => {
      if (!timer) {
        timer = setTimeout(flush, POD_SETTINGS_COALESCE_MS)
        // A pending fold never keeps a quitting runtime up.
        timer.unref?.()
      }
    })
    return {
      snapshot: last,
      unsubscribe: () => {
        stop()
        if (timer) {
          clearTimeout(timer)
        }
      }
    }
  }
}

/** The fields' current values: valid ones only, so a client never decodes a value its schema lacks. */
function project(settings: GlobalSettings): PodSettingsValues {
  const values: Record<string, unknown> = {}
  for (const key of FIELD_KEYS) {
    const raw = shown(settings, key)
    const parsed = POD_SETTINGS_FIELDS[key].safeParse(raw)
    if (raw !== undefined && parsed.success) {
      values[key] = parsed.data
    }
  }
  return PodSettingsValuesSchema.parse(values)
}

/** A key's stored value as the desktop reads it. */
function stored(settings: GlobalSettings, key: PodSettingsKey): unknown {
  if (key === 'computerAwakeMode') {
    return normalizeComputerAwakeMode(
      settings.computerAwakeMode,
      settings.keepComputerAwakeWhileAgentsRun
    )
  }
  if (key === 'sourceControlAi') {
    return normalizeSourceControlAiSettings(settings.sourceControlAi, settings.commitMessageAi)
  }
  return settings[key]
}

/** What a client sees of it: an object's own fields, and agents this build still knows. */
function shown(settings: GlobalSettings, key: PodSettingsKey): unknown {
  const value = stored(settings, key)
  if (value === undefined || !OBJECT_KEYS.has(key)) {
    return key === 'agentCmdOverrides' || key === 'agentDefaultArgs' ? knownAgents(value) : value
  }
  const object = asRecord(value)
  const schema = POD_SETTINGS_FIELDS[key]
  const fields = schema instanceof z.ZodObject ? Object.keys(schema.shape) : []
  return Object.fromEntries(
    fields.map((field) => [
      field,
      field === 'selectedModelByAgent' ? knownAgents(object[field]) : object[field]
    ])
  )
}

/** A per-agent map without agents Pod no longer has, so one stale entry doesn't hide the rest. */
function knownAgents(value: unknown): unknown {
  if (value === undefined) {
    return undefined
  }
  return Object.fromEntries(Object.entries(asRecord(value)).filter(([agent]) => isTuiAgent(agent)))
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {}
}

function diff(
  before: PodSettingsValues,
  after: PodSettingsValues
): Pick<PodSettingsChange, 'values' | 'cleared'> {
  const values: Record<string, unknown> = {}
  const cleared: PodSettingsKey[] = []
  for (const key of FIELD_KEYS) {
    if (after[key] === undefined) {
      if (before[key] !== undefined) {
        cleared.push(key)
      }
    } else if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      values[key] = after[key]
    }
  }
  return { values: PodSettingsValuesSchema.parse(values), cleared }
}

// Why a digest of the values, not a counter: it holds across runtime restarts, and writes that
// skip the change listeners still move it.
function revisionOf(values: PodSettingsValues, readOnly: PodSettingsReadOnly): string {
  return digest([...FIELD_KEYS.map((key) => [key, values[key] ?? null]), ['readOnly', readOnly]])
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16)
}

let installed: PodSettingsService | null = null

/** Installed by the Electron side at startup (install-pod-settings.ts); null outside Pod builds. */
export function setPodSettingsService(service: PodSettingsService | null): void {
  installed = service
}

export function getPodSettingsService(): PodSettingsService | null {
  return installed
}
