import { afterEach, describe, expect, it } from 'vitest'
import { buildDurableCheckpointSnapshot } from './daemon-durable-history-snapshot'
import { DAEMON_RESTORE_SCROLLBACK_ROWS } from './daemon-restore-scrollback-depth'
import { DAEMON_SESSION_SCROLLBACK_ROWS } from './daemon-session-scrollback-window'
import { HeadlessEmulator } from './headless-emulator'
import type { ColdRestoreInfo } from './terminal-history-cold-restore-info'
import type { PendingOutputRecord, TerminalSnapshot } from './types'

// Why this suite: the checkpoint joins the replay's older rows to the live window by counting rows
// from the bottom, and a reflow (a pane that briefly claims a narrow grid) makes live trim a line
// mid-line. Whatever the grids on the way, the checkpoint must hold the stream's last lines in
// order, none cut, lost or repeated (only its oldest line may be a tail the depth cut), and on a
// first take exactly the lines a replay of the same records at the durable depth holds.

const UNWRAP_COLS = 1_000
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

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

const pick = <T>(random: () => number, items: readonly T[]): T =>
  items[Math.floor(random() * items.length)]

const NARROW_COLS = [20, 23, 31, 40, 57] as const
const WIDE_COLS = [40, 80, 113, 160] as const
const NARROW_ROWS = [8, 10] as const
const WIDE_ROWS = [24, 43] as const
const ASCII = 'abcdefghijklmnopqrstuvwxyz0123456789-_=+./'
// Two cells each: a reflow leaves a blank cell where one does not fit at a row's end.
const WIDE_CHARS = ['漢', 'あ', '한'] as const

/** One numbered line of up to `maxCells` cells, wide characters at random places. */
function line(random: () => number, index: number, maxCells: number, wideShare: number): string {
  let text = `L${String(index).padStart(5, '0')} `
  let cells = text.length
  const target = Math.floor(random() * maxCells)
  while (cells < target) {
    if (random() < wideShare && cells + 2 <= maxCells) {
      text += pick(random, WIDE_CHARS)
      cells += 2
    } else {
      text += ASCII[Math.floor(random() * ASCII.length)]
      cells += 1
    }
  }
  return text
}

type Session = {
  live: HeadlessEmulator
  records: PendingOutputRecord[]
  /** Every line written, as an unwrapped row shows it. */
  written: string[]
}

function session(cols: number, rows: number): Session {
  return {
    live: emulator({ scrollback: DAEMON_SESSION_SCROLLBACK_ROWS, cols, rows }),
    records: [],
    written: []
  }
}

function output(s: Session, data: string): void {
  write(s.live, data)
  s.records.push({ kind: 'output', data })
}

function resize(s: Session, cols: number, rows: number): void {
  s.live.resize(cols, rows)
  s.records.push({ kind: 'resize', cols, rows })
}

function writeLine(s: Session, text: string): string {
  s.written.push(text.trimEnd())
  return `${text}\r\n`
}

/** A random stream with squeezes: narrow grids for a moment, then wide again, maybe another. */
function drive(s: Session, random: () => number, opts: { lines: number; wideShare: number }): void {
  const squeezes = 1 + Math.floor(random() * 3)
  const marks = Array.from({ length: squeezes }, () => Math.floor(random() * opts.lines)).sort(
    (a, b) => a - b
  )
  const maxCells = 3 * pick(random, WIDE_COLS)
  let chunk = ''
  for (let i = 0; i < opts.lines; i += 1) {
    chunk += writeLine(
      s,
      line(random, s.written.length, Math.min(maxCells, UNWRAP_COLS - 10), opts.wideShare)
    )
    while (marks.length > 0 && marks[0] === i) {
      marks.shift()
      output(s, chunk)
      chunk = ''
      resize(s, pick(random, NARROW_COLS), pick(random, NARROW_ROWS))
      if (random() < 0.3) {
        resize(s, pick(random, NARROW_COLS), pick(random, NARROW_ROWS))
      }
      resize(s, pick(random, WIDE_COLS), pick(random, WIDE_ROWS))
    }
  }
  output(s, chunk)
}

