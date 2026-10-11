import { describe, expect, it, vi } from 'vitest'
import { POD_UI_HOST_SURFACE_IPC } from '../../../shared/pod-ui-host-surface'
import {
  podUiHostSurfaceNavigation,
  sendPodUiHostSurfaceNavigation
} from './pod-ui-host-surface-navigation'

describe('podUiHostSurfaceNavigation', () => {
  it('carries the section and only the fields PodNative sent', () => {
    expect(
      podUiHostSurfaceNavigation({
        type: 'openSurface',
        surface: 'settings',
        section: 'quick-commands',
        intent: 'add-quick-command'
      })
    ).toEqual({ surface: 'settings', section: 'quick-commands', intent: 'add-quick-command' })
    expect(podUiHostSurfaceNavigation({ type: 'openSurface', surface: 'settings' })).toBeNull()
  })

  it('sends the navigation to a live window only', () => {
    const send = vi.fn()
    const navigation = { surface: 'window' as const, section: 'activity' }
    sendPodUiHostSurfaceNavigation({ isDestroyed: () => false, webContents: { send } }, navigation)
    expect(send).toHaveBeenCalledWith(POD_UI_HOST_SURFACE_IPC.navigate, navigation)

    const gone = vi.fn()
    sendPodUiHostSurfaceNavigation(
      { isDestroyed: () => true, webContents: { send: gone } },
      navigation
    )
    sendPodUiHostSurfaceNavigation(null, navigation)
    expect(gone).not.toHaveBeenCalled()
  })
})
