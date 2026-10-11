import './unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeTerminalDataMeta } from '../orca-runtime'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame
} from '../../../shared/terminal-stream-protocol'
import {
  sendDesktopMultiplexSubscribe,
  startDesktopMultiplexSubscribe
} from './terminal-multiplex-test-harness'

type Snapshot = { data: string; cols: number; rows: number; seq: number }

// A program asks for the cursor position while a viewer attaches: after the stream took reply
// authority from main's model, before its snapshot. The snapshot covers those bytes, so only main
// can still answer them.
function attachWithOutputDuringSnapshot(opts: { modelHeldAuthority: boolean }) {
  let dataListener: ((data: string, meta?: RuntimeTerminalDataMeta) => void) | undefined
  let resolveSnapshot: ((snapshot: Snapshot) => void) | undefined
  const answerTerminalQueriesFromModel = vi.fn()
  const harness = startDesktopMultiplexSubscribe({
    modelAnswersTerminalQueries: vi.fn().mockReturnValue(opts.modelHeldAuthority),
    answerTerminalQueriesFromModel,
    serializeTerminalBuffer: vi.fn(
      () => new Promise<Snapshot>((resolve) => (resolveSnapshot = resolve))
    ),
    subscribeToTerminalData: vi.fn((_ptyId, listener) => {
      dataListener = listener
      return vi.fn()
    })
  })
  return {
    harness,
    answerTerminalQueriesFromModel,
    emit: (data: string, meta: RuntimeTerminalDataMeta) => dataListener?.(data, meta),
    resolveSnapshot: async (snapshot: Snapshot) => {
      await vi.waitFor(() => expect(resolveSnapshot, 'snapshot requested').toBeDefined())
      resolveSnapshot?.(snapshot)
    },
    waitForSubscribe: async () => {
      await vi.waitFor(() => expect(harness.handlers.has(0), 'stream 0 handler').toBe(true))
      sendDesktopMultiplexSubscribe(harness.handlers)
      await vi.waitFor(() => expect(dataListener).toBeDefined())
    },
    waitForSubscribed: () =>
      vi.waitFor(() =>
        expect(
          harness.messages.some((message) => JSON.parse(message).result?.type === 'subscribed'),
          'subscribed'
        ).toBe(true)
      ),
    liveOutputSeqs: () =>
      harness.binaryFrames
        .map(decodeTerminalStreamFrame)
        .filter((frame) => frame?.opcode === TerminalStreamOpcode.Output)
        .map((frame) => frame?.seq),
    close: async () => {
      harness.registry.cleanupSubscription('terminal-multiplex:conn-desktop-first-paint')
      await harness.dispatchPromise
    }
  }
}

describe('terminal multiplex: queries in output the initial snapshot covers', () => {
  it('has main answer them when main held the reply authority the stream took', async () => {
    const attach = attachWithOutputDuringSnapshot({ modelHeldAuthority: true })
    await attach.waitForSubscribe()
    // seq 10..17 lands in the snapshot (seq 20); 20..25 straddles it; 25..30 is after it.
    attach.emit('ok \x1b[6n', { seq: 17, rawLength: 7 })
    attach.emit('ab\x1b]11;?\x07', { seq: 25, rawLength: 5 })
    attach.emit('\x1b[c', { seq: 28, rawLength: 3 })
    await attach.resolveSnapshot({ data: 'snapshot', cols: 120, rows: 40, seq: 20 })
    await attach.waitForSubscribed()

    expect(attach.answerTerminalQueriesFromModel).toHaveBeenCalledTimes(1)
    expect(attach.answerTerminalQueriesFromModel).toHaveBeenCalledWith('pty-1', '\x1b[6n')
    // The straddling OSC 11 and the later DA1 reach the viewer live; it answers those itself.
    await vi.waitFor(() => expect(attach.liveOutputSeqs()).toEqual(expect.arrayContaining([28])))
    await attach.close()
  })

  it('hands them over in the order the output sent them', async () => {
    const attach = attachWithOutputDuringSnapshot({ modelHeldAuthority: true })
    await attach.waitForSubscribe()
    // A cursor-position query, then a color query, then DA1 as the "all replies are in" sentinel.
    attach.emit('\x1b[6n\x1b]11;?\x07\x1b[c', { seq: 18, rawLength: 14 })
    await attach.resolveSnapshot({ data: 'snapshot', cols: 120, rows: 40, seq: 20 })
    await attach.waitForSubscribed()

    expect(attach.answerTerminalQueriesFromModel).toHaveBeenCalledWith(
      'pty-1',
      '\x1b[6n\x1b]11;?\x07\x1b[c'
    )
    await attach.close()
  })

  it('leaves them alone when another view already held the authority', async () => {
    const attach = attachWithOutputDuringSnapshot({ modelHeldAuthority: false })
    await attach.waitForSubscribe()
    attach.emit('ok \x1b[6n', { seq: 17, rawLength: 7 })
    await attach.resolveSnapshot({ data: 'snapshot', cols: 120, rows: 40, seq: 20 })
    await attach.waitForSubscribed()

    expect(attach.answerTerminalQueriesFromModel).not.toHaveBeenCalled()
    await attach.close()
  })

  it('answers nothing when the covered output holds no query', async () => {
    const attach = attachWithOutputDuringSnapshot({ modelHeldAuthority: true })
    await attach.waitForSubscribe()
    attach.emit('plain \x1b[1mbold\x1b[0m', { seq: 19, rawLength: 19 })
    await attach.resolveSnapshot({ data: 'snapshot', cols: 120, rows: 40, seq: 20 })
    await attach.waitForSubscribed()

    expect(attach.answerTerminalQueriesFromModel).not.toHaveBeenCalled()
    await attach.close()
  })
})
