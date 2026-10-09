/**
 * Reverse-DNS identity of the packaged app: the macOS bundle id (and so its
 * preferences domain, TCC identity, and notification settings id) and the
 * Windows AppUserModelID. Runtime readers derive from this constant so a
 * rebranded build changes it in one place; electron-builder's `appId` and the
 * local-build compatibility contract JSON are pinned to it by tests.
 */
export const ORCA_APP_BUNDLE_ID = 'com.stablyai.orca'
/** Orca's own dev and local-build variants append these to the base id. */
export const ORCA_DEV_APP_BUNDLE_ID = `${ORCA_APP_BUNDLE_ID}.dev`
export const ORCA_LOCAL_APP_BUNDLE_ID = `${ORCA_APP_BUNDLE_ID}.local`
/** The detached terminal helper shares its app's id plus this suffix. */
export const ORCA_HELPER_BUNDLE_ID_SUFFIX = '.helper'
export const ORCA_COMPUTER_USE_BUNDLE_ID = `${ORCA_APP_BUNDLE_ID}.computer-use`

export type AppIdentity = {
  name: string
  isDev: boolean
  devLabel: string | null
  devBranch: string | null
  devWorktreeName: string | null
  devRepoRoot: string | null
  dockBadgeLabel: string | null
}
