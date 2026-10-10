import type { PodOrbstackApi } from '../../../../preload/api/pod-orbstack-api'

/** Undefined in the web client and in unit tests that stub only part of `window.api`. */
export function getPodOrbstackApi(): PodOrbstackApi | undefined {
  const api: Partial<Window['api']> | undefined =
    typeof window === 'undefined' ? undefined : window.api
  return api?.podOrbstack
}