function unwrapped(target: HeadlessEmulator, rows: number): string[] {
  target.resize(UNWRAP_COLS, rows)
  return target
    .getBufferTailLines(Number.MAX_SAFE_INTEGER)
    .map((row) => row.trimEnd())
    .filter((row) => row.length > 0)
}

/** Replays a snapshot the way reattach consumers do and returns its normal-buffer lines, unwrapped. */
function replayedLines(snapshot: TerminalSnapshot): string[] {
  const target = emulator({ scrollback: 50_000, cols: snapshot.cols, rows: snapshot.rows })
  write(target, snapshot.scrollbackAnsi)
  write(target, snapshot.rehydrateSequences)
  write(target, snapshot.snapshotAnsi)
  if (snapshot.modes.alternateScreen) {
    expect(target.getBufferTailLines(snapshot.rows).join('\n')).toContain(ALT_FRAME)
    write(target, '\x1b[?1049l')
  }
  return unwrapped(target, snapshot.rows)
}

/** What durable history alone restores on a first take: every record, replayed at live's grid. */
function referenceLines(s: Session): string[] {
  const { cols, rows } = s.live.getAppliedSize()
  const reference = emulator({ scrollback: DAEMON_RESTORE_SCROLLBACK_ROWS, cols, rows })
  for (const record of s.records) {
    if (record.kind === 'output') {
      write(reference, record.data)
    } else if (record.kind === 'resize') {
      reference.resize(record.cols, record.rows)
    }
  }
  if (s.live.getSnapshot().modes.alternateScreen) {
    write(reference, '\x1b[?1049l')
  }
  return unwrapped(reference, rows)
}

/** The stream's last lines in order; only the oldest may be a tail of its line. */
function streamTailDifference(lines: string[], written: string[]): string | null {
  if (lines.length > written.length) {
    return `${lines.length} lines for ${written.length} written, ${firstDifference(lines, written)}`
  }
  const whole = written.slice(written.length - lines.length)
  if (lines.length > 1 && lines[0] !== whole[0] && whole[0]?.endsWith(lines[0])) {
    return firstDifference(lines.slice(1), whole.slice(1))
  }
  return firstDifference(lines, whole)
}

function restoreInfoFrom(snapshot: TerminalSnapshot): ColdRestoreInfo {
  return { ...snapshot, cwd: snapshot.cwd ?? '/tmp' }
}

/** The first difference, so a failure names the line instead of dumping thousands. */
function firstDifference(actual: string[], expected: string[]): string | null {
  const length = Math.max(actual.length, expected.length)
  for (let i = 0; i < length; i += 1) {
    if (actual[i] !== expected[i]) {
      const got = actual[i] ?? ''
      const want = expected[i] ?? ''
      let at = 0
      while (at < got.length && got[at] === want[at]) {
        at += 1
      }
      const window = (text: string): string =>
        JSON.stringify(text.slice(Math.max(0, at - 20), at + 40))
      return `line ${i} of ${expected.length}, char ${at}: got ${window(got)}, want ${window(want)}`
    }
  }
  return null
}

const ALT_FRAME = 'ALT_TUI_FRAME'
const SEEDS = Array.from({ length: 16 }, (_, i) => 20_261_012 + i)

