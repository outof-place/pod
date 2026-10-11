import './unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson,
  decodeTerminalStreamText,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson
} from '../../../shared/terminal-stream-protocol'
import { HeadlessEmulator } from '../../daemon/headless-emulator'
import { startDesktopMultiplexSubscribe } from './terminal-multiplex-test-harness'

// Lines that wrap at 120 and more at 100, with the prompt mid-screen (where the cursor matters).
const OUTPUT = Array.from({ length: 12 }, (_, index) =>
  index % 3 === 0 ? `${index} ${'w'.repeat(150)}` : `${index} line`
).join('\r\n')

async function snapshotAt120(): Promise<{ data: string; cols: number; rows: number }> {
  const model = new HeadlessEmulator({ cols: 120, rows: 40 })
  await model.write(`${'x'.repeat(110)}\r\n${OUTPUT}\r\n% `)
  const snapshot = model.getSnapshot({ scrollbackRows: 1000 })
  model.dispose()
  return {
    data: (snapshot.scrollbackAnsi ?? '') + snapshot.rehydrateSequences + snapshot.snapshotAnsi,
    cols: snapshot.cols,
    rows: snapshot.rows
  }
}

/** The rows a terminal holds, without the blank ones after the last line. */
function rowsOf(emulator: HeadlessEmulator): string[] {
  const rows = emulator.getBufferTailLines(10_000).map((row) => row.trimEnd())
  while (rows.length > 0 && rows.at(-1) === '') {
    rows.pop()
  }
  return rows
}

async function subscribedSnapshotSize(
  viewport: { cols: number; rows: number } | undefined,
  clientType: 'desktop' | 'mobile' = 'desktop'
): Promise<{
  subscribed: { cols: number; rows: number }
  start: { cols: number; rows: number }
  data: string
  serialized: { data: string }
}> {
  const serialized = await snapshotAt120()
  const harness = startDesktopMultiplexSubscribe({
    serializeTerminalBuffer: vi.fn().mockResolvedValue(serialized),
    handleMobileSubscribe: vi.fn().mockResolvedValue(undefined)
  })
  await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))
  const subscribe = decodeTerminalStreamFrame(
    encodeTerminalStreamFrame({
      opcode: TerminalStreamOpcode.Subscribe,
      streamId: 0,
      seq: 1,
      payload: encodeTerminalStreamJson({
        streamId: 7,
        terminal: 'terminal-1',
        client: { id: 'viewer-1', type: clientType },
        capabilities: { ackOutput: 1, desktopViewportClaims: 1 },
        ...(viewport ? { viewport } : {})
      })
    })
  )
  if (subscribe) {
    harness.handlers.get(0)?.(subscribe)
  }
  const startFrame = await vi.waitFor(() => {
    const frame = harness.binaryFrames
      .map(decodeTerminalStreamFrame)
      .find((candidate) => candidate?.opcode === TerminalStreamOpcode.SnapshotStart)
    expect(frame).toBeDefined()
    return frame
  })
  await vi.waitFor(() =>
    expect(
      harness.binaryFrames
        .map(decodeTerminalStreamFrame)
        .some((candidate) => candidate?.opcode === TerminalStreamOpcode.SnapshotEnd)
    ).toBe(true)
  )
  const data = harness.binaryFrames
    .map(decodeTerminalStreamFrame)
    .filter((frame) => frame?.opcode === TerminalStreamOpcode.SnapshotChunk)
    .map((frame) => decodeTerminalStreamText(frame?.payload ?? new Uint8Array()))
    .join('')
  const subscribed = harness.messages
    .map((message) => JSON.parse(message).result)
    .find((event) => event?.type === 'subscribed')
  harness.registry.cleanupSubscription('terminal-multiplex:conn-desktop-first-paint')
  return {
    subscribed,
    start: decodeTerminalStreamJson(startFrame?.payload ?? new Uint8Array()) ?? {
      cols: 0,
      rows: 0
    },
    data,
    serialized
  }
}

describe('multiplex attach snapshot for a viewer of another size', () => {
  it('rewraps the snapshot to the grid a desktop viewer seeds it at', async () => {
    const { subscribed, start } = await subscribedSnapshotSize({ cols: 100, rows: 30 })
    expect(start).toMatchObject({ cols: 100, rows: 30 })
    expect(subscribed.cols).toBe(100)
  })

  it('keeps the PTY-sized snapshot for a viewer of that size and for mobile', async () => {
    expect((await subscribedSnapshotSize({ cols: 120, rows: 40 })).start).toMatchObject({
      cols: 120,
      rows: 40
    })
    expect((await subscribedSnapshotSize({ cols: 100, rows: 30 }, 'mobile')).start).toMatchObject({
      cols: 120
    })
  })

  it('keeps what an older client gets: no viewport means the PTY image, mobile gets it byte for byte', async () => {
    const noViewport = await subscribedSnapshotSize(undefined)
    expect(noViewport.start).toMatchObject({ cols: 120, rows: 40 })
    expect(noViewport.subscribed).toMatchObject({ cols: 120, rows: 40 })
    expect(noViewport.data).toBe(noViewport.serialized.data)
    const mobile = await subscribedSnapshotSize({ cols: 100, rows: 30 }, 'mobile')
    expect(mobile.start).toMatchObject({ cols: 120, rows: 40 })
    expect(mobile.subscribed).toMatchObject({ cols: 120, rows: 40 })
    expect(mobile.data).toBe(mobile.serialized.data)
  })

  it("gives a client that replays at SnapshotStart's grid and one that seeds at its own the same rows", async () => {
    const view = { cols: 100, rows: 30 }
    const reference = new HeadlessEmulator({ cols: 120, rows: 40 })
    await reference.write((await snapshotAt120()).data)
    reference.resize(view.cols, view.rows)
    const { start, data } = await subscribedSnapshotSize(view)
    // Pod's renderer restore (snapshotCols/snapshotRows): the image at its own grid, then the pane's.
    const replaysAtStart = new HeadlessEmulator({ cols: start.cols, rows: start.rows })
    await replaysAtStart.write(data)
    replaysAtStart.resize(view.cols, view.rows)
    // PodNative: the image straight into its grid.
    const seedsAtOwn = new HeadlessEmulator(view)
    await seedsAtOwn.write(data)
    // An older runtime's PTY-sized image through the renderer restore, for comparison.
    const before = new HeadlessEmulator({ cols: 120, rows: 40 })
    await before.write((await snapshotAt120()).data)
    before.resize(view.cols, view.rows)
    // The shell redraws its prompt at the cursor after the resize; a misplaced cursor overwrites a row.
    for (const emulator of [reference, replaysAtStart, seedsAtOwn, before]) {
      await emulator.write('\r\x1b[K% redrawn')
    }
    try {
      expect(rowsOf(replaysAtStart)).toEqual(rowsOf(reference))
      expect(rowsOf(seedsAtOwn)).toEqual(rowsOf(reference))
      expect(rowsOf(before)).toEqual(rowsOf(reference))
      expect(seedsAtOwn.getVisibleLines()).toEqual(reference.getVisibleLines())
    } finally {
      for (const emulator of [reference, replaysAtStart, seedsAtOwn, before]) {
        emulator.dispose()
      }
    }
  })
})
