import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { ElectronApplication, Page, TestInfo } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  RETURN_KEY_CODE,
  enableNativeTerminal,
  findNativeSurfaceForPane,
  isNativeSurfaceHidden,
  nativeGridSize,
  nativeScreenText,
  nativeTerminalDebug,
  xtermScreenTransform
} from './helpers/native-terminal-debug'
import {
  setNativeTerminalParseOnce,
  splitParseOncePane
} from './helpers/native-terminal-parse-once'
import { expectIdenticalScreens } from './helpers/native-terminal-screens'
import {
  execInTerminal,
  splitActiveTerminalPane,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'
import { openTerminalTab } from './helpers/native-terminal-process-usage'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { getTerminalContentForPtyId, waitForPtyShellEcho } from './terminal-pty-readiness'
import { nodeTerminalCommand } from './terminal-node-command'

// Parse once: while a main-fed native view covers its pane, the pane's xterm takes no PTY
// bytes; main's model answers the PTY's queries, and xterm catches up before it shows again.

const DIALOG_ID = 'e2e-parse-once-dialog'
const CONTROL = 1 << 18
const KEY_C = 0x08
const KEY_ESCAPE = 0x35
// Why so long: the pane's WebGL context is freed only after the view stayed up a while.
const WEBGL_SUSPEND_TIMEOUT_MS = 15_000

test.describe.configure({ mode: 'serial' })
test.skip(process.platform !== 'darwin', 'the native Ghostty terminal is macOS only')

async function prepare(page: Page): Promise<void> {
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page, 30_000)
  await expect
    .poll(async () => page.locator('[data-radix-popper-content-wrapper]').count(), {
      timeout: 30_000
    })
    .toBe(0)
  await setNativeTerminalParseOnce(page, true)
  await enableNativeTerminal(page)
}

// A new native pane whose xterm has left the byte stream under the native view.
async function splitDetachedPane(
  page: Page,
  app: ElectronApplication
): Promise<{ ptyId: string; surfaceId: number }> {
  const pane = await splitParseOncePane(page, app)
  // xterm leaves the byte stream together with its paint, once the view presented over it.
  await expect.poll(async () => xtermScreenTransform(page, pane.ptyId)).not.toBe('')
  return pane
}

function showDialogOverPane(page: Page, ptyId: string): Promise<void> {
  return page.evaluate(
    ({ id, dialogId }) => {
      const box = document
        .querySelector(`.pane[data-pty-id="${id}"] .xterm-container`)
        ?.getBoundingClientRect()
      if (!box) {
        throw new Error(`no terminal box for PTY ${id}`)
      }
      const dialog = document.createElement('div')
      dialog.id = dialogId
      dialog.setAttribute('role', 'dialog')
      dialog.style.cssText = `position:fixed;left:${box.left + 40}px;top:${box.top + 40}px;width:200px;height:120px;background:#fff;z-index:9999`
      document.body.appendChild(dialog)
    },
    { id: ptyId, dialogId: DIALOG_ID }
  )
}

function removeDialog(page: Page): Promise<void> {
  return page.evaluate((dialogId) => document.getElementById(dialogId)?.remove(), DIALOG_ID)
}

function paneUsesWebgl(page: Page, ptyId: string): Promise<boolean> {
  return page.evaluate((id) => {
    for (const manager of window.__paneManagers?.values() ?? []) {
      const pane = manager.getPanes().find((candidate) => candidate.container.dataset.ptyId === id)
      if (pane) {
        return manager.hasWebglRenderer(pane.id)
      }
    }
    return false
  }, ptyId)
}

// Asks for the cursor position in raw mode and reports how many replies came back.
function writeCursorReportProbe(testInfo: TestInfo): string {
  const scriptPath = testInfo.outputPath('cursor-report-probe.mjs')
  writeFileSync(
    scriptPath,
    `let replies = 0
process.stdin.setRawMode(true)
process.stdin.on('data', (data) => {
  replies += (String(data).match(/\\x1b\\[\\d+;\\d+R/g) ?? []).length
})
process.stdout.write('\\x1b[6n')
setTimeout(() => {
  console.log('CPR-REPLIES-' + replies)
  process.exit(0)
}, 1500)
`
  )
  return nodeTerminalCommand([scriptPath])
}

