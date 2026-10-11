// Fork-only (Pod): the settings a native client edits, read, written and followed over podSettings.*.
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { normalizeComputerAwakeMode } from '../../../shared/computer-awake-mode'
import {
  POD_SETTINGS_FIELDS,
  PodSettingsValuesSchema,
  type PodSettingsKey,
  type PodSettingsValues
} from '../../../shared/pod-settings-schema'
import { POD_SETTINGS_PAGES } from '../../../shared/pod-settings-pages'
import { POD_SETTINGS_SECRET_KEYS } from '../../../shared/pod-settings-classification'

export type PodSettingsStore = {
  getSettings(): GlobalSettings
  onSettingsChanged(listener: (updates: Partial<GlobalSettings>) => void): () => void
}

/** The write path `settings:set` uses (pod-settings-writer.ts): same sanitizing and side effects. */
export type PodSettingsWrite = (values: Partial<GlobalSettings>) => Promise<GlobalSettings>

export type PodSettingsSnapshot = { revision: string; values: PodSettingsValues }

export type PodSettingsSetResult =
  | ({ ok: true } & PodSettingsSnapshot)
  | ({ ok: false; reason: 'conflict' } & PodSettingsSnapshot)

export type PodSettingsChange = {
  revision: string
  values: PodSettingsValues
  /** Keys that no longer have a value (the client shows the default). */
  cleared: PodSettingsKey[]
}

// The pages list every field once (pod-settings-pages.test.ts), in a stable order.
const FIELD_KEYS: readonly PodSettingsKey[] = POD_SETTINGS_PAGES.flatMap((page) =>
  page.sections.flatMap((section) => section.keys)
)
const SECRET_KEYS = new Set<string>(POD_SETTINGS_SECRET_KEYS)
/** A burst of writes (a slider drag, an import) reaches a subscriber as one change. */
export const POD_SETTINGS_COALESCE_MS = 50

export class PodSettingsRefusedError extends Error {}

export class PodSettingsService {
  private readonly jsonSchema = z.toJSONSchema(PodSettingsValuesSchema, { io: 'input' })
  private writes: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly store: PodSettingsStore,
    private readonly write: PodSettingsWrite
  ) {}

  schema(): { version: string; jsonSchema: unknown; pages: typeof POD_SETTINGS_PAGES } {
    const version = digest({ jsonSchema: this.jsonSchema, pages: POD_SETTINGS_PAGES })
    return { version, jsonSchema: this.jsonSchema, pages: POD_SETTINGS_PAGES }
  }

  get(): PodSettingsSnapshot {
    const values = project(this.store.getSettings())
    return { revision: revisionOf(values), values }
  }

  /** Writes only when `baseRevision` is the values' revision now; else hands back the current ones. */
  set(values: unknown, baseRevision: string): Promise<PodSettingsSetResult> {
    const run = this.writes.then(() => this.setNow(values, baseRevision))
    this.writes = run.catch(() => {})
    return run
  }

  private async setNow(values: unknown, baseRevision: string): Promise<PodSettingsSetResult> {
    const refused = Object.keys(values ?? {}).filter((key) => SECRET_KEYS.has(key))
    if (refused.length > 0) {
      throw new PodSettingsRefusedError(`podSettings.set refuses ${refused.join(', ')}`)
    }
    const parsed = PodSettingsValuesSchema.safeParse(values)
    if (!parsed.success) {
      throw new PodSettingsRefusedError(`podSettings.set refuses: ${parsed.error.message}`)
    }
    const current = this.get()
    if (current.revision !== baseRevision) {
      return { ok: false, reason: 'conflict', ...current }
    }
    const { notifications, ...rest } = parsed.data
    // The store merges a partial notifications object too; spelled out, the update is whole.
    await this.write(
      notifications
        ? {
            ...rest,
            notifications: { ...this.store.getSettings().notifications, ...notifications }
          }
        : rest
    )
    return { ok: true, ...this.get() }
  }

  /** `onChange` gets the changed fields only, coalesced; never hidden or secret keys. */
  subscribe(onChange: (change: PodSettingsChange) => void): {
    snapshot: PodSettingsSnapshot
    unsubscribe: () => void
  } {
    let last = this.get()
    let timer: ReturnType<typeof setTimeout> | null = null
    const flush = (): void => {
      timer = null
      const next = this.get()
      if (next.revision === last.revision) {
        return
      }
      const change = diff(last.values, next.values)
      last = next
      onChange({ revision: next.revision, ...change })
    }
    const stop = this.store.onSettingsChanged(() => {
      timer ??= setTimeout(flush, POD_SETTINGS_COALESCE_MS)
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
  const raw: Record<string, unknown> = {}
  for (const key of FIELD_KEYS) {
    raw[key] =
      key === 'computerAwakeMode'
        ? normalizeComputerAwakeMode(
            settings.computerAwakeMode,
            settings.keepComputerAwakeWhileAgentsRun
          )
        : key === 'notifications'
          ? pickNotifications(settings.notifications)
          : settings[key]
  }
  const values: Record<string, unknown> = {}
  for (const key of FIELD_KEYS) {
    const parsed = POD_SETTINGS_FIELDS[key].safeParse(raw[key])
    if (raw[key] !== undefined && parsed.success) {
      values[key] = parsed.data
    }
  }
  return PodSettingsValuesSchema.parse(values)
}

function pickNotifications(value: GlobalSettings['notifications'] | undefined): unknown {
  if (!value) {
    return undefined
  }
  const shape = POD_SETTINGS_FIELDS.notifications.shape
  return Object.fromEntries(Object.keys(shape).map((key) => [key, Reflect.get(value, key)]))
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
function revisionOf(values: PodSettingsValues): string {
  return digest(FIELD_KEYS.map((key) => [key, values[key] ?? null]))
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
