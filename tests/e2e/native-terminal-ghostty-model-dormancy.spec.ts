/**
 * Fork-only (Pod): main lets its model of a visible local PTY go dormant after 5 s with no
 * reader (#27086), but a native view main feeds is such a reader. Idle native panes must keep
 * showing a flood, a reload, and output that arrived while hidden.
 */
import { test, expect } from './helpers/orca-app'
import {
  enableNativeTerminal,
  findNativeSurfaceForPane,
  nativeScreenText,
  splitNativeTerminalPane
} from './helpers/native-terminal-debug'
import { expectNativeScreenMatchesXterm } from './helpers/native-terminal-screens'
import {
  execInTerminal,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

// Past MAIN_TERMINAL_MODEL_DORMANT_AFTER_MS, so main would drop a model nobody holds.
const IDLE_MS = 7_000

test.describe.configure({ mode: 'serial' })
test.skip(process.platform !== 'darwin', 'the native Ghostty terminal is macOS only')

test('an idle native pane keeps main’s model live through a flood, a reload and a hide', async ({
  orcaPage,
  electronApp
}) => {
  test.setTimeout(240_000)
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  await expect
    .poll(async () => orcaPage.locator('[data-radix-popper-content-wrapper]').count(), {
      timeout: 30_000
    })
    .toBe(0)
  expect(
    await orcaPage.evaluate(() => window.__store?.getState().settings?.terminalMainModelDormancy)
  ).not.toBe(false)
  await enableNativeTerminal(orcaPage)
  const { ptyId, surfaceId } = await splitNativeTerminalPane(orcaPage, electronApp)

  // Idle, then a flood: the view shows all of it.
  await orcaPage.waitForTimeout(IDLE_MS)
  await execInTerminal(orcaPage, ptyId, "seq 1 2000; printf 'IDLE-FLOOD-%s\\n' DONE")
  await waitForTerminalOutput(orcaPage, 'IDLE-FLOOD-DONE')
  await expect
    .poll(async () => nativeScreenText(electronApp, surfaceId))
    .toContain('IDLE-FLOOD-DONE')
  await expectNativeScreenMatchesXterm(orcaPage, electronApp, ptyId, surfaceId)

  // A reload seeds the new view from main's model, which then keeps following the PTY.
  await orcaPage.waitForTimeout(IDLE_MS)
  await orcaPage.reload()
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  const reloaded = await findNativeSurfaceForPane(orcaPage, ptyId, 30_000)
  expect(reloaded).not.toBeNull()
  const view = reloaded ?? 0
  await expectNativeScreenMatchesXterm(orcaPage, electronApp, ptyId, view)
  await orcaPage.waitForTimeout(IDLE_MS)
  await execInTerminal(orcaPage, ptyId, "seq 1 500; printf 'RELOAD-FLOOD-%s\\n' DONE")
  await waitForTerminalOutput(orcaPage, 'RELOAD-FLOOD-DONE')
  await expectNativeScreenMatchesXterm(orcaPage, electronApp, ptyId, view)

  // Output while another tab covers the pane, then an idle stretch, then the reveal.
  const back = await orcaPage.evaluate(() => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    const current = state?.activeTabId
    if (!state || !worktreeId || !current) {
      throw new Error('no active tab')
    }
    const other = state.createTab(worktreeId, undefined, undefined, { activate: true })
    state.setActiveTab(other.id)
    return current
  })
  await execInTerminal(orcaPage, ptyId, "seq 1 300; printf 'WHILE-%s\\n' HIDDEN")
  await orcaPage.waitForTimeout(IDLE_MS)
  await orcaPage.evaluate((id) => window.__store?.getState().setActiveTab(id), back)
  await expect.poll(async () => nativeScreenText(electronApp, view)).toContain('WHILE-HIDDEN')
  await expectNativeScreenMatchesXterm(orcaPage, electronApp, ptyId, view)
  await execInTerminal(orcaPage, ptyId, "printf 'REVEAL-%s\\n' LIVE")
  await waitForTerminalOutput(orcaPage, 'REVEAL-LIVE')
  await expectNativeScreenMatchesXterm(orcaPage, electronApp, ptyId, view)
})
