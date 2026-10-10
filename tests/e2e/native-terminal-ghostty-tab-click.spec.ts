/**
 * A native Ghostty view holding AppKit's keyboard leaves the page blurred, so a click on page UI
 * is what focuses the page again, while the button is still down. That focus must neither flush
 * the tab strip's pending press nor give the keyboard back to the native view (whose blur cancels
 * the press), or switching tabs takes two clicks. The skipped restore lands on release unless the
 * click put focus somewhere real (an input).
 *
 * The E2E window is never key, so AppKit's part of a real click is replayed by hand: the web
 * contents take the keyboard, the button reads as pressed, and the page gets its focus event.
 */
import type { ElectronApplication, Locator, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForActivePanePtyId, waitForActiveTerminalManager } from './helpers/terminal'
import {
  ensureTerminalVisible,
  getActiveTabId,
  getActiveWorktreeId,
  getAllWorktreeIds,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import { openTerminalTabInActiveGroup } from './helpers/terminal-tab-open'
import { waitForPtyShellEcho } from './terminal-pty-readiness'
import {
  enableNativeTerminal,
  findNativeSurfaceForPane,
  isNativeSurfaceHidden,
  nativeSurfaceField,
  nativeTerminalDebug
} from './helpers/native-terminal-debug'

test.describe.configure({ mode: 'serial' })
test.skip(process.platform !== 'darwin', 'the native Ghostty terminal is macOS only')

const SORTABLE_TAB = '[data-testid="sortable-tab"]'

function holdsKeyboard(app: ElectronApplication, surfaceId: number): Promise<unknown> {
  return nativeSurfaceField(app, surfaceId, 'firstResponder')
}

// The renderer has the native view's focus report once the mirror focuses the pane's textarea.
function pageSeesNativeKeyboard(page: Page, surfaceId: number): Promise<boolean> {
  return page.evaluate(
    (id) => document.activeElement?.closest(`[data-native-surface-id="${id}"]`) != null,
    String(surfaceId)
  )
}

async function giveNativeKeyboard(
  page: Page,
  app: ElectronApplication,
  surfaceId: number
): Promise<void> {
  await nativeTerminalDebug(app, 'focus', [surfaceId])
  await expect.poll(() => holdsKeyboard(app, surfaceId)).toBe(true)
  await expect.poll(() => pageSeesNativeKeyboard(page, surfaceId)).toBe(true)
}

// One press and release on the target with AppKit's handoff in between, as in a key window.
async function clickWhileNativeHoldsKeyboard(
  page: Page,
  app: ElectronApplication,
  surfaceId: number,
  target: Locator
): Promise<void> {
  const box = await target.boundingBox()
  if (!box) {
    throw new Error('click target has no box')
  }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await nativeTerminalDebug(app, 'mousePressed', [true])
  try {
    await nativeTerminalDebug(app, 'releaseKeyboard', [[surfaceId]])
    await expect.poll(() => holdsKeyboard(app, surfaceId)).toBe(false)
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    // Why a fixed wait: this asserts a renderer-to-main request that must not take effect.
    await page.waitForTimeout(500)
    expect(await holdsKeyboard(app, surfaceId)).toBe(false)
    await page.mouse.up()
  } finally {
    await nativeTerminalDebug(app, 'mousePressed', [null])
  }
}

test('one click switches tabs and worktrees while a native terminal holds the keyboard', async ({
  orcaPage,
  electronApp
}) => {
  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  const startupPty = await waitForActivePanePtyId(orcaPage)
  await waitForPtyShellEcho(orcaPage, startupPty, 30_000)
  const xtermTabId = await getActiveTabId(orcaPage)
  await enableNativeTerminal(orcaPage)
  await openTerminalTabInActiveGroup(orcaPage)
  let ptyId = startupPty
  await expect
    .poll(async () => (ptyId = await waitForActivePanePtyId(orcaPage)))
    .not.toBe(startupPty)
  await waitForPtyShellEcho(orcaPage, ptyId, 30_000)
  const surfaceId = await findNativeSurfaceForPane(orcaPage, ptyId)
  if (surfaceId === null) {
    throw new Error(`no native terminal surface shows the new tab's pane ${ptyId}`)
  }
  await expect.poll(async () => isNativeSurfaceHidden(electronApp, surfaceId)).toBe(false)
  const nativeTabId = await getActiveTabId(orcaPage)
  const tab = (id: string | null): Locator =>
    orcaPage.locator(`${SORTABLE_TAB}[data-tab-id="${id}"]`).first()

  await giveNativeKeyboard(orcaPage, electronApp, surfaceId)
  await clickWhileNativeHoldsKeyboard(orcaPage, electronApp, surfaceId, tab(xtermTabId))
  await expect.poll(() => getActiveTabId(orcaPage)).toBe(xtermTabId)

  // Coming back to a native tab still hands it the keyboard.
  await tab(nativeTabId).click()
  await expect.poll(() => getActiveTabId(orcaPage)).toBe(nativeTabId)
  await giveNativeKeyboard(orcaPage, electronApp, surfaceId)

  // A window focus with no press behind it (switching back to the app) restores the keyboard.
  await nativeTerminalDebug(electronApp, 'releaseKeyboard', [[surfaceId]])
  await expect.poll(() => holdsKeyboard(electronApp, surfaceId)).toBe(false)
  await nativeTerminalDebug(electronApp, 'mousePressed', [false])
  try {
    await orcaPage.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect.poll(() => holdsKeyboard(electronApp, surfaceId)).toBe(true)
  } finally {
    await nativeTerminalDebug(electronApp, 'mousePressed', [null])
  }

  // A click on nothing focusable (the sidebar title) gives the keyboard back on release.
  await clickWhileNativeHoldsKeyboard(
    orcaPage,
    electronApp,
    surfaceId,
    orcaPage.locator('[data-sidebar-section-title]').first()
  )
  await expect.poll(() => holdsKeyboard(electronApp, surfaceId)).toBe(true)

  // A click into an input keeps the keyboard in the page.
  await orcaPage.evaluate(() => {
    const input = document.createElement('input')
    input.id = 'native-tab-click-probe'
    input.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483647'
    document.body.append(input)
  })
  const probe = orcaPage.locator('#native-tab-click-probe')
  await clickWhileNativeHoldsKeyboard(orcaPage, electronApp, surfaceId, probe)
  await orcaPage.waitForTimeout(500)
  expect(await holdsKeyboard(electronApp, surfaceId)).toBe(false)
  await expect(probe).toBeFocused()
  await probe.evaluate((input) => input.remove())

  // Sidebar rows activate on click, which must survive the same handoff.
  const otherWorktreeId = (await getAllWorktreeIds(orcaPage)).find((id) => id !== worktreeId)
  if (!otherWorktreeId) {
    throw new Error('the E2E repo has no second worktree')
  }
  await giveNativeKeyboard(orcaPage, electronApp, surfaceId)
  await clickWhileNativeHoldsKeyboard(
    orcaPage,
    electronApp,
    surfaceId,
    orcaPage.locator(`[role="option"][data-worktree-id="${otherWorktreeId}"]`).first()
  )
  await expect.poll(() => getActiveWorktreeId(orcaPage)).toBe(otherWorktreeId)
})
