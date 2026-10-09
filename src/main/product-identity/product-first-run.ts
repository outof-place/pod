import { join } from 'node:path'
import { app, dialog, shell } from 'electron'
import {
  PREVIOUS_DAEMON_PROTOCOL_VERSIONS,
  PROTOCOL_VERSION
} from '../daemon/daemon-protocol-version'
import { isBackgroundLaunch } from '../window/foreground-activation-policy'
import {
  pendingDeferredImport,
  readMigrationMarker,
  runDeferredProfileImport,
  updateMigrationMarker
} from './deferred-profile-import'
import { openImportProgressWindow } from './import-progress-window'
import { migrateLegacyProfile } from './legacy-profile-migration'
import { createMacSafeStorageKeychain } from './macos-safe-storage-keychain'
import { getProductIdentity, type ProductIdentity } from './product-identity'

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
 * The synchronous half of the first-launch import (state, daemons, keychain). Returns false when
 * startup must stop: the legacy app is still running, so its databases cannot be copied consistently.
 */
export function runProductFirstRun(identity: ProductIdentity): boolean {
  if (!identity.legacyProfile) {
    return true
  }
  const started = performance.now()
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
  console.log(
    `[product-migration] ${JSON.stringify(result)} in ${Math.round(performance.now() - started)}ms`
  )
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
  return true
}

/**
 * The asynchronous half: clones the deferred entries (browser partitions, large stores) behind a
 * small progress window, then shows the one-time permissions notice. Awaited after `ready`, before
 * the first window.
 */
export async function completeProductImportBeforeWindows(): Promise<void> {
  const identity = getProductIdentity()
  if (!identity?.legacyProfile) {
    return
  }
  const userData = app.getPath('userData')
  const pending = pendingDeferredImport(userData)
  if (pending) {
    const started = performance.now()
    const progressWindow = isBackgroundLaunch() ? null : openImportProgressWindow(identity)
    try {
      const done = await runDeferredProfileImport(userData, pending, (progress) =>
        progressWindow?.update(progress)
      )
      console.log(
        `[product-migration] deferred ${pending.entries.join(',')}: ${done.copied}/${done.total} files in ${Math.round(performance.now() - started)}ms`
      )
    } catch (error) {
      // Why continue: the marker keeps the entries pending, so the next launch fills in what is missing.
      console.error('[product-migration] deferred import failed', error)
    } finally {
      progressWindow?.close()
    }
  }
  const marker = readMigrationMarker(userData)
  // Why from the marker: a background launch defers the notice to the next interactive one.
  if (marker?.permissionsNoticeShown === false && !isBackgroundLaunch()) {
    void showImportNotice(identity, marker)
  }
}

async function showImportNotice(
  identity: ProductIdentity,
  marker: Record<string, unknown>
): Promise<void> {
  const daemons = Array.isArray(marker.linkedDaemons) ? marker.linkedDaemons.map(String) : []
  const lines = [
    `${identity.displayName} imported your Orca profile. Orca's own copy was not changed.`,
    daemons.length > 0
      ? `Running terminals were handed over (daemon protocol ${daemons.join(', ')}).`
      : 'No running terminals needed a hand-over.',
    marker.safeStorage === 'unavailable'
      ? 'Saved sign-ins could not be carried over because keychain access was denied. Sign in again where asked.'
      : 'Saved sign-ins were carried over.',
    `macOS privacy permissions belong to each app, so grant ${identity.displayName} (and ${identity.computerUseDisplayName ?? 'its Computer Use helper'}) Accessibility, Screen Recording, Full Disk Access and Automation again as you need them.`
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
    updateMigrationMarker(app.getPath('userData'), { permissionsNoticeShown: true })
  } catch (error) {
    console.warn('[product-migration] could not update the migration marker', error)
  }
  if (choice.response === 0 && process.platform === 'darwin') {
    await shell.openExternal(PRIVACY_SETTINGS_URL)
  }
}
