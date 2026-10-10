import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'

export type LegacyImportRequest = { requestedAt: string }

/** Beside the profile, not in it: setting the profile aside must not take the request along. */
export function legacyImportRequestPath(appData: string, userDataName: string): string {
  return join(appData, `${userDataName}.import-request.json`)
}

export function writeLegacyImportRequest(path: string, now: Date = new Date()): void {
  writeFileSync(path, `${JSON.stringify({ requestedAt: now.toISOString() })}\n`)
}

/** Reads and removes the request, so a failed import never loops on every launch. */
export function takeLegacyImportRequest(path: string): LegacyImportRequest | null {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  unlinkSync(path)
  try {
    const requestedAt: unknown = Reflect.get(Object(JSON.parse(text)), 'requestedAt')
    return typeof requestedAt === 'string' ? { requestedAt } : null
  } catch {
    return null
  }
}

/**
 * Renames a non-empty profile to `<name> before Orca import <stamp>` so the import starts from an
 * empty one, and returns the new path (null when there was nothing to keep).
 */
export function setProfileAside(appData: string, userDataName: string, now: Date): string | null {
  const userData = join(appData, userDataName)
  if (!existsSync(userData) || readdirSync(userData).length === 0) {
    return null
  }
  const stamp = now.toISOString().slice(0, 19).replace('T', ' ').replaceAll(':', '.')
  const aside = join(appData, `${userDataName} before Orca import ${stamp}`)
  renameSync(userData, aside)
  return aside
}
