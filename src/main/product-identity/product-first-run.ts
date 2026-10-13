import { existsSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app, dialog, Notification, shell } from 'electron'
import { PREVIOUS_DAEMON_PROTOCOL_VERSIONS } from '../daemon/daemon-protocol-version'
import { getMainE2EConfig } from '../e2e-config'
import { setAppBundleId } from '../../shared/app-identity'
import { isBackgroundLaunch } from '../window/foreground-activation-policy'
import { podMainInstanceBlock } from '../pod/instance/pod-instance'
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
import { watchMovedDaemons, type DaemonLoss } from './legacy-daemon-loss-watch'
import { moveLegacyHome } from './legacy-home-move'
import {
  liveSingletonOwner,
  migrateLegacyProfile,
  type SafeStorageKeychainPort
} from './legacy-profile-migration'
import { createMacSafeStorageKeychain } from './macos-safe-storage-keychain'
import { getProductIdentity, type ProductIdentity } from './product-identity'
import { installProductCopyBoundaries } from './product-copy-boundaries'

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
  // Why pre-ready: IPC handlers register after ready, each through the branded registrar.
  installProductCopyBoundaries()
  // Why before the instance lock: Chromium writes its lock files into userData.
  if (isServeMode) {
    // Fork-only (Pod): one-app Pod's runtime is a serve host, so it moves the home too (the gate
    // turns other serve hosts away).
    const legacy = identity.legacyProfile
    if (legacy) {
      moveLegacyHomeOnce(identity, join(app.getPath('appData'), legacy.userDataName))
    }
    return true
  }
  return runProductFirstRun(identity)
}

/**
 * Pre-ready product setup: the one-time move of the legacy home folder. Pod never imports the
 * legacy profile; only an E2E run does, through `scratch`, which points it at a disposable legacy
 * profile and keeps the login keychain out of it. Returns false when startup must stop.
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
  const legacyUserData =
    scratch?.legacyUserData ?? join(app.getPath('appData'), legacy.userDataName)
  if (scratch?.importLegacyProfile && !importLegacyProfile(identity, legacyUserData, scratch)) {
    return false
  }
  moveLegacyHomeOnce(identity, legacyUserData)
  return true
}

function moveLegacyHomeOnce(identity: ProductIdentity, legacyUserData: string): void {
  const legacyHomeDirName = identity.legacyProfile?.homeDirName
  if (!legacyHomeDirName || !identity.homeDirName) {
    return
  }
  // Why only the user's own Pod: a dev, bench or custom-profile build shares the account's home.
  const block = podMainInstanceBlock()
  if (block !== null) {
    console.log(`[product-decouple] home folder left alone: ${block}`)
    return
  }
  try {
    const result = moveLegacyHome({
      home: homedir(),
      legacyHomeDirName,
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

/** E2E only: imports the scratch legacy profile into the product's. */
function importLegacyProfile(
  identity: ProductIdentity,
  legacyUserData: string,
  scratch: { keychain: SafeStorageKeychainPort | null }
): boolean {
  const legacyPid = liveSingletonOwner(legacyUserData)
  if (legacyPid !== null) {
    console.error(`[product-migration] legacy profile in use by pid ${legacyPid}; not imported`)
    return true
  }
  const started = performance.now()
  const result = migrateLegacyProfile({
    legacyUserData,
    productUserData: app.getPath('userData'),
    legacyKeychainName: identity.legacyProfile?.keychainName ?? identity.keychainName,
    productKeychainName: identity.keychainName,
    trustedAppPath: appBundlePathFromExecPath(process.execPath),
    keychain: scratch.keychain,
    attachableDaemonProtocols: PREVIOUS_DAEMON_PROTOCOL_VERSIONS,
    appVersion: app.getVersion()
  })
  console.log(
    `[product-migration] ${JSON.stringify(result)} in ${Math.round(performance.now() - started)}ms`
  )
  if (result.status === 'blocked') {
    console.error(`[product-migration] import blocked: ${result.reason} (pid ${result.pid})`)
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
  try {
    watchMovedDaemons({ userData, onLost: (loss) => notifyDaemonLoss(identity, loss) })
  } catch (error) {
    console.warn('[product-migration] could not watch the moved daemons', error)
  }
  const marker = readMigrationMarker(userData)
  // Why from the marker: a background launch defers the notice to the next interactive one.
  if (marker?.permissionsNoticeShown === false && !isBackgroundLaunch()) {
    void showImportNotice(identity, marker)
  }
}

// Why a notification: it never takes the foreground, and a loss can happen at any time.
function notifyDaemonLoss(identity: ProductIdentity, loss: DaemonLoss): void {
  if (!Notification.isSupported()) {
    return
  }
  const name = identity.displayName
  new Notification({
    title: 'Terminals moved from Orca have closed',
    body: `Their terminal service (pid ${loss.pid}) ${loss.reason ? `stopped on ${loss.reason}` : 'was killed'}, and ${name} did not stop it. New terminals open in ${name}'s own service.`
  }).show()
}

function moveClaudeCredentialsOnce(identity: ProductIdentity, userData: string): void {
  const legacy = identity.legacyProfile
  const recordPath = join(userData, CLAUDE_CREDENTIALS_MOVE_RECORD)
  // Why never under E2E or outside the user's own Pod: the login keychain is the account's, and a
  // dev profile cloned from the user's lists the same profile ids.
  if (
    process.platform !== 'darwin' ||
    getMainE2EConfig().userDataDir ||
    !legacy ||
    existsSync(recordPath) ||
    podMainInstanceBlock() !== null
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
      // Why no trusted app: Claude reads and rewrites the item through /usr/bin/security, as when
      // it creates the item itself (without -T).
      trustedAppPath: null,
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
