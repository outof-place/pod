/**
 * A terminal query gets exactly one reply even when the pane's visibility flips while the
 * chunk carrying it is still queued in main. Main decides who answers when it ingests the
 * chunk: the pane's view while visible, main's model while the view is gated.
 *
 * Each test holds the renderer's delivery credit so main's in-flight window fills and the
 * query stays queued, flips the pane, then releases the credit and counts the replies the
 * program reads. Before the fix a hide flip dropped the queued query (no reply) and a
 * reveal flip handed the view a query main had already answered (two replies).
 */
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady, waitForActiveWorktree, ensureTerminalVisible } from './helpers/store'
import { waitForActiveTerminalManager, waitForActivePanePtyId } from './helpers/terminal'
import {
  hidePage,
  readReplies,
  revealPage,
  setAckGate,
  startQueryFlipProgram
} from './helpers/terminal-query-flip-probe'

async function startProgram(page: Page): Promise<{
  ptyId: string
  out: string
  go: (phase: 1 | 2) => Promise<void>
}> {
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page)
  const ptyId = await waitForActivePanePtyId(page)
  return { ptyId, ...(await startQueryFlipProgram(page, ptyId)) }
}

test.describe('terminal query replies across a visibility flip', () => {
  test.afterEach(async ({ orcaPage }) => {
    await setAckGate(orcaPage, null).catch(() => undefined)
    await orcaPage.evaluate(() => {
      Reflect.deleteProperty(document, 'visibilityState')
      document.dispatchEvent(new Event('visibilitychange'))
    })
  })

  test('a query queued while visible is answered once after the pane hides', async ({
    orcaPage
  }) => {
    test.setTimeout(120_000)
    const program = await startProgram(orcaPage)
    await setAckGate(orcaPage, program.ptyId)
    await program.go(1)
    await program.go(2)

    await hidePage(orcaPage)
    await setAckGate(orcaPage, null)

    await expect
      .poll(() => readReplies(program.out), { timeout: 15_000 })
      .toEqual({ cpr: 1, da1: 1 })
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    expect(readReplies(program.out)).toEqual({ cpr: 1, da1: 1 })
  })

  test('a query main answered while hidden is not answered again after a reveal', async ({
    orcaPage
  }) => {
    test.setTimeout(120_000)
    const program = await startProgram(orcaPage)
    await setAckGate(orcaPage, program.ptyId)
    await program.go(1)

    // A sidecar keeps the hidden bytes queued instead of dropped.
    await orcaPage.evaluate((id) => window.api.pty.setPtyDeliveryInterest(id, true), program.ptyId)
    await hidePage(orcaPage)
    await program.go(2)
    await expect
      .poll(() => readReplies(program.out), { timeout: 15_000 })
      .toEqual({ cpr: 1, da1: 1 })

    await revealPage(orcaPage)
    await setAckGate(orcaPage, null)
    await orcaPage.evaluate((id) => window.api.pty.setPtyDeliveryInterest(id, false), program.ptyId)

    await new Promise((resolve) => setTimeout(resolve, 3_000))
    expect(readReplies(program.out)).toEqual({ cpr: 1, da1: 1 })
  })
})
