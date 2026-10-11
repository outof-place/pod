import { homedir, userInfo } from 'node:os'
import { join, resolve } from 'node:path'
import { app } from 'electron'
import { getProductIdentity } from '../../product-identity/product-identity'
import { AUTOMATED_LAUNCH_ENV } from '../acc/acc-lifecycle'

/**
 * Whether this Pod is the user's own: the packaged app on its default profile, launched by the
 * user. Every other instance (a dev or bench build, its own userData, `--serve`, a headless host,
 * a test launch's mock keychain, a background or E2E launch) shares the account with the user's
 * live sessions, so it must not write what they all read: ~/.claude/settings.json and the scripts
 * under ~/.orca/agent-hooks. A HOME override isolates nothing: Electron's getPath('home') comes from
 * the user database, and the dev runtimes that rewrote the user's hooks all night had one.
 */
export type PodInstanceInput = {
  packaged: boolean
  userDataPath: string | null
  defaultUserDataPath: string | null
  argv: readonly string[]
  env: NodeJS.ProcessEnv
  /** os.homedir(): where the managed hook files go. */
  hookHome: string
  /** getpwuid's home: the one the user's sessions read. */
  accountHome: string | null
}

export type PodNonDefaultReason =
  | 'dev-build'
  | 'automated-launch'
  | 'serve'
  | 'headless-host'
  | 'mock-keychain'
  | 'custom-profile'
  | 'e2e-outside-its-home'

const E2E_ENV = ['ORCA_E2E_USER_DATA_DIR', 'POD_E2E_USER_DATA_DIR'] as const

function samePath(a: string, b: string): boolean {
  return resolve(a) === resolve(b)
}

/** Why this instance must leave the user-global hook files alone, or null when it owns them. */
export function podHookWriteBlock(input: PodInstanceInput): PodNonDefaultReason | null {
  if (E2E_ENV.some((name) => Boolean(input.env[name]))) {
    // E2E points HOME and getPath('home') at its disposable home (configureDevUserDataPath), so its
    // hook files land there; anywhere else, they would land in the user's.
    const own = input.accountHome === null || !samePath(input.hookHome, input.accountHome)
    return own ? null : 'e2e-outside-its-home'
  }
  if (!input.packaged) {
    return 'dev-build'
  }
  if (AUTOMATED_LAUNCH_ENV.some((name) => Boolean(input.env[name]))) {
    return 'automated-launch'
  }
  if (input.argv.includes('--serve')) {
    return 'serve'
  }
  if (input.argv.includes('--pod-headless-host')) {
    return 'headless-host'
  }
  if (input.argv.includes('--use-mock-keychain')) {
    return 'mock-keychain'
  }
  if (
    input.userDataPath !== null &&
    (input.defaultUserDataPath === null || !samePath(input.userDataPath, input.defaultUserDataPath))
  ) {
    return 'custom-profile'
  }
  return null
}

/** getpwuid's home for this uid: unlike app.getPath('home') or HOME, an override does not move it. */
export function accountHome(): string | null {
  try {
    return userInfo().homedir || null
  } catch {
    return null
  }
}

/**
 * The profile a user's launch opens: the identity's (applyProductIdentityPreReady pins it), else
 * Electron's default for this app name. On macOS anchored at the account home, not $HOME.
 */
export function podDefaultUserDataPath(): string | null {
  const name = getProductIdentity()?.userDataName ?? app?.name
  if (!name) {
    return null
  }
  const account = accountHome()
  if (process.platform === 'darwin') {
    return account ? join(account, 'Library', 'Application Support', name) : null
  }
  return app?.getPath ? join(app.getPath('appData'), name) : null
}

/** podHookWriteBlock for this process. Outside Electron (the CLI, orcad, unit tests) only flags count. */
export function podHookWriteBlockNow(): PodNonDefaultReason | null {
  const electron = typeof app?.getPath === 'function'
  return podHookWriteBlock({
    packaged: electron ? app.isPackaged : true,
    userDataPath: electron ? app.getPath('userData') : null,
    defaultUserDataPath: electron ? podDefaultUserDataPath() : null,
    argv: process.argv,
    env: electron ? process.env : {},
    hookHome: homedir(),
    accountHome: accountHome()
  })
}
