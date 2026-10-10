import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { getAppEnvironment, hasAppEnvironment } from './app-environment'
/** Only the columns needed to verify a pane's resize signal target. */
export type NativeProcessForegroundRow = {
  pid: number
  tpgid: number
  tty: string
}

export type NativeProcessInfo = {
  /** Checks the supplied PTY device; tty is '??' when the process holds another terminal. */
  readProcessForegroundGroup(pid: number, expectedTty: string): NativeProcessForegroundRow | null
}

export const NATIVE_PROCESS_INFO_RESOURCE_PATH = join('native', 'orca-proc-info.node')
export const NATIVE_PROCESS_INFO_BUILD_PATH = join(
  'native',
  'proc-info-darwin',
  '.build',
  'release',
  'orca-proc-info.node'
)

function isNativeProcessInfo(value: unknown): value is NativeProcessInfo {
  return (
    typeof value === 'object' &&
    value !== null &&
    'readProcessForegroundGroup' in value &&
    typeof value.readProcessForegroundGroup === 'function'
  )
}

function candidatePaths(): string[] {
  // Why the probe: Electron adds resourcesPath; the CLI's plain-Node types do not declare it.
  const resourcesPath =
    'resourcesPath' in process && typeof process.resourcesPath === 'string'
      ? process.resourcesPath
      : null
  // Why app.asar decides: the terminal daemon runs as plain Node with no app environment, and a
  // packaged app must never load a native module from whatever checkout it was launched in.
  if (resourcesPath && existsSync(join(resourcesPath, 'app.asar'))) {
    return [join(resourcesPath, NATIVE_PROCESS_INFO_RESOURCE_PATH)]
  }
  // Why only an Electron dev checkout: a plain-Node host (relay, orcad, a dev daemon) must not load
  // a native module from its working directory; those keep forking `ps`.
  const environment = hasAppEnvironment() ? getAppEnvironment() : null
  return environment && !environment.isPackaged()
    ? [join(environment.getAppPath(), NATIVE_PROCESS_INFO_BUILD_PATH)]
    : []
}

/** Load the addon at `path`; null when it is missing or not the expected module. */
export function loadNativeProcessInfoFrom(path: string): NativeProcessInfo | null {
  try {
    const addon = { exports: {} }
    process.dlopen(addon, path)
    return isNativeProcessInfo(addon.exports) ? addon.exports : null
  } catch {
    return null
  }
}

let cached: NativeProcessInfo | null | undefined

/** The unit-test setup disables the addon so existing subprocess mocks stay in charge. */
export const DISABLE_NATIVE_PROCESS_INFO_ENV = 'ORCA_DISABLE_NATIVE_PROCESS_INFO'

/** The trusted macOS addon, or null so resize targeting keeps its existing ps fallback. */
export function getNativeProcessInfo(): NativeProcessInfo | null {
  if (cached === undefined) {
    const enabled =
      process.platform === 'darwin' && process.env[DISABLE_NATIVE_PROCESS_INFO_ENV] !== '1'
    const path = enabled ? candidatePaths().find(existsSync) : undefined
    const addon = path ? loadNativeProcessInfoFrom(path) : null
    if (addon) {
      cached = addon
    } else if (!enabled || hasAppEnvironment()) {
      cached = null
    }
  }
  return cached ?? null
}

export function setNativeProcessInfoForTests(value: NativeProcessInfo | null | undefined): void {
  cached = value
}
