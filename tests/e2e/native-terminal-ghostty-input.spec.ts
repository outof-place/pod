import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import {
  execInTerminal,
  splitActiveTerminalPane,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForPaneCount
} from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { getTerminalContentForPtyId, waitForPtyShellEcho } from './terminal-pty-readiness'
import {
  nativeSurfaceField,
  nativeSurfaceIds,
  nativeTerminalDebug
} from './helpers/native-terminal-debug'

// NSEventModifierFlags and macOS virtual key codes (Carbon kVK_*).
const CONTROL = 1 << 18
const OPTION = 1 << 19
const KEY_C = 0x08
const KEY_H = 0x04
const KEY_TAB = 0x30
const KEY_RETURN = 0x24
const KEY_CONTROL = 0x3b
const KEY_OPTION = 0x3a

test.describe.configure({ mode: 'serial' })
test.skip(process.platform !== 'darwin', 'the native Ghostty terminal is macOS only')

function key(
  app: ElectronApplication,
  surfaceId: number,
  characters: string,
  keyCode: number,
  modifierFlags = 0
): Promise<unknown> {
  return nativeTerminalDebug(app, 'key', [surfaceId, characters, keyCode, modifierFlags])
}

async function activeTabAndPane(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const tabId = window.__store?.getState().activeTabId
    const pane = tabId ? window.__paneManagers?.get(tabId)?.getActivePane() : null
    return tabId && pane ? `${tabId}:${pane.id}` : null
  })
}

async function forwardsChord(
  app: ElectronApplication,
  character: string,
  modifierFlags: number
): Promise<boolean> {
  const chords = await nativeTerminalDebug(app, 'forwardedChords')
  return (
    Array.isArray(chords) &&
    chords.some(
      (chord: unknown) =>
        typeof chord === 'object' &&
        chord !== null &&
        Reflect.get(chord, 'character') === character &&
        Reflect.get(chord, 'modifierFlags') === modifierFlags
    )
  )
}