describe('durable checkpoint across reflows, differential against the durable replay', () => {
  it('trims live mid-line for most seeds, so the rebase path runs', () => {
    const trimmed = SEEDS.filter((seed) => {
      const random = mulberry32(seed)
      const s = session(pick(random, WIDE_COLS), pick(random, WIDE_ROWS))
      drive(s, random, { lines: 1_100 + Math.floor(random() * 900), wideShare: random() * 0.3 })
      return (s.live.getSnapshot().leadingWrappedRows ?? 0) > 0
    })
    expect(trimmed.length).toBeGreaterThanOrEqual(SEEDS.length / 2)
  })

  it.each(SEEDS)('first take, seed %i', async (seed) => {
    const random = mulberry32(seed)
    const s = session(pick(random, WIDE_COLS), pick(random, WIDE_ROWS))
    drive(s, random, { lines: 1_100 + Math.floor(random() * 900), wideShare: random() * 0.3 })

    const durable = await buildDurableCheckpointSnapshot({
      liveSnapshot: s.live.getSnapshot(),
      restoreInfo: null,
      pendingRecords: s.records,
      isFirstTake: true
    })

    const lines = replayedLines(durable)
    expect(streamTailDifference(lines, s.written)).toBeNull()
    expect(firstDifference(lines, referenceLines(s))).toBeNull()
  })

  it.each(SEEDS.slice(0, 6))('a TUI on the alternate screen, seed %i', async (seed) => {
    const random = mulberry32(seed ^ 0xa17)
    const s = session(pick(random, WIDE_COLS), pick(random, WIDE_ROWS))
    drive(s, random, { lines: 1_100 + Math.floor(random() * 900), wideShare: random() * 0.3 })
    output(s, `\x1b[?1049h\x1b[H${ALT_FRAME}`)

    const durable = await buildDurableCheckpointSnapshot({
      liveSnapshot: s.live.getSnapshot(),
      restoreInfo: null,
      pendingRecords: s.records,
      isFirstTake: true
    })

    expect(durable.modes.alternateScreen).toBe(true)
    const lines = replayedLines(durable)
    expect(streamTailDifference(lines, s.written)).toBeNull()
    expect(firstDifference(lines, referenceLines(s))).toBeNull()
  })

  it.each(SEEDS.slice(0, 8))('a checkpoint folded on its predecessor, seed %i', async (seed) => {
    const random = mulberry32(seed ^ 0x5eed)
    const s = session(pick(random, WIDE_COLS), pick(random, WIDE_ROWS))
    drive(s, random, { lines: 900 + Math.floor(random() * 600), wideShare: random() * 0.3 })
    const first = await buildDurableCheckpointSnapshot({
      liveSnapshot: s.live.getSnapshot(),
      restoreInfo: null,
      pendingRecords: s.records,
      isFirstTake: true
    })
    s.records = []
    drive(s, random, { lines: 600 + Math.floor(random() * 600), wideShare: random() * 0.3 })

    const durable = await buildDurableCheckpointSnapshot({
      liveSnapshot: s.live.getSnapshot(),
      restoreInfo: restoreInfoFrom(first),
      pendingRecords: s.records,
      isFirstTake: false
    })

    const lines = replayedLines(durable)
    expect(streamTailDifference(lines, s.written)).toBeNull()
    expect(lines.length).toBeGreaterThan(DAEMON_SESSION_SCROLLBACK_ROWS / 3)
  })

  it.each([23, 31, 57])('lines of wide characters only, squeezed to %i columns', async (cols) => {
    const random = mulberry32(cols)
    const s = session(113, 43)
    let data = ''
    for (let i = 0; i < 1_300; i += 1) {
      data += writeLine(
        s,
        `L${String(i).padStart(5, '0')} ${'漢あ'.repeat(10 + Math.floor(random() * 50))}`
      )
      if (i === 1_150) {
        output(s, data)
        data = ''
        resize(s, cols, 8)
        resize(s, 113, 43)
      }
    }
    output(s, data)

    const durable = await buildDurableCheckpointSnapshot({
      liveSnapshot: s.live.getSnapshot(),
      restoreInfo: null,
      pendingRecords: s.records,
      isFirstTake: true
    })

    const lines = replayedLines(durable)
    expect(streamTailDifference(lines, s.written)).toBeNull()
    expect(firstDifference(lines, referenceLines(s))).toBeNull()
  })
})
