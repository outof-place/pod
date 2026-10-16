// Fork-only (Pod): the pod-sim helper's whole environment. An allowlist of what Xcode's tools need
// plus the options the runtime chose: nothing else of Pod's environment reaches the only process
// that loads private frameworks, and a POD_SIM_* left in a shell never changes what it does.
import {
  SIM_HELPER_DEVICE_SET_ENV,
  SIM_HELPER_FORCE_UNKNOWN_ENV,
  SIM_HELPER_VERSION_TABLE_ENV
} from './sim-helper-protocol'

/** xcrun and simctl resolve through PATH; CoreSimulator finds its device sets under HOME. */
export const SIM_HELPER_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'TMPDIR',
  'DEVELOPER_DIR',
  'LANG',
  'LANGUAGE'
] as const
const ALLOWED: ReadonlySet<string> = new Set<string>(SIM_HELPER_ENV_ALLOWLIST)

export type SimHelperLaunchOptions = {
  /** A version-table file the helper overlays on its own (a build fix without a release). */
  versionTablePath?: string
  /** A device set other than the default (probes; the pool stays in the default set). */
  deviceSet?: string
  /** Treat the build as unknown: the Xcode-update drill. */
  forceUnknownBuild?: boolean
}

export function simHelperEnvironment(
  source: Readonly<Record<string, string | undefined>>,
  options: SimHelperLaunchOptions
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if ((ALLOWED.has(key) || key.startsWith('LC_')) && typeof value === 'string' && value !== '') {
      env[key] = value
    }
  }
  if (options.versionTablePath) {
    env[SIM_HELPER_VERSION_TABLE_ENV] = options.versionTablePath
  }
  if (options.deviceSet) {
    env[SIM_HELPER_DEVICE_SET_ENV] = options.deviceSet
  }
  if (options.forceUnknownBuild) {
    env[SIM_HELPER_FORCE_UNKNOWN_ENV] = '1'
  }
  return env
}