function key(
  app: ElectronApplication,
  surfaceId: number,
  characters: string,
  keyCode = 0,
  modifiers = 0
): Promise<unknown> {
  return nativeTerminalDebug(app, 'key', [surfaceId, characters, keyCode, modifiers])
}

async function typeKeys(app: ElectronApplication, surfaceId: number, text: string): Promise<void> {
  for (const character of text) {
    await key(app, surfaceId, character)
  }
  await key(app, surfaceId, '\r', RETURN_KEY_CODE)
}

// Native panes paste through Orca's paste pipeline, as a Services menu paste does.
async function paste(app: ElectronApplication, surfaceId: number, text: string): Promise<void> {
  expect(await nativeTerminalDebug(app, 'services', [surfaceId, 'read', text])).toBe(true)
}

function screenRows(text: string): string[] {
  return text.split('\n').map((row) => row.trim())
}

type QueryReplies = {
  cpr: number
  da: number
  osc11: number
  pixels14: number
  cells18: number
  scheme996: number
  position: [number, number] | null
}

// Sends CPR, DA1, OSC 11, XTWINOPS 14t/18t and the ?996n color-scheme query in raw mode, and
// records how many replies of each came back, and where CPR put the cursor, in a file (the pane
// may be hidden).
function writeQueryProbe(testInfo: TestInfo, name: string): { command: string; result: string } {
  const script = testInfo.outputPath(`${name}.mjs`)
  const result = testInfo.outputPath(`${name}.json`)
  writeFileSync(
    script,
    `import { writeFileSync } from 'node:fs'
const seen = { cpr: 0, da: 0, osc11: 0, pixels14: 0, cells18: 0, scheme996: 0, position: null }
const count = (text, pattern) => (text.match(pattern) ?? []).length
process.stdin.setRawMode(true)
process.stdin.on('data', (data) => {
  const text = String(data)
  for (const match of text.matchAll(/\\x1b\\[(\\d+);(\\d+)R/g)) {
    seen.cpr += 1
    seen.position = [Number(match[1]), Number(match[2])]
  }
  seen.da += count(text, /\\x1b\\[\\?[\\d;]*c/g)
  seen.osc11 += count(text, /\\x1b\\]11;rgb:/g)
  seen.pixels14 += count(text, /\\x1b\\[4;\\d+;\\d+t/g)
  seen.cells18 += count(text, /\\x1b\\[8;\\d+;\\d+t/g)
  seen.scheme996 += count(text, /\\x1b\\[\\?997;\\dn/g)
})
process.stdout.write('\\x1b[6n\\x1b[c\\x1b]11;?\\x07\\x1b[14t\\x1b[18t\\x1b[?996n')
setTimeout(() => {
  writeFileSync(${JSON.stringify(result)}, JSON.stringify(seen))
  console.log('QUERY-PROBE-DONE')
  process.exit(0)
}, 1500)
`
  )
  return { command: nodeTerminalCommand([script]), result }
}

async function readQueryProbe(result: string): Promise<QueryReplies> {
  await expect.poll(() => existsSync(result), { timeout: 10_000 }).toBe(true)
  return JSON.parse(readFileSync(result, 'utf8'))
}

async function probeQueries(
  page: Page,
  testInfo: TestInfo,
  ptyId: string,
  name: string
): Promise<QueryReplies> {
  const probe = writeQueryProbe(testInfo, name)
  await execInTerminal(page, ptyId, probe.command)
  return readQueryProbe(probe.result)
}

function replyCounts(replies: QueryReplies): Omit<QueryReplies, 'position'> {
  const { position: _position, ...counts } = replies
  return counts
}

