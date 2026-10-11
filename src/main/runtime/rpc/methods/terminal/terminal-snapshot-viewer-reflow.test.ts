import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import { HeadlessEmulator } from '../../../../daemon/headless-emulator'
import { reflowSnapshotForViewer } from './terminal-snapshot-viewer-reflow'

const PROMPT = '% '
// What zsh does on SIGWINCH: back to the start of its prompt line, clear, prompt again.
const PROMPT_REDRAW = `\r\x1b[K${PROMPT}`
// Rows of 110 and 230 cells take one more row each at 100 columns than at 120.
const OUTPUT = `${['short', 'x'.repeat(110), 'z'.repeat(230), 'y'.repeat(90), 'end-of-output'].join('\r\n')}\r\n${PROMPT}`

function write(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve))
}

function rows(term: Terminal): string[] {
  const buffer = term.buffer.active
  const lines: string[] = []
  for (let y = 0; y < buffer.length; y += 1) {
    lines.push(buffer.getLine(y)?.translateToString(true, 0, term.cols) ?? '')
  }
  while (lines.length > 0 && lines.at(-1) === '') {
    lines.pop()
  }
  return lines
}

async function serializedAt120(): Promise<
  NonNullable<Awaited<ReturnType<typeof reflowSnapshotForViewer>>>
> {
  const model = new HeadlessEmulator({ cols: 120, rows: 40 })
  await model.write(OUTPUT)
  const snapshot = model.getSnapshot({ scrollbackRows: 1000 })
  model.dispose()
  return {
    data: (snapshot.scrollbackAnsi ?? '') + snapshot.rehydrateSequences + snapshot.snapshotAnsi,
    cols: snapshot.cols,
    rows: snapshot.rows,
    scrollbackRows: 1000,
    truncatedByByteBudget: false
  }
}

/** A viewer that seeds the snapshot at its own grid, then sees the program's redraw. */
async function seededViewer(data: string): Promise<Terminal> {
  const viewer = new Terminal({ cols: 100, rows: 40, allowProposedApi: true })
  await write(viewer, data)
  await write(viewer, PROMPT_REDRAW)
  return viewer
}

/** A viewer attached from the start: it had the output at 120 columns, then the resize. */
async function referenceViewer(): Promise<Terminal> {
  const reference = new Terminal({ cols: 120, rows: 40, allowProposedApi: true })
  await write(reference, OUTPUT)
  reference.resize(100, 40)
  await write(reference, PROMPT_REDRAW)
  return reference
}

describe('reflowSnapshotForViewer', () => {
  it('leaves a snapshot alone without a viewport or at the same size', async () => {
    const serialized = await serializedAt120()
    expect(await reflowSnapshotForViewer(serialized, undefined)).toBe(serialized)
    expect(await reflowSnapshotForViewer(serialized, { cols: 120, rows: 40 })).toBe(serialized)
    expect(await reflowSnapshotForViewer(null, { cols: 100, rows: 40 })).toBeNull()
  })

  it('keeps every row a narrower viewer seeds, as a viewer attached from the start shows them', async () => {
    const reference = await referenceViewer()
    const serialized = await serializedAt120()
    const reflowed = await reflowSnapshotForViewer(serialized, { cols: 100, rows: 40 })
    expect(reflowed).toMatchObject({ cols: 100, rows: 40 })
    const viewer = await seededViewer(reflowed?.data ?? '')

    expect(rows(viewer)).toEqual(rows(reference))
    expect(rows(viewer).at(-2)).toBe('end-of-output')
    expect(viewer.buffer.active.cursorY).toBe(reference.buffer.active.cursorY)
  })

  it('reproduces the loss without it: the absolute cursor lands rows too high', async () => {
    const reference = await referenceViewer()
    const viewer = await seededViewer((await serializedAt120()).data)
    expect(viewer.buffer.active.cursorY).toBeLessThan(reference.buffer.active.cursorY)
    expect(rows(viewer)).not.toEqual(rows(reference))
  })
})
