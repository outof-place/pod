// Fork-only (Pod): the record of past imports, in Pod's userData; Orca's side keeps none.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PodOrcaImportItemOutcome } from '../../../shared/pod-orca-import-types'

export const ORCA_IMPORT_RECORD_FILE = 'orca-import.json'
const KEPT_IMPORTS = 20

export type OrcaImportRecordEntry = {
  at: string
  source: { userData: string; profileId: string; revision: string }
  imported: string[]
  failed: string[]
}

type OrcaImportRecord = { version: 1; imports: OrcaImportRecordEntry[] }

function isEntry(value: unknown): value is OrcaImportRecordEntry {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof Reflect.get(value, 'at') === 'string' &&
    Array.isArray(Reflect.get(value, 'imported'))
  )
}

function readRecord(userData: string): OrcaImportRecord {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(userData, ORCA_IMPORT_RECORD_FILE), 'utf8')
    )
    const imports: unknown =
      parsed !== null && typeof parsed === 'object' ? Reflect.get(parsed, 'imports') : null
    return { version: 1, imports: Array.isArray(imports) ? imports.filter(isEntry) : [] }
  } catch {
    return { version: 1, imports: [] }
  }
}

export function lastOrcaImportAt(userData: string): string | null {
  return readRecord(userData).imports.at(-1)?.at ?? null
}

export function appendOrcaImportRecord(
  userData: string,
  source: OrcaImportRecordEntry['source'],
  results: readonly PodOrcaImportItemOutcome[],
  at: Date
): OrcaImportRecordEntry {
  const entry: OrcaImportRecordEntry = {
    at: at.toISOString(),
    source,
    imported: results.filter((result) => result.outcome === 'imported').map((result) => result.id),
    failed: results.filter((result) => result.outcome === 'failed').map((result) => result.id)
  }
  const record = readRecord(userData)
  record.imports = [...record.imports, entry].slice(-KEPT_IMPORTS)
  mkdirSync(userData, { recursive: true })
  const path = join(userData, ORCA_IMPORT_RECORD_FILE)
  const staging = `${path}.${process.pid}.tmp`
  writeFileSync(staging, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
  renameSync(staging, path)
  return entry
}