test('a covered pane’s xterm takes no PTY bytes, and main answers its queries once', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  await prepare(orcaPage)
  const { ptyId, surfaceId } = await splitDetachedPane(orcaPage, electronApp)
  await execInTerminal(orcaPage, ptyId, "printf 'PARSE-%s\\n' ONCE")
  await expect.poll(async () => nativeScreenText(electronApp, surfaceId)).toContain('PARSE-ONCE')
  await execInTerminal(orcaPage, ptyId, writeCursorReportProbe(testInfo))
  await expect
    .poll(async () => nativeScreenText(electronApp, surfaceId), { timeout: 10_000 })
    .toContain('CPR-REPLIES-1')
  expect(await getTerminalContentForPtyId(orcaPage, ptyId, 4000)).not.toContain('PARSE-ONCE')
})

test('xterm catches up from main’s model before the native view hides for a dialog', async ({
  orcaPage,
  electronApp
}) => {
  await prepare(orcaPage)
  const { ptyId, surfaceId } = await splitDetachedPane(orcaPage, electronApp)
  const usedWebgl = await paneUsesWebgl(orcaPage, ptyId)
  await execInTerminal(orcaPage, ptyId, "seq 1 30000; printf 'FLOOD-%s\\n' DONE")
  await expect
    .poll(async () => nativeScreenText(electronApp, surfaceId), { timeout: 30_000 })
    .toContain('FLOOD-DONE')
  expect(await getTerminalContentForPtyId(orcaPage, ptyId, 4000)).not.toContain('FLOOD-DONE')
  if (usedWebgl) {
    // The covered pane gives its WebGL context back.
    await expect
      .poll(async () => paneUsesWebgl(orcaPage, ptyId), { timeout: WEBGL_SUSPEND_TIMEOUT_MS })
      .toBe(false)
  }

  await showDialogOverPane(orcaPage, ptyId)
  await expect.poll(async () => isNativeSurfaceHidden(electronApp, surfaceId)).toBe(true)
  // The view hid only after xterm held the same screen.
  expect(await getTerminalContentForPtyId(orcaPage, ptyId, 4000)).toContain('FLOOD-DONE')
  await expectIdenticalScreens(orcaPage, electronApp, ptyId, surfaceId)
  if (usedWebgl) {
    expect(await paneUsesWebgl(orcaPage, ptyId)).toBe(true)
  }

  // Back under the view, xterm leaves the stream again.
  await removeDialog(orcaPage)
  await expect.poll(async () => isNativeSurfaceHidden(electronApp, surfaceId)).toBe(false)
  await expect.poll(async () => xtermScreenTransform(orcaPage, ptyId)).not.toBe('')
  await execInTerminal(orcaPage, ptyId, "printf 'AGAIN-%s\\n' COVERED")
  await expect.poll(async () => nativeScreenText(electronApp, surfaceId)).toContain('AGAIN-COVERED')
  expect(await getTerminalContentForPtyId(orcaPage, ptyId, 4000)).not.toContain('AGAIN-COVERED')
})

test('after a reload the reattached native view is fed while xterm stays off the stream', async ({
  orcaPage,
  electronApp
}) => {
  await prepare(orcaPage)
  const { ptyId } = await splitDetachedPane(orcaPage, electronApp)
  await execInTerminal(orcaPage, ptyId, "seq 1 300; printf 'BEFORE-%s\\n' RELOAD")

  await orcaPage.reload()
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  const surfaceId = await findNativeSurfaceForPane(orcaPage, ptyId, 30_000)
  expect(surfaceId).not.toBeNull()
  await expect
    .poll(async () => nativeScreenText(electronApp, surfaceId ?? 0), { timeout: 15_000 })
    .toContain('BEFORE-RELOAD')
  await expect.poll(async () => xtermScreenTransform(orcaPage, ptyId)).not.toBe('')
  await execInTerminal(orcaPage, ptyId, "printf 'AFTER-%s\\n' RELOAD")
  await expect
    .poll(async () => nativeScreenText(electronApp, surfaceId ?? 0))
    .toContain('AFTER-RELOAD')
  expect(await getTerminalContentForPtyId(orcaPage, ptyId, 4000)).not.toContain('AFTER-RELOAD')
})

