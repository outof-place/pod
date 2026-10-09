import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { writeFileSync } from 'node:fs'
import { test, expect } from './helpers/orca-app'
import {
  execInTerminal,
  splitActiveTerminalPane,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForPaneCount,
  waitForTerminalOutput
} from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForPtyShellEcho } from './terminal-pty-readiness'

type NativeTerminalDebugOp =
  | 'surfaceIds'
  | 'state'
  | 'grid'
  | 'screenText'
  | 'snapshotBase64'
  | 'key'

const RETURN_KEY_CODE = 0x24

test.describe.configure({ mode: 'serial' })
test.skip(process.platform !== 'darwin', 'the native Ghostty terminal is macOS only')

// Main installs these hooks in unpackaged builds (installNativeTerminalDebugHooks).
function debugCall(
  app: ElectronApplication,
  op: NativeTerminalDebugOp,
  args: unknown[] = []
): Promise<unknown> {
  return app.evaluate(
    (_electron, [name, callArgs]) => {
      const debug: unknown = Reflect.get(globalThis, '__orcaNativeTerminalDebug')
      const fn: unknown =
        typeof debug === 'object' && debug !== null ? Reflect.get(debug, name) : null
      if (typeof fn !== 'function') {
        throw new Error(`native terminal debug hook ${name} is not installed`)
      }
      return Reflect.apply(fn, debug, callArgs)
    },
    [op, args] as const
  )
}

async function surfaceIds(app: ElectronApplication): Promise<number[]> {
  const ids = await debugCall(app, 'surfaceIds')
  return Array.isArray(ids) ? ids.filter((id): id is number => typeof id === 'number') : []
}

async function screenText(app: ElectronApplication, surfaceId: number): Promise<string> {
  const text = await debugCall(app, 'screenText', [surfaceId])
  return typeof text === 'string' ? text : ''
}

async function isHidden(app: ElectronApplication, surfaceId: number): Promise<boolean | null> {
  const state = await debugCall(app, 'state', [surfaceId])
  const hidden: unknown =
    typeof state === 'object' && state !== null ? Reflect.get(state, 'hidden') : null
  return typeof hidden === 'boolean' ? hidden : null
}

async function nativeGrid(app: ElectronApplication, surfaceId: number): Promise<string | null> {
  const grid = await debugCall(app, 'grid', [surfaceId])
  if (typeof grid !== 'object' || grid === null) {
    return null
  }
  return `${Reflect.get(grid, 'columns')}x${Reflect.get(grid, 'rows')}`
}

async function activeXtermGrid(page: Page): Promise<{ cols: number; rows: number } | null> {
  return page.evaluate(() => {
    const tabId = window.__store?.getState().activeTabId
    const pane = tabId ? window.__paneManagers?.get(tabId)?.getActivePane() : null
    return pane ? { cols: pane.terminal.cols, rows: pane.terminal.rows } : null
  })
}

