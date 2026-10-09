import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cloneProfileEntries, type CloneProgress, DEFERRED_PROFILE_ENTRIES } from './profile-clone'

// Second half of the product import: clones what the pre-ready half deferred asynchronously after
// `ready`, before any window, browser session or service can touch those directories.

export const PRODUCT_MIGRATION_MARKER = 'product-profile-migration.json'

export type DeferredProfileImport = { legacyUserData: string; entries: string[] }
export type DeferredImportProgress = CloneProgress

function readMarker(productUserData: string): Record<string, unknown> | null {
  try {
    const marker: unknown = JSON.parse(
      readFileSync(join(productUserData, PRODUCT_MIGRATION_MARKER), 'utf8')
    )
    return typeof marker === 'object' && marker !== null ? { ...marker } : null
  } catch {
    return null
  }
}

export function updateMigrationMarker(
  productUserData: string,
  patch: Record<string, unknown>
): void {
  const marker = readMarker(productUserData)
  if (marker) {
    writeFileSync(
      join(productUserData, PRODUCT_MIGRATION_MARKER),
      `${JSON.stringify({ ...marker, ...patch }, null, 2)}\n`
    )
  }
}

export function readMigrationMarker(productUserData: string): Record<string, unknown> | null {
  return readMarker(productUserData)
}

/** What the marker says is still to be cloned; null when nothing is pending. */
export function pendingDeferredImport(productUserData: string): DeferredProfileImport | null {
  const marker = readMarker(productUserData)
  const from = marker?.from
  const deferred = marker?.deferred
  if (typeof from !== 'string' || !Array.isArray(deferred) || deferred.length === 0) {
    return null
  }
  const entries = deferred.filter(
    (entry): entry is string =>
      typeof entry === 'string' &&
      DEFERRED_PROFILE_ENTRIES.includes(entry) &&
      existsSync(join(from, entry))
  )
  return { legacyUserData: from, entries }
}

/** Clones the deferred entries; files Chromium already created are left alone, never overwritten. */
export async function runDeferredProfileImport(
  productUserData: string,
  pending: DeferredProfileImport,
  onProgress: (progress: DeferredImportProgress) => void = () => {}
): Promise<DeferredImportProgress> {
  const progress = await cloneProfileEntries(
    pending.legacyUserData,
    productUserData,
    pending.entries,
    onProgress
  )
  updateMigrationMarker(productUserData, {
    deferred: [],
    deferredCompletedAt: new Date().toISOString()
  })
  return progress
}
