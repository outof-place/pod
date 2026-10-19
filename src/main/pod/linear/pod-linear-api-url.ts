// Fork-only (Pod): where Linear's GraphQL API is for this process. Tests and probes point Pod at a
// mock Linear server with POD_LINEAR_API_URL; nothing else may move it. Loopback only and only in an
// isolated profile: any other value is an error on every Linear call, never a fallback to
// api.linear.app (a probe must not reach real Linear with a fake key, or a real one).
import type { LinearSdkModule } from '../../linear/linear-sdk'

export const POD_LINEAR_API_URL_ENV = 'POD_LINEAR_API_URL'

// URL.hostname keeps IPv6 brackets.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

export type PodLinearApiTarget =
  | { kind: 'default' }
  | { kind: 'mock'; apiUrl: string }
  | { kind: 'refused'; message: string }

export function resolvePodLinearApiTarget(
  env: NodeJS.ProcessEnv = process.env
): PodLinearApiTarget {
  const raw = env[POD_LINEAR_API_URL_ENV]
  if (raw === undefined || raw === '') {
    return { kind: 'default' }
  }
  const refused = (why: string): PodLinearApiTarget => ({
    kind: 'refused',
    message: `Linear is off: ${POD_LINEAR_API_URL_ENV} ${why}`
  })
  // Why the profile: the variable exists for test runs, which always have an isolated profile.
  if (!env.ORCA_E2E_USER_DATA_DIR) {
    return refused('is set outside an isolated profile (ORCA_E2E_USER_DATA_DIR)')
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return refused('is not a URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return refused('must be http or https')
  }
  if (url.username || url.password || !LOOPBACK_HOSTS.has(url.hostname)) {
    return refused('must point to 127.0.0.1, localhost or [::1]')
  }
  return { kind: 'mock', apiUrl: url.href }
}

/** The SDK with every client on the resolved target; the SDK itself when there is no override. */
export function podLinearSdk(
  sdk: LinearSdkModule,
  target: PodLinearApiTarget = resolvePodLinearApiTarget()
): LinearSdkModule {
  if (target.kind === 'default') {
    return sdk
  }
  if (target.kind === 'mock') {
    console.info(`[linear] ${POD_LINEAR_API_URL_ENV}: the API is a mock server on loopback`)
  } else {
    console.warn(`[linear] ${target.message}`)
  }
  const refusal = target.kind === 'refused' ? target.message : null
  const apiUrl = target.kind === 'mock' ? target.apiUrl : undefined
  const Base = sdk.LinearClient
  class PodLinearClient extends Base {
    constructor(options: ConstructorParameters<typeof Base>[0]) {
      if (refusal !== null) {
        throw new Error(refusal)
      }
      super({ ...options, apiUrl })
    }
  }
  return { ...sdk, LinearClient: PodLinearClient }
}
