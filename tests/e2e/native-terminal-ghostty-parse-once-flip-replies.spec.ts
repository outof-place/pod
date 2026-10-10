/**
 * Parse once: a query queued for a pane that a main-fed native view covers gets exactly one
 * reply when the pane hides or is revealed before main delivers it. Main's model answered the
 * query at ingestion, so neither the hidden view nor the revealed xterm may answer it again.
 */
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { enableNativeTerminal, xtermScreenTransform } from './helpers/native-terminal-debug'
import {
  setNativeTerminalParseOnce,
  splitParseOncePane
} from './helpers/native-terminal-parse-once'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActiveTerminalManager } from './helpers/terminal'
import {
  hidePage,
  readReplies,
  revealPage,
  setAckGate,
  startQueryFlipProgram
} from './helpers/terminal-query-flip-probe'

test.describe.configure({ mode: 'serial' })
test.skip(process.platform !== 'darwin', 'the native Ghostty terminal is macOS only')

// A new native pane whose xterm has left the byte stream under the native view.
async function coveredPane(page: Page, app: ElectronApplication): Promise<string> {
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page, 30_000)
  await setNativeTerminalParseOnce(page, true)
  await enableNativeTerminal(page)
  const pane = await splitParseOncePane(page, app)
  await expect.poll(async () => xtermScreenTransform(page, pane.ptyId)).not.toBe('')
  return pane.ptyId
}

test.afterEach(async ({ orcaPage }) => {
  await setAckGate(orcaPage, null).catch(() => undefined)
  await orcaPage.evaluate(() => {
    Reflect.deleteProperty(document, 'visibilityState')
    document.dispatchEvent(new Event('visibilitychange'))
  })
})

test('a covered pane’s queued query is answered once after the pane hides', async ({
  orcaPage,
  electronApp
}) => {
  test.setTimeout(180_000)
  const ptyId = await coveredPane(orcaPage, electronApp)
  const program = await startQueryFlipProgram(orcaPage, ptyId)
  await setAckGate(orcaPage, ptyId)
  await program.go(1)
  await program.go(2)

  await hidePage(orcaPage)
  await setAckGate(orcaPage, null)

  await expect.poll(() => readReplies(program.out), { timeout: 15_000 }).toEqual({ cpr: 1, da1: 1 })
  await new Promise((resolve) => setTimeout(resolve, 3_000))
  expect(readReplies(program.out)).toEqual({ cpr: 1, da1: 1 })
})

test('a covered pane’s query main answered while hidden is not answered again after a reveal', async ({
  orcaPage,
  electronApp
}) => {
  test.setTimeout(180_000)
  const ptyId = await coveredPane(orcaPage, electronApp)
  const program = await startQueryFlipProgram(orcaPage, ptyId)
  await setAckGate(orcaPage, ptyId)
  await program.go(1)

  // A sidecar keeps the hidden bytes queued instead of dropped.
  await orcaPage.evaluate((id) => window.api.pty.setPtyDeliveryInterest(id, true), ptyId)
  const gatedBefore = await hidePage(orcaPage)
  await program.go(2)
  await expect.poll(() => readReplies(program.out), { timeout: 15_000 }).toEqual({ cpr: 1, da1: 1 })

  await revealPage(orcaPage, gatedBefore)
  await setAckGate(orcaPage, null)
  await orcaPage.evaluate((id) => window.api.pty.setPtyDeliveryInterest(id, false), ptyId)

  await new Promise((resolve) => setTimeout(resolve, 3_000))
  expect(readReplies(program.out)).toEqual({ cpr: 1, da1: 1 })
})
