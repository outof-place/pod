import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { POD_UI_HOST_PANE_LAYOUT_IPC } from '../../../shared/pod-ui-host-pane-layout'

const ipcMain = vi.hoisted(() => {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const of = (channel: string) => listeners.get(channel) ?? new Set()
  return {
    on: (channel: string, listener: (...args: unknown[]) => void) => {
      listeners.set(channel, of(channel).add(listener))
    },
    removeListener: (channel: string, listener: (...args: unknown[]) => void) => {
      of(channel).delete(listener)
    },
    emit: (channel: string, ...args: unknown[]) => {
      for (const listener of Array.from(of(channel))) {
        listener(...args)
      }
    },
    listenerCount: (channel: string) => of(channel).size
  }
})
vi.mock('electron', () => ({ ipcMain }))
vi.mock('../../window/renderer-publication-throttle', () => ({
  rendererPublicationThrottle: { acquire: () => () => {} }
}))

const { applyRendererPaneLayout } = await import('./pod-ui-host-pane-layout')

const request = {
  worktreeId: 'wt',
  tabId: 'tab',
  root: null,
  expandedLeafId: null,
  activeLeafId: 'right'
}

function window(answer: ((requestId: unknown) => void) | null) {
  const webContents = Object.assign(new EventEmitter(), {
    id: 7,
    isCrashed: () => false,
    isLoadingMainFrame: () => false,
    send: vi.fn((channel: string, requestId: unknown) => {
      if (channel === POD_UI_HOST_PANE_LAYOUT_IPC.apply) {
        answer?.(requestId)
      }
    })
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: applyRendererPaneLayout reads only these members.
  const win = { isDestroyed: () => false, webContents } as never
  return { win, send: webContents.send }
}

const answer = (sender: number, reply: unknown) => (requestId: unknown) =>
  ipcMain.emit(POD_UI_HOST_PANE_LAYOUT_IPC.applied, { sender: { id: sender } }, requestId, reply)

describe('applyRendererPaneLayout (Pod)', () => {
  it("sends the layout to this window's renderer and takes its answer", async () => {
    const { win, send } = window(answer(7, { applied: true }))
    await expect(applyRendererPaneLayout(win, request)).resolves.toEqual({ applied: true })
    expect(send).toHaveBeenCalledWith(
      POD_UI_HOST_PANE_LAYOUT_IPC.apply,
      expect.any(Number),
      request
    )
  })

  it("passes on the renderer's refusal and reads nothing else as an answer", async () => {
    const refusal = { applied: false, reason: 'layout_mismatch' }
    await expect(applyRendererPaneLayout(window(answer(7, refusal)).win, request)).resolves.toEqual(
      refusal
    )
    await expect(
      applyRendererPaneLayout(window(answer(7, { applied: 'yes' })).win, request)
    ).resolves.toBeNull()
  })

  it("ignores another window's answer and gives up when this one stays silent", async () => {
    const { win } = window(answer(8, { applied: true }))
    await expect(applyRendererPaneLayout(win, request, 20)).resolves.toBeNull()
    expect(ipcMain.listenerCount(POD_UI_HOST_PANE_LAYOUT_IPC.applied)).toBe(0)
  })

  it('answers null without a usable window', async () => {
    await expect(applyRendererPaneLayout(null, request)).resolves.toBeNull()
  })
})
