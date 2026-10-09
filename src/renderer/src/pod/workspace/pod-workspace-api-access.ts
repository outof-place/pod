import type { PodWorkspaceApi } from '../../../../preload/api/pod-workspace-api'

/** Undefined in the web client and in unit tests that stub only part of `window.api`. */
export function getPodWorkspaceApi(): PodWorkspaceApi | undefined {
  const api: Partial<Window['api']> | undefined =
    typeof window === 'undefined' ? undefined : window.api
  return api?.podWorkspace
}
