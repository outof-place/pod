import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, dialog, shell } from 'electron'
import {
  PREVIOUS_DAEMON_PROTOCOL_VERSIONS,
  PROTOCOL_VERSION
} from '../daemon/daemon-protocol-version'
import { isBackgroundLaunch } from '../window/foreground-activation-policy'
import { migrateLegacyProfile, PRODUCT_MIGRATION_MARKER } from './legacy-profile-migration'
import { createMacSafeStorageKeychain } from './macos-safe-storage-keychain'
import type { ProductIdentity } from './product-identity'

const PRIVACY_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy'

/** `/Applications/Pod.app/Contents/MacOS/Pod` → `/Applications/Pod.app`. */
export function appBundlePathFromExecPath(execPath: string): string | null {
  const match = /^(.+\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath)
  return match?.[1] ?? null
}

/** Pre-ready setup of a product build; false when startup must stop. */
export function applyProductIdentityPreReady(
  identity: ProductIdentity,
  isServeMode: boolean
): boolean {
  // Why explicit: a downstream product must never resolve to Orca's profile by app name.
  app.setPath('userData', join(app.getPath('appData'), identity.userDataName))
  // Why pre-ready: Electron names the safeStorage keychain item "<app name> Safe Storage" then.
  app.setName(identity.keychainName)
  // Why before the instance lock: Chromium writes its lock files into userData.
  return isServeMode || runProductFirstRun(identity)
}

/**
 * Runs before the instance lock on a product build's first launch. Returns false when startup must
 * stop (the legacy app is still running, so its databases cannot be copied consistently).
 */
export function runProductFirstRun(identity: ProductIdentity): boolean {
  if (!identity.legacyProfile) {
    return true
  }
  const result = migrateLegacyProfile({
    legacyUserData: join(app.getPath('appData'), identity.legacyProfile.userDataName),
    productUserData: app.getPath('userData'),
    legacyKeychainName: identity.legacyProfile.keychainName,
    productKeychainName: identity.keychainName,
    trustedAppPath: appBundlePathFromExecPath(process.execPath),
    keychain: process.platform === 'darwin' ? createMacSafeStorageKeychain() : null,
    attachableDaemonProtocols: [...PREVIOUS_DAEMON_PROTOCOL_VERSIONS, PROTOCOL_VERSION],
    appVersion: app.getVersion()
  })
  console.log(`[product-migration] ${JSON.stringify(result)}`)
  if (result.status === 'blocked') {
    dialog.showErrorBox(
      `${identity.displayName} can't import your Orca profile yet`,
      result.reason === 'legacy-app-running'
        ? `Orca is running (pid ${result.pid}). Quit Orca, then open ${identity.displayName} again.\n\n${identity.displayName} copies your Orca workspaces, settings and running terminals on its first launch. Orca itself is left unchanged.`
        : `Another ${identity.displayName} process (pid ${result.pid}) is importing the Orca profile. Wait for it to finish, then try again.`
    )
    app.exit(0)
    return false
  }
  // Why from the marker: a background launch defers the notice to the next interactive one.
  const marker = readMarker()
  if (marker && Reflect.get(marker, 'permissionsNoticeShown') === false && !isBackgroundLaunch()) {
    void app.whenReady().then(() => showImportNotice(identity, marker))
  }
  return true
}

function readMarker(): object | null {
  try {
    const marker: unknown = JSON.parse(
      readFileSync(join(app.getPath('userData'), PRODUCT_MIGRATION_MARKER), 'utf8')
    )
    return typeof marker === 'object' && marker !== null ? marker : null
  } catch {
    return null
  }
}

async function showImportNotice(identity: ProductIdentity, marker: object): Promise<void> {
  const linkedDaemons = Reflect.get(marker, 'linkedDaemons')
  const daemons = Array.isArray(linkedDaemons) ? linkedDaemons.map(String) : []
  const lines = [
    `${identity.displayName} imported your Orca profile. Orca's own copy was not changed.`,
    daemons.length > 0
      ? `Running terminals were handed over (daemon protocol ${daemons.join(', ')}).`
      : 'No running terminals needed a hand-over.',
    Reflect.get(marker, 'safeStorage') === 'unavailable'
      ? 'Saved sign-ins could not be carried over because keychain access was denied. Sign in again where asked.'
      : 'Saved sign-ins were carried over.',
    `macOS privacy permissions belong to each app, so grant ${identity.displayName} (and its Computer Use helper) Accessibility, Screen Recording, Full Disk Access and Automation again as you need them.`
  ]
  const choice = await dialog.showMessageBox({
    type: 'info',
    message: `Welcome to ${identity.displayName}`,
    detail: lines.join('\n\n'),
    buttons: ['Open Privacy & Security', 'Later'],
    defaultId: 1,
    cancelId: 1
  })
  try {
    writeFileSync(
      join(app.getPath('userData'), PRODUCT_MIGRATION_MARKER),
      `${JSON.stringify({ ...marker, permissionsNoticeShown: true }, null, 2)}\n`
    )
  } catch (error) {
    console.warn('[product-migration] could not update the migration marker', error)
  }
  if (choice.response === 0 && process.platform === 'darwin') {
    await shell.openExternal(PRIVACY_SETTINGS_URL)
  }
}
