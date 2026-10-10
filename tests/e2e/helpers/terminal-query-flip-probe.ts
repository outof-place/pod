// Counts the replies a program in a pane gets to one queued CPR and one DA1, while the test
// holds the renderer's delivery credit so the query stays queued in main across a flip.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect } from './orca-app'
import { execInTerminal } from './terminal'

const PROGRAM = `
const fs = require('fs')
const [out, ready, go1, stop1, sent1, go2, sent2] = process.argv.slice(2)
let replies = ''
const record = () => fs.writeFileSync(out, JSON.stringify({
  cpr: (replies.match(/\\x1b\\[\\d+;\\d+R/g) || []).length,
  da1: (replies.match(/\\x1b\\[\\?[\\d;]*c/g) || []).length
}))
process.stdin.setRawMode(true)
process.stdin.on('data', (data) => { replies += data.toString('latin1'); record() })
record()
const whenExists = (file) => new Promise((resolve) => {
  const wait = setInterval(() => { if (fs.existsSync(file)) { clearInterval(wait); resolve() } }, 20)
})
// Paced filler while stop1 is absent: slow enough that the queue behind the held window
// stays far below the size at which main pauses the PTY. sent1 marks each idle period.
let idle = false
const fill = () => {
  if (fs.existsSync(stop1)) {
    if (!idle) fs.writeFileSync(sent1, '1')
    idle = true
    setTimeout(fill, 20)
    return
  }
  idle = false
  process.stdout.write(('x'.repeat(99) + '\\n').repeat(80), () => setTimeout(fill, 20))
}
fs.writeFileSync(ready, '1')
whenExists(go1).then(fill)
whenExists(go2).then(() => process.stdout.write('query:\\x1b[6n\\x1b[c\\n', () => {
  fs.writeFileSync(sent2, '1')
  setTimeout(() => process.exit(0), 120000)
}))
`

type Replies = { cpr: number; da1: number }

async function waitForFile(file: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(file)) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${file}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

export function readReplies(file: string): Replies {
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'cpr' in parsed &&
    typeof parsed.cpr === 'number' &&
    'da1' in parsed &&
    typeof parsed.da1 === 'number'
  ) {
    return { cpr: parsed.cpr, da1: parsed.da1 }
  }
  throw new Error(`unreadable reply counts in ${file}`)
}

async function gatedPtyCount(page: Page): Promise<number> {
  return (await page.evaluate(() => window.api.pty.getRendererDeliveryDebugSnapshot()))
    .hiddenDeliveryGatedPtyCount
}

/** Hides the page the way terminal-stuck-occlusion-recovery does; returns the gated count
 *  before, which revealPage waits to return to. */
export async function hidePage(page: Page): Promise<number> {
  const before = await gatedPtyCount(page)
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect.poll(() => gatedPtyCount(page), { timeout: 15_000 }).toBeGreaterThan(before)
  return before
}

export async function revealPage(page: Page, gatedBefore = 0): Promise<void> {
  await page.evaluate(() => {
    // Drop the instance shadow so the prototype getter (real state) rules again.
    Reflect.deleteProperty(document, 'visibilityState')
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect.poll(() => gatedPtyCount(page), { timeout: 15_000 }).toBe(gatedBefore)
}

export async function setAckGate(page: Page, ptyId: string | null): Promise<void> {
  await page.evaluate((id) => {
    const gate: unknown = Reflect.get(window, '__terminalPtyAckGate')
    const method = id ? 'hold' : 'release'
    const call: unknown = typeof gate === 'object' && gate ? Reflect.get(gate, method) : null
    if (typeof gate !== 'object' || !gate || typeof call !== 'function') {
      throw new Error('terminal PTY ACK gate is unavailable')
    }
    Reflect.apply(call, gate, id ? [[id]] : [])
  }, ptyId)
}

// Queued behind the held window, not just batched: the window is full and bytes still wait.
async function isOutputQueuedBehindWindow(page: Page): Promise<boolean> {
  const debug = await page.evaluate(() => window.api.pty.getRendererDeliveryDebugSnapshot())
  return debug.pendingChars > 0 && debug.maxRendererInFlightCharsByPty >= 512 * 1024
}

/** Starts the probe in `ptyId`'s pane. Phase 1 fills main's queue behind the held window;
 *  phase 2 queues one CPR and one DA1 behind it. */
export async function startQueryFlipProgram(
  page: Page,
  ptyId: string
): Promise<{
  out: string
  go: (phase: 1 | 2) => Promise<void>
}> {
  const dir = mkdtempSync(path.join(tmpdir(), 'orca-query-flip-'))
  const file = (name: string): string => path.join(dir, name)
  writeFileSync(file('program.cjs'), PROGRAM)
  const args = ['out', 'ready', 'go1', 'stop1', 'sent1', 'go2', 'sent2'].map(file).join(' ')
  await execInTerminal(page, ptyId, `node ${file('program.cjs')} ${args}`)
  await waitForFile(file('ready'), 30_000)
  return {
    out: file('out'),
    go: async (phase) => {
      writeFileSync(file(`go${phase}`), '1')
      // An active pane's window is larger, so batching can look queued: stop, then confirm.
      for (let attempt = 0; phase === 1 && attempt < 10; attempt++) {
        await expect
          .poll(() => isOutputQueuedBehindWindow(page), { intervals: [50], timeout: 30_000 })
          .toBe(true)
        writeFileSync(file('stop1'), '1')
        await waitForFile(file('sent1'), 30_000)
        await new Promise((resolve) => setTimeout(resolve, 300))
        if (await isOutputQueuedBehindWindow(page)) {
          return
        }
        rmSync(file('sent1'))
        rmSync(file('stop1'))
      }
      if (phase === 2) {
        await waitForFile(file('sent2'), 30_000)
        await new Promise((resolve) => setTimeout(resolve, 300))
      }
      expect(await isOutputQueuedBehindWindow(page)).toBe(true)
    }
  }
}
