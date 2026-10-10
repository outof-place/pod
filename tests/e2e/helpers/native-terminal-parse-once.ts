import { randomUUID } from 'node:crypto'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect } from './orca-app'
import {
  findNativeSurfaceForPane,
  isNativeSurfaceHidden,
  nativeScreenText
} from './native-terminal-debug'
import {
  execInTerminal,
  splitActiveTerminalPane,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './terminal'

// Parse once: a pane's xterm leaves the PTY byte stream while a main-fed native view covers
// it, so readiness and output checks must read the native screen, not xterm.

export async function setNativeTerminalParseOnce(page: Page, enabled: boolean): Promise<void> {
  await page.evaluate(async (value) => {
    await window.__store?.getState().updateSettings({ experimentalNativeTerminalParseOnce: value })
  }, enabled)
}

// The shell is up once output from a command it ran reaches the native screen.
export async function waitForNativeShellReady(
  page: Page,
  app: ElectronApplication,
  ptyId: string,
  surfaceId: number
): Promise<void> {
  const id = randomUUID().slice(0, 8)
  await execInTerminal(page, ptyId, `printf 'READY-%s\\n' ${id}`)
  await expect
    .poll(async () => nativeScreenText(app, surfaceId), { timeout: 30_000 })
    .toContain(`READY-${id}`)
}

export async function splitParseOncePane(
  page: Page,
  app: ElectronApplication,
  direction: 'vertical' | 'horizontal' = 'vertical'
): Promise<{ ptyId: string; surfaceId: number }> {
  const previous = await waitForActivePanePtyId(page)
  await splitActiveTerminalPane(page, direction)
  await waitForActiveTerminalManager(page, 30_000)
  let ptyId = previous
  await expect
    .poll(async () => (ptyId = await waitForActivePanePtyId(page)), { timeout: 15_000 })
    .not.toBe(previous)
  const surfaceId = await findNativeSurfaceForPane(page, ptyId)
  if (surfaceId === null) {
    throw new Error(`no native terminal surface shows the new pane ${ptyId}`)
  }
  await expect.poll(async () => isNativeSurfaceHidden(app, surfaceId)).toBe(false)
  await waitForNativeShellReady(page, app, ptyId, surfaceId)
  return { ptyId, surfaceId }
}