test('native terminal panes keep Orca drops, app chords and held-modifier UI', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  await orcaPage.evaluate(async () => {
    await window.__store?.getState().updateSettings({ experimentalNativeTerminal: true })
  })
  await splitActiveTerminalPane(orcaPage, 'vertical')
  await waitForPaneCount(orcaPage, 2)
  const ptyId = await waitForActivePanePtyId(orcaPage)
  await waitForPtyShellEcho(orcaPage, ptyId, 30_000)
  let surfaceId = 0
  await expect
    .poll(async () => {
      surfaceId = (await nativeSurfaceIds(electronApp)).at(-1) ?? 0
      return surfaceId
    })
    .toBeGreaterThan(0)
  await expect.poll(async () => nativeSurfaceField(electronApp, surfaceId, 'hidden')).toBe(false)
  // Unwrapped, so a long path reads as one line.
  const paneContent = async (): Promise<string> =>
    (await getTerminalContentForPtyId(orcaPage, ptyId, 8000)).replace(/\r?\n/g, '')

  // Drops: AppKit hands a drag over the native view to the web contents beneath, so the
  // pane's DOM drop owner writes the shell-escaped path exactly as for an xterm pane.
  const dropDir = testInfo.outputPath('native drop')
  mkdirSync(dropDir, { recursive: true })
  const droppedFile = path.join(dropDir, 'dropped file.txt')
  writeFileSync(droppedFile, 'native drop\n')
  const drop = await nativeTerminalDebug(electronApp, 'drop', [surfaceId, [droppedFile]])
  expect(String(Reflect.get(Object(drop), 'destination'))).not.toMatch(/OrcaGhostty/)
  await expect.poll(paneContent, { timeout: 10_000 }).toContain(`'${droppedFile}'`)
  await key(electronApp, surfaceId, 'c', KEY_C, CONTROL)

  // App chords: a user binding reaches the native view and Orca claims it; the PTY never
  // sees it (cat -v would echo the chord as ^[^H).
  await execInTerminal(orcaPage, ptyId, 'cat -v')
  await orcaPage.evaluate(async () => {
    await window.api.keybindings.setAction({
      actionId: 'terminal.focusPreviousPane',
      bindings: ['Ctrl+Alt+H']
    })
  })
  await expect.poll(async () => forwardsChord(electronApp, 'h', CONTROL | OPTION)).toBe(true)
  await nativeTerminalDebug(electronApp, 'focus', [surfaceId])
  const beforeChord = await activeTabAndPane(orcaPage)
  await key(electronApp, surfaceId, 'h', KEY_H, CONTROL | OPTION)
  await expect.poll(async () => activeTabAndPane(orcaPage)).not.toBe(beforeChord)
  // The chord's modifiers are released over the native view; Orca still gets their keyups.
  expect(await nativeSurfaceField(electronApp, surfaceId, 'windowFirstResponder')).toBe(
    'OrcaGhosttySurfaceView'
  )
  await orcaPage.evaluate(() => {
    const released: string[] = []
    Reflect.set(window, '__nativeReleasedKeys', released)
    window.addEventListener('keyup', (event) => released.push(event.key), { capture: true })
  })
  await nativeTerminalDebug(electronApp, 'modifiersChanged', [surfaceId, KEY_OPTION, 0])
  await expect
    .poll(async () => orcaPage.evaluate(() => Reflect.get(window, '__nativeReleasedKeys')))
    .toEqual(expect.arrayContaining(['Control', 'Alt']))
  for (const character of 'zq') {
    await key(electronApp, surfaceId, character, 0)
  }
  await key(electronApp, surfaceId, '\r', KEY_RETURN)
  // The echo and cat's copy of the marker follow `cat -v` directly: no chord bytes between.
  await expect.poll(paneContent).toContain('cat -vzqzq')
  await key(electronApp, surfaceId, 'c', KEY_C, CONTROL)

  // Held chords: the default Ctrl+Tab opens the recent-tab switcher, and the Control release
  // that commits it is replayed to Orca too.
  const tabs = await orcaPage.evaluate((worktreeId) => {
    const state = window.__store?.getState()
    const nativeTab = state?.activeTabId
    if (!state || !nativeTab) {
      throw new Error('no active tab')
    }
    const other = state.createTab(worktreeId, undefined, undefined, { activate: true })
    state.setActiveTab(other.id)
    state.setActiveTab(nativeTab)
    return { nativeTab, other: other.id }
  }, worktreeId)
  await expect.poll(async () => nativeSurfaceField(electronApp, surfaceId, 'hidden')).toBe(false)
  await nativeTerminalDebug(electronApp, 'focus', [surfaceId])
  await key(electronApp, surfaceId, '\t', KEY_TAB, CONTROL)
  await expect(orcaPage.getByRole('listbox', { name: 'Switch tabs' })).toBeVisible()
  expect(await orcaPage.evaluate(() => window.__store?.getState().activeTabId)).toBe(tabs.nativeTab)
  // The switcher covers the native view, which hands the keyboard back to the web contents.
  await expect.poll(async () => nativeSurfaceField(electronApp, surfaceId, 'hidden')).toBe(true)
  expect(await nativeSurfaceField(electronApp, surfaceId, 'windowFirstResponder')).toBe(
    'RenderWidgetHostViewCocoa'
  )
  // From there Chromium reports the Control release itself; the native view must not repeat it.
  await nativeTerminalDebug(electronApp, 'modifiersChanged', [surfaceId, KEY_CONTROL, 0])
  await orcaPage.waitForTimeout(300)
  expect(await orcaPage.evaluate(() => window.__store?.getState().activeTabId)).toBe(tabs.nativeTab)
  // A hidden test window is never key, so AppKit cannot deliver that release to Chromium.
  await orcaPage.keyboard.up('Control')
  await expect
    .poll(async () => orcaPage.evaluate(() => window.__store?.getState().activeTabId))
    .toBe(tabs.other)
  await expect(orcaPage.getByRole('listbox', { name: 'Switch tabs' })).toHaveCount(0)
})
