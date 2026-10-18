import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { acquireElectronDebugger } from '../../browser/electron-debugger-lease'
import { newPaneCobrowse } from './pod-browser-pane-cobrowse'

// A guest whose debugger, like Chromium's, drops the page's emulation when it detaches.
function fakeGuest() {
  const state: { attached: boolean; viewport: { width: number; height: number } | null } = {
    attached: false,
    viewport: null
  }
  const listeners = new Map<string, () => void>()
  const debuggerApi = {
    isAttached: () => state.attached,
    attach: () => {
      state.attached = true
    },
    detach: () => {
      state.attached = false
      state.viewport = null
    },
    sendCommand: async (method: string, params: Record<string, unknown> = {}) => {
      if (!state.attached) {
        throw new Error('Debugger is not attached')
      }
      switch (method) {
        case 'Emulation.setDeviceMetricsOverride':
          state.viewport = { width: Number(params.width), height: Number(params.height) }
          return {}
        case 'Page.getLayoutMetrics':
          return { cssLayoutViewport: { pageX: 0, pageY: 0, clientWidth: 390, clientHeight: 844 } }
        case 'Runtime.evaluate':
          return { result: { objectId: 'obj-7', subtype: 'node' } }
        case 'DOM.describeNode':
          return { node: { backendNodeId: 7 } }
        case 'DOM.getBoxModel':
          return { model: { border: [10, 20, 90, 20, 90, 50, 10, 50] } }
        default:
          return {}
      }
    }
  }
  const wc = {
    debugger: debuggerApi,
    isDestroyed: () => false,
    isCrashed: () => false,
    on: (event: string, listener: () => void) => listeners.set(event, listener),
    once: (event: string, listener: () => void) => listeners.set(event, listener),
    getURL: () => 'http://localhost:3000/',
    getTitle: () => 'App',
    getZoomFactor: () => 1
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: co-browse uses only these members of a WebContents.
  return { wc: wc as unknown as WebContents, state, listeners }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('co-browse on a pane page shares its debugger', () => {
  it("an agent's viewport survives a co-browse point and clear, in either order", async () => {
    for (const cobrowseFirst of [false, true]) {
      const { wc, state, listeners } = fakeGuest()
      const cobrowse = newPaneCobrowse(
        `page-${cobrowseFirst}`,
        wc,
        () => true,
        () => ({ token: 1, visible: true }),
        vi.fn()
      )
      cobrowse.setWatching(true)
      let proxy: { release: () => void } | null = null
      const agentSetsViewport = async () => {
        // BROWSER-2: the tab's CDP proxy holds its lease for the tab's life and sets the viewport.
        proxy = acquireElectronDebugger(wc)
        await wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
          width: 390,
          height: 844
        })
      }
      if (!cobrowseFirst) {
        await agentSetsViewport()
      }
      await cobrowse.point({ selector: 'button#save', label: 'Here', keep: false })
      if (cobrowseFirst) {
        await agentSetsViewport()
      }
      cobrowse.clearPointers()
      await settle()
      expect(cobrowse.holdsDebugger).toBe(false)
      expect(state.attached).toBe(true)
      expect(state.viewport).toEqual({ width: 390, height: 844 })
      proxy!.release()
      expect(state.attached).toBe(false)
      listeners.get('destroyed')?.()
    }
  })
})
