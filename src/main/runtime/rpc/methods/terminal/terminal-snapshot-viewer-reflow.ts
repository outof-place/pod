// Fork-only (Pod): a desktop viewer seeds the attach snapshot at its own grid, so the snapshot is
// rewrapped to that grid first. It is serialized at the PTY's size with an absolute cursor, and
// written into a narrower grid its soft-wrapped rows take more rows while the cursor lands where the
// PTY had it: the prompt the program redraws after the resize then overwrites the last rows.
import { HeadlessEmulator } from '../../../../daemon/headless-emulator'
import type { SerializedSnapshot } from './terminal-stream-types'

export async function reflowSnapshotForViewer(
  serialized: SerializedSnapshot,
  viewport: { cols: number; rows: number } | undefined
): Promise<SerializedSnapshot> {
  if (
    !serialized ||
    !viewport ||
    viewport.cols < 2 ||
    viewport.rows < 2 ||
    (viewport.cols === serialized.cols && viewport.rows === serialized.rows)
  ) {
    return serialized
  }
  const emulator = new HeadlessEmulator({
    cols: serialized.cols,
    rows: serialized.rows,
    scrollback: Math.max(serialized.scrollbackRows, 0)
  })
  try {
    await emulator.write(serialized.data)
    emulator.resize(viewport.cols, viewport.rows)
    const snapshot = emulator.getSnapshot({ scrollbackRows: serialized.scrollbackRows })
    return {
      ...serialized,
      data: (snapshot.scrollbackAnsi ?? '') + snapshot.rehydrateSequences + snapshot.snapshotAnsi,
      cols: snapshot.cols,
      rows: snapshot.rows,
      oscLinks: snapshot.oscLinks
    }
  } finally {
    emulator.dispose()
  }
}
