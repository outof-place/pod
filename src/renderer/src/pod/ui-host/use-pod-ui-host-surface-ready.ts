// Fork-only (Pod): the headless one-app runtime opened this window for a PodNative surface and waits
// until the session is restored to navigate it (src/main/pod/ui-host/pod-ui-host-lazy-window.ts).
import { useEffect } from 'react'

export function usePodUiHostSurfaceReady(workspaceSessionReady: boolean): void {
  useEffect(() => {
    if (!workspaceSessionReady) {
      return
    }
    // Undefined in the web client and in unit tests that stub only part of `window.api`.
    const api: Partial<Window['api']> | undefined =
      typeof window === 'undefined' ? undefined : window.api
    api?.podUiHost?.surfaceReady()
  }, [workspaceSessionReady])
}
