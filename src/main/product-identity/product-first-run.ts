import { existsSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app, dialog, shell } from 'electron'
import { PREVIOUS_DAEMON_PROTOCOL_VERSIONS } from '../daemon/daemon-protocol-version'
import { getMainE2EConfig } from '../e2e-config'
import { setAppBundleId } from '../../shared/app-identity'
import { isBackgroundLaunch } from '../window/foreground-activation-policy'
import { claudeProfileKeychainServices } from '../claude-accounts/claude-profile-keychain-services'
import { getKeychainUser } from '../claude-accounts/keychain'
import { listClaudeProfileIds, moveClaudeProfileCredentials } from './claude-credentials-move'
import {
  pendingDeferredImport,
  readMigrationMarker,
  runDeferredProfileImport,
  updateMigrationMarker
} from './deferred-profile-import'
import { openImportProgressWindow } from './import-progress-window'
import { offerLegacyDaemonHandover } from './legacy-daemon-handover-prompt'
import { moveLegacyHome } from './legacy-home-move'
import {
  legacyImportRequestPath,
  setProfileAside,
  takeLegacyImportRequest
} from './legacy-import-request'
import {
  liveSingletonOwner,
  migrateLegacyProfile,
  type SafeStorageKeychainPort
} from './legacy-profile-migration'
import { createMacSafeStorageKeychain } from './macos-safe-storage-keychain'
import { getProductIdentity, type ProductIdentity } from './product-identity'

const PRIVACY_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy'
// One-time record in userData: the imported Claude profiles' sign-ins moved (or there were none).
const CLAUDE_CREDENTIALS_MOVE_RECORD = 'product-claude-credentials-move.json'

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
  // Why first: TCC, defaults and notification settings must name the product, never Orca.
  setAppBundleId(identity.appId)
  // Why explicit: a downstream product must never resolve to Orca's profile by app name.
  app.setPath('userData', join(app.getPath('appData'), identity.userDataName))
  // Why pre-ready: Electron names the safeStorage keychain item "<app name> Safe Storage" then.
  app.setName(identity.keychainName)
  // Why before the instance lock: Chromium writes its lock files into userData.
  return isServeMode || runProductFirstRun(identity)
}

/**
 * Pre-ready product setup: the profile import ("Import from Orca…" restarts into it; never on its
 * own), then the one-time move of the legacy home folder. Returns false when startup must stop.
 * `scratch` points an E2E run at a disposable legacy profile (imported when asked) and keeps the
 * login keychain out of it.
 */
export function runProductFirstRun(
  identity: ProductIdentity,
  scratch: {
    legacyUserData: string
    keychain: SafeStorageKeychainPort | null
    importLegacyProfile: boolean
  } | null = null
): boolean {
  const legacy = identity.legacyProfile
  if (!legacy) {
    return true
  }
  const appData = app.getPath('appData')
  const legacyUserData = scratch?.legacyUserData ?? join(appData, legacy.userDataName)
  const requested = scratch
    ? scratch.importLegacyProfile
    : takeLegacyImportRequest(legacyImportRequestPath(appData, identity.userDataName)) !== null
  if (requested && !importLegacyProfile(identity, legacyUserData, scratch)) {
    return false
  }
  if (legacy.homeDirName && identity.homeDirName) {
    try {
      const result = moveLegacyHome({
        home: homedir(),
        legacyHomeDirName: legacy.homeDirName,
        productHomeDirName: identity.homeDirName,
        productUserData: app.getPath('userData'),
        legacyAppPid: liveSingletonOwner(legacyUserData)
      })
      console.log(`[product-decouple] home folder: ${JSON.stringify(result)}`)
    } catch (error) {
      // Why continue: the move records itself only when it finishes, so the next launch retries.
      console.error('[product-decouple] home folder move failed', error)
    }
  }
  return true
}