test('typing, a multi-line bracketed paste and a kitty-keyboard app behave as in xterm mode', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  await prepare(orcaPage)
  const { ptyId, surfaceId } = await splitDetachedPane(orcaPage, electronApp)
  await typeKeys(electronApp, surfaceId, "printf 'TYPED-%s\\n' KEYS")
  await expect.poll(async () => nativeScreenText(electronApp, surfaceId)).toContain('TYPED-KEYS')

  // At the prompt the shell turned bracketed paste on after xterm left the stream: the paste
  // must still arrive bracketed, so the shell takes both lines without running either.
  await paste(electronApp, surfaceId, 'echo PASTE-ONE\necho PASTE-TWO')
  await expect
    .poll(async () => nativeScreenText(electronApp, surfaceId))
    .toContain('echo PASTE-TWO')
  await orcaPage.waitForTimeout(500)
  expect(screenRows(await nativeScreenText(electronApp, surfaceId))).not.toContain('PASTE-ONE')
  await key(electronApp, surfaceId, 'c', KEY_C, CONTROL)

  // A program the shell started has bracketed paste off again: no bracket markers reach it.
  await execInTerminal(orcaPage, ptyId, 'cat')
  await orcaPage.waitForTimeout(500)
  await paste(electronApp, surfaceId, 'plain line\nsecond line')
  await expect.poll(async () => nativeScreenText(electronApp, surfaceId)).toContain('second line')
  expect(await nativeScreenText(electronApp, surfaceId)).not.toContain('200~')
  await key(electronApp, surfaceId, 'c', KEY_C, CONTROL)

  // An app that turns on the kitty keyboard protocol gets Escape as CSI 27 u.
  const script = testInfo.outputPath('kitty-probe.mjs')
  writeFileSync(
    script,
    `process.stdout.write('\\x1b[>1u')
process.stdin.setRawMode(true)
process.stdout.write('KITTY-READY\\n')
process.stdin.once('data', (data) => {
  process.stdout.write('\\x1b[<u')
  console.log('KITTY-' + Buffer.from(data).toString('hex'))
  process.exit(0)
})
`
  )
  await execInTerminal(orcaPage, ptyId, nodeTerminalCommand([script]))
  await expect.poll(async () => nativeScreenText(electronApp, surfaceId)).toContain('KITTY-READY')
  await key(electronApp, surfaceId, '\x1b', KEY_ESCAPE)
  await expect
    .poll(async () => nativeScreenText(electronApp, surfaceId))
    .toContain('KITTY-1b5b323775')
  expect(await getTerminalContentForPtyId(orcaPage, ptyId, 4000)).not.toContain('KITTY-READY')
})

test('an agent starting in a covered pane is detected from its title', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  await prepare(orcaPage)
  const { ptyId } = await splitDetachedPane(orcaPage, electronApp)
  const script = testInfo.outputPath('agent-title.cjs')
  writeFileSync(
    script,
    `process.stdout.write('\\x1b]0;OMP : Image review\\x07')
process.stdin.on('data', () => process.stdout.write('\\x1b]0;OMP > Image review\\x07'))
`
  )
  await execInTerminal(orcaPage, ptyId, nodeTerminalCommand([script]))
  const working = orcaPage.locator('[aria-label="Working"]')
  await expect(working.first()).toBeVisible({ timeout: 15_000 })
})

