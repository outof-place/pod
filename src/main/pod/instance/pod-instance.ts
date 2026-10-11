import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { getProductIdentity } from '../../product-identity/product-identity'
import { automatedLaunchEnv } from '../acc/acc-lifecycle'
import { podHookWriteBlock, setPodHookWriteBlockSource } from './pod-hook-write-block'

const E2E_ENV = ['ORCA_E2E_USER_DATA_DIR', 'POD_E2E_USER_DATA_DIR'] as const

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
  const name = getProductIdentity()?.userDataName ?? app.name
  if (!name) {
    return null
  }
  if (process.platform === 'darwin') {
    const account = accountHome()
    return account ? join(account, 'Library', 'Application Support', name) : null
  }
  return join(app.getPath('appData'), name)
}

/** The hook write check for Electron's main process, read when a hook write is about to happen. */
export function installPodHookWriteGate(): void {
  setPodHookWriteBlockSource(() =>
    podHookWriteBlock({
      packaged: app.isPackaged,
      userDataPath: app.getPath('userData'),
      defaultUserDataPath: podDefaultUserDataPath(),
      argv: process.argv,
      automated: automatedLaunchEnv(process.env) !== null,
      e2e: E2E_ENV.some((name) => Boolean(process.env[name])),
      hookHome: homedir(),
      accountHome: accountHome()
    })
  )
}
