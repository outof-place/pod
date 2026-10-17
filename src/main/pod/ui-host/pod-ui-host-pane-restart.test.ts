import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { POD_UI_HOST_PANE_RESTART_IPC } from '../../../shared/pod-ui-host-pane-restart'

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

const { noteRetainedExit, restartRendererPane } = await import('./pod-ui-host-pane-restart')

const pane = { worktreeId: 'wt', tabId: 'tab', leafId: 'left' }

function window(answer: ((requestId: unknown) => void) | null) {
  const webContents = Object.assign(new EventEmitter(), {
    id: 7,
    isCrashed: () => false,
    isLoadingMainFrame: () => false,
    send: vi.fn((channel: string, requestId: unknown) => {
      if (channel === POD_UI_HOST_PANE_RESTART_IPC.restart) {
        answer?.(requestId)
      }
    })
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: restartRendererPane reads only these members.
  const win = { isDestroyed: () => false, webContents } as never
  return { win, send: webContents.send }
}

describe('restartRendererPane (Pod)', () => {
  it("sends the pane to this window's renderer and takes its answer", async () => {
    const { win, send } = window((requestId) =>
      ipcMain.emit(POD_UI_HOST_PANE_RESTART_IPC.restarted, { sender: { id: 7 } }, requestId, true)
    )
    await expect(restartRendererPane(win, pane)).resolves.toBe(true)
    expect(send).toHaveBeenCalledWith(
      POD_UI_HOST_PANE_RESTART_IPC.restart,
      expect.any(Number),
      pane
    )
  })

  it("ignores another window's answer and gives up when this one stays silent", async () => {
    const { win } = window((requestId) =>
      ipcMain.emit(POD_UI_HOST_PANE_RESTART_IPC.restarted, { sender: { id: 8 } }, requestId, true)
    )
    await expect(restartRendererPane(win, pane, 20)).resolves.toBe(false)
    expect(ipcMain.listenerCount(POD_UI_HOST_PANE_RESTART_IPC.restarted)).toBe(0)
  })

  it('answers false without a usable window', async () => {
    await expect(restartRendererPane(null, pane)).resolves.toBe(false)
  })
})

describe('noteRetainedExit (Pod)', () => {
  it("tells this window's renderer which kept pane must not resume its agent", () => {
    const { win, send } = window(null)
    noteRetainedExit(win, pane)
    expect(send).toHaveBeenCalledWith(POD_UI_HOST_PANE_RESTART_IPC.retained, pane)
  })
})
