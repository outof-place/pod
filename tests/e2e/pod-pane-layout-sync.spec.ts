import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import {
  ensureTerminalVisible,
  getActiveTabId,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import {
  splitActiveTerminalPane,
  waitForActiveTerminalManager,
  waitForPaneIdentitySnapshot
} from './helpers/terminal'
import { POD_UI_HOST_PANE_LAYOUT_IPC } from '../../src/shared/pod-ui-host-pane-layout'

// Fork-only (Pod): PodNative's pane layout reaches the window that owns the tab's panes, through the
// same IPC main uses for session.tabs.updatePaneLayout, and the window republishes it.
async function sendLayout(electronApp: ElectronApplication, request: unknown): Promise<unknown> {
  return await electronApp.evaluate(
    ({ BrowserWindow, ipcMain }, { request, channels }) =>
      new Promise((resolve) => {
        const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed())
        if (!window) {
          resolve('no window')
          return
        }
        ipcMain.once(channels.applied, (_event, _requestId, reply) => resolve(reply))
        window.webContents.send(channels.apply, 1, request)
      }),
    { request, channels: POD_UI_HOST_PANE_LAYOUT_IPC }
  )
}

async function storedLayout(page: Page, tabId: string): Promise<unknown> {
  return await page.evaluate(
    (tabId) => window.__store?.getState().terminalLayoutsByTabId[tabId] ?? null,
    tabId
  )
}

// What the runtime publishes for the tab: its split ratio and active pane, as PodNative reads them.
async function publishedLayout(page: Page, worktreeId: string, tabId: string): Promise<unknown> {
  return await page.evaluate(
    async ({ worktreeId, tabId }) => {
      const response = await window.api.runtime.call({
        method: 'session.tabs.list',
        params: { worktree: `id:${worktreeId}` }
      })
      const tabs: unknown[] =
        response.ok && Array.isArray(Reflect.get(Object(response.result), 'tabs'))
          ? Reflect.get(Object(response.result), 'tabs')
          : []
      const leaves = tabs.filter((tab) => Reflect.get(Object(tab), 'parentTabId') === tabId)
      const root = Reflect.get(Object(Reflect.get(Object(leaves[0]), 'parentLayout')), 'root')
      const active = leaves.find((tab) => Reflect.get(Object(tab), 'isActive') === true)
      return {
        ratio: Reflect.get(Object(root), 'ratio'),
        active: Reflect.get(Object(active), 'leafId')
      }
    },
    { worktreeId, tabId }
  )
}

test('PodNative moves a split, expands a pane and picks the active one in the window', async ({
  electronApp,
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  await waitForPaneIdentitySnapshot(orcaPage, 1)
  const tabId = await getActiveTabId(orcaPage)
  expect(tabId).toBeTruthy()
  await splitActiveTerminalPane(orcaPage, 'vertical')
  const [left, right] = (await waitForPaneIdentitySnapshot(orcaPage, 2)).panes.map(
    (pane) => pane.leafId
  )
  const root = {
    type: 'split',
    direction: 'vertical',
    first: { type: 'leaf', leafId: left },
    second: { type: 'leaf', leafId: right },
    ratio: 0.3
  }

  expect(
    await sendLayout(electronApp, {
      worktreeId,
      tabId,
      root,
      expandedLeafId: null,
      activeLeafId: left
    })
  ).toEqual({ applied: true })
  await expect
    .poll(() => storedLayout(orcaPage, tabId!))
    .toMatchObject({ root, activeLeafId: left, expandedLeafId: null })
  await expect
    .poll(() => publishedLayout(orcaPage, worktreeId, tabId!))
    .toEqual({ ratio: 0.3, active: left })

  expect(
    await sendLayout(electronApp, { worktreeId, tabId, root: null, expandedLeafId: right })
  ).toEqual({ applied: true })
  await expect
    .poll(() => storedLayout(orcaPage, tabId!))
    .toMatchObject({ activeLeafId: left, expandedLeafId: right })

  expect(
    await sendLayout(electronApp, { worktreeId, tabId, root: null, expandedLeafId: null })
  ).toEqual({ applied: true })
  await expect
    .poll(() => storedLayout(orcaPage, tabId!))
    .toMatchObject({ root, expandedLeafId: null })

  expect(
    await sendLayout(electronApp, {
      worktreeId,
      tabId,
      root: { type: 'leaf', leafId: left },
      expandedLeafId: null
    })
  ).toEqual({ applied: false, reason: 'layout_mismatch' })
})