test('every query class gets the replies xterm mode gives, after a resize and with interest too', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  await prepare(orcaPage)
  // The baseline: the same probes in xterm mode, visible and behind another tab.
  await enableNativeTerminal(orcaPage, false)
  await openTerminalTab(orcaPage)
  const xtermPty = await waitForActivePanePtyId(orcaPage)
  await waitForPtyShellEcho(orcaPage, xtermPty, 30_000)
  const xtermVisible = replyCounts(await probeQueries(orcaPage, testInfo, xtermPty, 'xterm-shown'))
  await openTerminalTab(orcaPage)
  const xtermHidden = replyCounts(await probeQueries(orcaPage, testInfo, xtermPty, 'xterm-hidden'))
  for (const counts of [xtermVisible, xtermHidden]) {
    expect(counts).toMatchObject({ cpr: 1, da: 1, osc11: 1, scheme996: 1 })
    expect(counts.cells18).toBeLessThanOrEqual(1)
  }
  expect(xtermVisible.pixels14).toBe(1)
  await enableNativeTerminal(orcaPage, true)

  const { ptyId, surfaceId } = await splitDetachedPane(orcaPage, electronApp)
  const covered = await probeQueries(orcaPage, testInfo, ptyId, 'query-covered')
  expect(replyCounts(covered)).toEqual(xtermVisible)

  // The pane narrows when it splits; main's model answers at the new grid.
  const before = await nativeGridSize(electronApp, surfaceId)
  await splitActiveTerminalPane(orcaPage, 'vertical')
  await expect
    .poll(async () => (await nativeGridSize(electronApp, surfaceId))?.columns ?? 0)
    .toBeLessThan(before?.columns ?? 0)
  await expect.poll(async () => xtermScreenTransform(orcaPage, ptyId)).not.toBe('')
  const afterResize = await probeQueries(orcaPage, testInfo, ptyId, 'query-resized')
  expect(replyCounts(afterResize)).toEqual(xtermVisible)
  const grid = await nativeGridSize(electronApp, surfaceId)
  expect(afterResize.position?.[1]).toBe(1)
  expect(afterResize.position?.[0]).toBeLessThanOrEqual(grid?.rows ?? 0)

  // A sidecar's delivery interest (a background-launched agent) keeps the bytes coming.
  await orcaPage.evaluate((id) => window.api.pty.setPtyDeliveryInterest(id, true), ptyId)
  const interested = await probeQueries(orcaPage, testInfo, ptyId, 'query-interest')
  expect(replyCounts(interested)).toEqual(xtermVisible)

  // ...and while the pane is hidden behind another tab.
  await openTerminalTab(orcaPage)
  await expect.poll(async () => isNativeSurfaceHidden(electronApp, surfaceId)).toBe(true)
  const hidden = await probeQueries(orcaPage, testInfo, ptyId, 'query-hidden')
  expect(replyCounts(hidden)).toEqual(xtermHidden)
})

test('xterm rejoining mid-flood matches main’s model once the flood ends', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  await prepare(orcaPage)
  const { ptyId, surfaceId } = await splitDetachedPane(orcaPage, electronApp)
  // Why a paced flood: main still has bytes pending for the PTY when xterm asks to rejoin.
  const script = testInfo.outputPath('paced-flood.mjs')
  writeFileSync(
    script,
    `let tick = 0
const timer = setInterval(() => {
  tick += 1
  process.stdout.write(Array.from({ length: 1000 }, (_, line) => 'TICK ' + tick + ' ' + line).join('\\n') + '\\n')
  if (tick === 200) {
    clearInterval(timer)
    console.log('FLOOD-OVER')
  }
}, 10)
`
  )
  await execInTerminal(orcaPage, ptyId, nodeTerminalCommand([script]))
  await expect
    .poll(async () => nativeScreenText(electronApp, surfaceId), { timeout: 15_000 })
    .toContain('TICK ')
  await showDialogOverPane(orcaPage, ptyId)
  await expect.poll(async () => isNativeSurfaceHidden(electronApp, surfaceId)).toBe(true)
  await expect
    .poll(async () => getTerminalContentForPtyId(orcaPage, ptyId, 4000), { timeout: 60_000 })
    .toContain('FLOOD-OVER')
  await expectIdenticalScreens(orcaPage, electronApp, ptyId, surfaceId)
  await removeDialog(orcaPage)
})