test('a new terminal draws through a native Ghostty surface that mirrors its PTY', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  await orcaPage.evaluate(async () => {
    await window.__store?.getState().updateSettings({ experimentalNativeTerminal: true })
  })

  // A split binds a fresh PTY with the setting on.
  await splitActiveTerminalPane(orcaPage, 'vertical')
  await waitForPaneCount(orcaPage, 2)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  const ptyId = await waitForActivePanePtyId(orcaPage)
  await waitForPtyShellEcho(orcaPage, ptyId, 30_000)

  let surfaceId = 0
  await expect
    .poll(
      async () => {
        surfaceId = (await surfaceIds(electronApp)).at(-1) ?? 0
        return surfaceId
      },
      { timeout: 15_000, message: 'no native terminal surface was created for the new pane' }
    )
    .toBeGreaterThan(0)

  // Output: PTY bytes that reach xterm also reach the native screen.
  await execInTerminal(orcaPage, ptyId, "printf 'NATIVE-%s\\n' OUT-OK")
  await waitForTerminalOutput(orcaPage, 'NATIVE-OUT-OK')
  await expect
    .poll(async () => screenText(electronApp, surfaceId), { timeout: 10_000 })
    .toContain('NATIVE-OUT-OK')

  // Input: keys typed into the native view are encoded by Ghostty, take the pane's PTY input
  // path, and the echo comes back to both screens.
  for (const character of "printf 'NATIVE-%s\\n' IN-OK") {
    await debugCall(electronApp, 'key', [surfaceId, character, 0, 0])
  }
  await debugCall(electronApp, 'key', [surfaceId, '\r', RETURN_KEY_CODE, 0])
  await waitForTerminalOutput(orcaPage, 'NATIVE-IN-OK')
  await expect.poll(async () => screenText(electronApp, surfaceId)).toContain('NATIVE-IN-OK')

  // Grid: the hidden xterm (and so the PTY) follows Ghostty's cell grid.
  await expect
    .poll(async () => {
      const native = await nativeGrid(electronApp, surfaceId)
      const xterm = await activeXtermGrid(orcaPage)
      return native && xterm ? `${xterm.cols}x${xterm.rows}=${native}` : null
    })
    .toMatch(/^(\d+)x(\d+)=\1x\2$/)
  // The grid must fill the pane, not collapse through the xterm/native resize loop.
  const rows = Number((await nativeGrid(electronApp, surfaceId))?.split('x')[1])
  expect(rows).toBeGreaterThan(5)

  // Placement: the view is visible and covers the pane's terminal box (inside its padding).
  await expect.poll(async () => isHidden(electronApp, surfaceId)).toBe(false)
  await expect
    .poll(async () => {
      const state = await debugCall(electronApp, 'state', [surfaceId])
      const rect = await orcaPage
        .locator(`.pane[data-pty-id="${ptyId}"] .xterm-container`)
        .evaluate((element) => {
          const box = element.getBoundingClientRect()
          const style = getComputedStyle(element)
          const left = Number.parseFloat(style.paddingLeft) || 0
          const top = Number.parseFloat(style.paddingTop) || 0
          const width = box.width - left - (Number.parseFloat(style.paddingRight) || 0)
          const height = box.height - top - (Number.parseFloat(style.paddingBottom) || 0)
          // The view may start lower to keep pane chrome (title bar, actions) clickable.
          return [box.left + left, width, box.top + top + height].map(Math.round).join(',')
        })
      if (typeof state !== 'object' || state === null) {
        return null
      }
      const [x, y, width, height] = ['x', 'y', 'width', 'height'].map((key) =>
        Number(Reflect.get(state, key))
      )
      const frame = [x, width, y + height].map(Math.round).join(',')
      return frame === rect ? 'aligned' : `${frame} vs ${rect}`
    })
    .toBe('aligned')

  // Overlays: DOM UI over the pane hides the native view so it can render on top.
  await orcaPage.evaluate(() => {
    const overlay = document.createElement('div')
    overlay.id = 'native-terminal-e2e-overlay'
    overlay.setAttribute('role', 'dialog')
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999'
    document.body.appendChild(overlay)
  })
  await expect.poll(async () => isHidden(electronApp, surfaceId)).toBe(true)
  await orcaPage.evaluate(() => document.getElementById('native-terminal-e2e-overlay')?.remove())
  await expect.poll(async () => isHidden(electronApp, surfaceId)).toBe(false)

  // Let the re-shown surface present a fresh frame before capturing it.
  await orcaPage.waitForTimeout(500)
  // Same screen through both renderers, for review: the web terminal (DOM) and Ghostty (native).
  const xtermShot = testInfo.outputPath('xterm-terminal.png')
  await orcaPage.locator(`.pane[data-pty-id="${ptyId}"] .xterm`).screenshot({ path: xtermShot })
  await testInfo.attach('xterm-terminal', { path: xtermShot, contentType: 'image/png' })

  const png = await debugCall(electronApp, 'snapshotBase64', [surfaceId])
  if (typeof png === 'string') {
    const file = testInfo.outputPath('native-terminal.png')
    writeFileSync(file, Buffer.from(png, 'base64'))
    await testInfo.attach('native-terminal', { path: file, contentType: 'image/png' })
  }
})
