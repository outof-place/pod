// Fork-only (Pod): one-app's quit asks this renderer what quitting would lose, so PodNative can ask
// the user natively; this window's own quit prompts would open hidden (src/shared/pod-ui-host-quit.ts).
import { useEffect } from 'react'
import type { PodUiHostQuitBlockers } from '../../../../shared/pod-ui-host-quit'
import { assessWindowCloseRunningWork } from '@/components/terminal/window-close-running-work'
import { useAppStore } from '@/store'

export async function assessPodUiHostQuit(): Promise<PodUiHostQuitBlockers> {
  const unsavedFiles = useAppStore.getState().openFiles.filter((file) => file.isDirty).length
  const remoteWork = await assessWindowCloseRunningWork({ isQuitting: true })
  return { unsavedFiles, remoteWork: remoteWork.kind }
}

export function usePodUiHostQuitAssess(): void {
  useEffect(() => {
    // Undefined in the web client and in unit tests that stub only part of `window.api`.
    const api: Partial<Window['api']> | undefined =
      typeof window === 'undefined' ? undefined : window.api
    return api?.podUiHost?.onQuitAssess(assessPodUiHostQuit)
  }, [])
}
