import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { hasPodHeadlessUiHostSwitches } from '../ui-host/pod-ui-host-launch'

/**
 * Whether this Pod is the user's own: the packaged app on its default profile, launched by the
 * user. Every other instance (a dev or bench build, its own userData, `--serve`, a headless host,
 * a test launch's mock keychain, a background or E2E launch) shares the account with the user's
 * live sessions, so it must not write what they all read: ~/.claude/settings.json and the scripts
 * under ~/.orca/agent-hooks. A HOME override isolates nothing: Electron's getPath('home') comes from
 * the user database, and the dev runtimes that rewrote the user's hooks all night had one.
 *
 * No Electron here: the CLI links the hook controls too. Main installs the full check
 * (installPodHookWriteGate in pod-instance.ts) before its startup install; any other host checks
 * the launch flags only.
 */
export type PodInstanceInput = {
  packaged: boolean
  userDataPath: string | null
  defaultUserDataPath: string | null
  argv: readonly string[]
  /** A harness variable launched it (acc-lifecycle's AUTOMATED_LAUNCH_ENV). */
  automated: boolean
  /** An E2E launch, whose home is meant to be disposable. */
  e2e: boolean
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
  /** Electron's main process before installPodHookWriteGate: nothing is known yet. */
  | 'not-checked'

function samePath(a: string, b: string): boolean {
  return resolve(a) === resolve(b)
}

/** Why this instance must leave the user-global hook files alone, or null when it owns them. */
export function podHookWriteBlock(input: PodInstanceInput): PodNonDefaultReason | null {
  if (input.e2e) {
    // E2E points HOME and getPath('home') at its disposable home (configureDevUserDataPath), so its
    // hook files land there; anywhere else, they would land in the user's.
    const own = input.accountHome === null || !samePath(input.hookHome, input.accountHome)
    return own ? null : 'e2e-outside-its-home'
  }
  if (!input.packaged) {
    return 'dev-build'
  }
  if (input.automated) {
    return 'automated-launch'
  }
  // Fork-only (Pod): PodNative's own runtime (headless one-app) runs as --serve --pod-headless-host;
  // it is the user's Pod, so only those two reasons lift. A serve host without both stays blocked.
  const podNativeRuntime = hasPodHeadlessUiHostSwitches(input.argv)
  if (!podNativeRuntime && input.argv.includes('--serve')) {
    return 'serve'
  }
  if (!podNativeRuntime && input.argv.includes('--pod-headless-host')) {
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

function flagsOnly(): PodNonDefaultReason | null {
  return podHookWriteBlock({
    packaged: true,
    userDataPath: null,
    defaultUserDataPath: null,
    argv: process.argv,
    automated: false,
    e2e: false,
    hookHome: homedir(),
    accountHome: null
  })
}

let source: (() => PodNonDefaultReason | null) | null = null

/** Main's full check. Electron writes nothing before it is installed; other hosts check flags. */
export function setPodHookWriteBlockSource(next: () => PodNonDefaultReason | null): void {
  source = next
}

export function podHookWriteBlockNow(): PodNonDefaultReason | null {
  if (source) {
    return source()
  }
  return process.versions.electron === undefined ? flagsOnly() : 'not-checked'
}
