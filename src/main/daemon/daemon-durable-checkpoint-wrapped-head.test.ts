import { afterEach, describe, expect, it } from 'vitest'
import { buildDurableCheckpointSnapshot } from './daemon-durable-history-snapshot'
import { DAEMON_SESSION_SCROLLBACK_ROWS } from './daemon-session-scrollback-window'
import { HeadlessEmulator } from './headless-emulator'
import type { PendingOutputRecord, TerminalSnapshot } from './types'

// Why this suite: a packaged relaunch lost the first 20 characters of one line of 3000. The pane
// claimed a 20-column grid for a moment, the live window reflowed to it and trimmed rows to its
// 1000, and the trim cut a wrapped line after its first row. Back at full width the live window
// began with the rest of that line, and the checkpoint took its older rows from the replay
// counting from the bottom, so the replay's whole line paired with live's fragment and its head
// went nowhere.

const emulators: HeadlessEmulator[] = []

afterEach(() => {
  for (const emulator of emulators.splice(0)) {
    emulator.dispose()
  }
})

function emulator(opts: { scrollback: number; cols: number; rows: number }): HeadlessEmulator {
  const created = new HeadlessEmulator(opts)
  emulators.push(created)
  return created
}

function write(target: HeadlessEmulator, data: string): void {
  expect(target.writeSync(data)).toBe(true)
}

const BODY = 'abcdefghijklmnopqrstuvwxyz0123456789'

function streamLines(from: number, to: number, body = BODY): string {
  let output = ''
  for (let index = from; index <= to; index += 1) {
    output += `PNLC run ${String(index).padStart(6, '0')} ${body}\r\n`
  }
  return output
}

/** Replays a snapshot the way reattach consumers do and returns its normal-buffer lines, unwrapped. */
function replayedRows(snapshot: TerminalSnapshot): string[] {
  const target = emulator({ scrollback: 20_000, cols: snapshot.cols, rows: snapshot.rows })
  write(target, snapshot.scrollbackAnsi)
  write(target, snapshot.rehydrateSequences)
  write(target, snapshot.snapshotAnsi)
  target.resize(400, snapshot.rows)
  return target.getBufferTailLines(Number.MAX_SAFE_INTEGER)
}

/** The replayed lines are exactly the stream's, in order: none lost, none cut, none repeated. */
function expectStreamLines(snapshot: TerminalSnapshot, last: number, body = BODY): void {
  const lines = replayedRows(snapshot)
    .map((row) => row.trimEnd())
    .filter((row) => row.length > 0)
  expect(lines).toEqual(streamLines(0, last, body).trimEnd().split('\r\n'))
}

/** A live session that writes `last + 1` lines and squeezes its grid once on the way. */
function liveWithSqueeze(opts: {
  squeezeAfter: number
  last: number
  squeeze: { cols: number; rows: number }
  wide?: { cols: number; rows: number }
}): { live: HeadlessEmulator; records: PendingOutputRecord[] } {
  const wide = opts.wide ?? { cols: 113, rows: 43 }
  const live = emulator({ scrollback: DAEMON_SESSION_SCROLLBACK_ROWS, ...wide })
  const records: PendingOutputRecord[] = []
  const output = (data: string): void => {
    write(live, data)
    records.push({ kind: 'output', data })
  }
  const resize = (cols: number, rows: number): void => {
    live.resize(cols, rows)
    records.push({ kind: 'resize', cols, rows })
  }
  output(streamLines(0, opts.squeezeAfter))
  resize(opts.squeeze.cols, opts.squeeze.rows)
  resize(wide.cols, wide.rows)
  output(streamLines(opts.squeezeAfter + 1, opts.last))
  return { live, records }
}

describe('durable checkpoint with a live window that starts inside a wrapped line', () => {
  it('reports the rows live holds of a line it trimmed mid-line', () => {
    const { live } = liveWithSqueeze({
      squeezeAfter: 1495,
      last: 1656,
      squeeze: { cols: 20, rows: 10 }
    })
    expect(live.getSnapshot().leadingWrappedRows).toBe(1)
    expect(live.getSnapshot({ scrollbackRows: 100 }).leadingWrappedRows).toBeUndefined()

    const clean = emulator({ scrollback: DAEMON_SESSION_SCROLLBACK_ROWS, cols: 113, rows: 43 })
    write(clean, streamLines(0, 1656))
    expect(clean.getSnapshot().leadingWrappedRows).toBeUndefined()
  })

  it('keeps every line whole when a squeezed grid trimmed live mid-line', async () => {
    const { live, records } = liveWithSqueeze({
      squeezeAfter: 1495,
      last: 1656,
      squeeze: { cols: 20, rows: 10 }
    })

    const durable = await buildDurableCheckpointSnapshot({
      liveSnapshot: live.getSnapshot(),
      restoreInfo: null,
      pendingRecords: records,
      isFirstTake: true
    })

    expectStreamLines(durable, 1656)
    expect(durable.leadingWrappedRows).toBeUndefined()
  })

  it('keeps a line live trimmed on a later grid whole', async () => {
    // The squeezed rows of the trimmed line reflow to fewer at 40 columns than the replay's.
    const { live, records } = liveWithSqueeze({
      squeezeAfter: 1495,
      last: 1656,
      squeeze: { cols: 20, rows: 10 },
      wide: { cols: 40, rows: 43 }
    })

    const durable = await buildDurableCheckpointSnapshot({
      liveSnapshot: live.getSnapshot(),
      restoreInfo: null,
      pendingRecords: records,
      isFirstTake: true
    })

    expectStreamLines(durable, 1656)
  })

  it('keeps a wrapped line the live window trimmed without a reflow whole, once', async () => {
    // Three rows a line at 113 columns: the window's 1043 rows open on one's last row.
    const long = BODY.repeat(7)
    const live = emulator({ scrollback: DAEMON_SESSION_SCROLLBACK_ROWS, cols: 113, rows: 43 })
    const data = streamLines(0, 1200, long)
    write(live, data)
    const liveSnapshot = live.getSnapshot()
    expect(liveSnapshot.leadingWrappedRows).toBe(1)

    const durable = await buildDurableCheckpointSnapshot({
      liveSnapshot,
      restoreInfo: null,
      pendingRecords: [{ kind: 'output', data }],
      isFirstTake: true
    })

    expectStreamLines(durable, 1200, long)
  })
})