function importLegacyProfile(
  identity: ProductIdentity,
  legacyUserData: string,
  scratch: { keychain: SafeStorageKeychainPort | null } | null
): boolean {
  const legacyPid = liveSingletonOwner(legacyUserData)
  if (legacyPid !== null) {
    dialog.showErrorBox(
      `${identity.displayName} can't import your Orca profile yet`,
      `Orca is running (pid ${legacyPid}). Quit Orca, then choose Import from Orca… again.`
    )
    return true
  }
  const appData = app.getPath('appData')
  if (!scratch) {
    const ownPid = liveSingletonOwner(app.getPath('userData'))
    if (ownPid !== null && ownPid !== process.pid) {
      dialog.showErrorBox(
        `${identity.displayName} can't import your Orca profile yet`,
        `Another ${identity.displayName} process (pid ${ownPid}) is using the profile. Quit it, then choose Import from Orca… again.`
      )
      return true
    }
    const aside = setProfileAside(appData, identity.userDataName, new Date())
    console.log(`[product-migration] previous profile kept at ${aside ?? '(none)'}`)
  }
  const started = performance.now()
  const result = migrateLegacyProfile({
    legacyUserData,
    productUserData: app.getPath('userData'),
    legacyKeychainName: identity.legacyProfile?.keychainName ?? identity.keychainName,
    productKeychainName: identity.keychainName,
    trustedAppPath: appBundlePathFromExecPath(process.execPath),
    keychain: scratch
      ? scratch.keychain
      : process.platform === 'darwin'
        ? createMacSafeStorageKeychain()
        : null,
    attachableDaemonProtocols: PREVIOUS_DAEMON_PROTOCOL_VERSIONS,
    appVersion: app.getVersion()
  })
  console.log(
    `[product-migration] ${JSON.stringify(result)} in ${Math.round(performance.now() - started)}ms`
  )
  if (result.status === 'blocked') {
    dialog.showErrorBox(
      `${identity.displayName} can't import your Orca profile yet`,
      result.reason === 'legacy-app-running'
        ? `Orca is running (pid ${result.pid}). Quit Orca, then choose Import from Orca… again.`
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
  moveClaudeCredentialsOnce(identity, userData)
  try {
    await offerLegacyDaemonHandover(identity, userData)
  } catch (error) {
    // Why continue: a failed handover leaves the daemons with Orca, which is the safe default.
    console.error('[product-migration] daemon handover failed', error)
  }
  const marker = readMigrationMarker(userData)
  // Why from the marker: a background launch defers the notice to the next interactive one.
  if (marker?.permissionsNoticeShown === false && !isBackgroundLaunch()) {
    void showImportNotice(identity, marker)
  }
}

function moveClaudeCredentialsOnce(identity: ProductIdentity, userData: string): void {
  const legacy = identity.legacyProfile
  const recordPath = join(userData, CLAUDE_CREDENTIALS_MOVE_RECORD)
  // Why never under E2E: the login keychain holds the user's real accounts.
  if (
    process.platform !== 'darwin' ||
    getMainE2EConfig().userDataDir ||
    !legacy ||
    existsSync(recordPath)
  ) {
    return
  }
  const legacyUserData = join(app.getPath('appData'), legacy.userDataName)
  try {
    const profiles = listClaudeProfileIds(userData).map((id) => ({
      id,
      legacyServices: claudeProfileKeychainServices(legacyUserData, id).spellings,
      productService: claudeProfileKeychainServices(userData, id).canonical
    }))
    const result = moveClaudeProfileCredentials({
      profiles,
      keychainAccount: getKeychainUser(),
      trustedAppPath: appBundlePathFromExecPath(process.execPath),
      legacyAppPid: liveSingletonOwner(legacyUserData),
      keychain: createMacSafeStorageKeychain()
    })
    console.log(`[product-decouple] Claude sign-ins: ${JSON.stringify(result)}`)
    if (result.status !== 'deferred') {
      writeFileSync(recordPath, `${JSON.stringify({ at: new Date().toISOString(), result })}\n`)
    }
  } catch (error) {
    console.error('[product-decouple] Claude sign-in move failed', error)
  }
}

async function showImportNotice(
  identity: ProductIdentity,
  marker: Record<string, unknown>
): Promise<void> {
  const handover: unknown = Reflect.get(Object(marker.daemonHandover), 'decision')
  const lines = [
    `${identity.displayName} imported your Orca profile. Orca's own copy was not changed.`,
    handover === 'moved'
      ? `Running terminals moved from Orca to ${identity.displayName}.`
      : `Running terminals stayed with Orca; ${identity.displayName} starts its own.`,
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
