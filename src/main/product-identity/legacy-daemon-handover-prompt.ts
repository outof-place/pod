import { dialog } from 'electron'
import { PREVIOUS_DAEMON_PROTOCOL_VERSIONS } from '../daemon/daemon-protocol-version'
import { isBackgroundLaunch } from '../window/foreground-activation-policy'
import { readMigrationMarker, updateMigrationMarker } from './deferred-profile-import'
import {
  findAdoptableDaemons,
  isMovedDaemon,
  moveLegacyDaemons,
  type MovedDaemon
} from './legacy-daemon-handover'
import { liveSingletonOwner } from './legacy-profile-migration'
import type { ProductIdentity } from './product-identity'

/** Moves the legacy app's running terminals without asking (scripted migrations). */
export const ADOPT_LEGACY_TERMINALS_ENV = 'POD_ADOPT_ORCA_TERMINALS'

// Why older protocols only: a daemon at this build's own protocol would be treated as the
// product's current daemon, which version checks may replace.
const ATTACHABLE = PREVIOUS_DAEMON_PROTOCOL_VERSIONS

async function askToMove(identity: ProductIdentity, count: number): Promise<boolean> {
  const name = identity.displayName
  const choice = await dialog.showMessageBox({
    type: 'question',
    message: 'Move running terminals from Orca?',
    detail: [
      `Orca left ${count === 1 ? 'a terminal service' : `${count} terminal services`} running. Moving ${count === 1 ? 'it' : 'them'} lets ${name} reopen your running terminals. Orca then starts with fresh terminals, so the two apps never share one.`,
      `If you keep them in Orca, ${name} starts fresh terminals and Orca keeps its own.`
    ].join('\n\n'),
    buttons: ['Keep Them in Orca', 'Move Running Terminals from Orca'],
    defaultId: 0,
    cancelId: 0
  })
  return choice.response === 1
}

/**
 * Offers, once, to move the legacy app's live daemons into the product. Runs after `ready` and
 * before the product's daemon provider starts; the legacy app must not be running.
 */
export async function offerLegacyDaemonHandover(
  identity: ProductIdentity,
  userData: string
): Promise<void> {
  const marker = readMigrationMarker(userData)
  const legacyUserData = marker?.from
  const forced = process.env[ADOPT_LEGACY_TERMINALS_ENV] === '1'
  if (typeof legacyUserData !== 'string' || (marker?.daemonHandover !== undefined && !forced)) {
    return
  }
  const candidates = findAdoptableDaemons(legacyUserData, new Set(ATTACHABLE))
  const legacyAppPid = liveSingletonOwner(legacyUserData)
  // Why not recorded: with Orca running, nothing to move, or nobody to ask, the question waits.
  if (candidates.length === 0 || legacyAppPid !== null || (!forced && isBackgroundLaunch())) {
    return
  }
  if (!forced && !(await askToMove(identity, candidates.length))) {
    updateMigrationMarker(userData, {
      daemonHandover: { decision: 'kept', at: new Date().toISOString() }
    })
    return
  }
  const result = moveLegacyDaemons({
    legacyUserData,
    productUserData: userData,
    attachableDaemonProtocols: ATTACHABLE,
    legacyAppPid: liveSingletonOwner(legacyUserData)
  })
  console.log(`[product-migration] daemon handover ${JSON.stringify(result)}`)
  if (result.status !== 'moved') {
    return
  }
  const previous: unknown = Reflect.get(Object(marker?.daemonHandover), 'moved')
  const moved: MovedDaemon[] = [
    ...(Array.isArray(previous) ? previous.filter(isMovedDaemon) : []),
    ...result.moved
  ]
  updateMigrationMarker(userData, {
    daemonHandover: {
      decision: 'moved',
      at: new Date().toISOString(),
      moved,
      skipped: result.skipped
    }
  })
}
