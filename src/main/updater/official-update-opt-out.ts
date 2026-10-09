import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

// Why a packaged-manifest field (electron-builder extraMetadata) rather than an env var: a personal
// fork signed by another team can never install official releases, and the stamp travels with the build.
export const OFFICIAL_UPDATES_MANIFEST_FIELD = 'orcaOfficialUpdates'

let cachedOptOut: boolean | undefined

/** True only for an explicit `orcaOfficialUpdates: false`; anything unreadable keeps upstream behaviour. */
export function readOfficialUpdatesOptOut(appPath: string): boolean {
  try {
    const manifest: unknown = JSON.parse(readFileSync(join(appPath, 'package.json'), 'utf8'))
    return (
      typeof manifest === 'object' &&
      manifest !== null &&
      Reflect.get(manifest, OFFICIAL_UPDATES_MANIFEST_FIELD) === false
    )
  } catch {
    return false
  }
}

export function isOfficialUpdateFeedDisabled(): boolean {
  if (cachedOptOut === undefined) {
    try {
      cachedOptOut = app.isPackaged && readOfficialUpdatesOptOut(app.getAppPath())
    } catch {
      cachedOptOut = false
    }
  }
  return cachedOptOut
}
