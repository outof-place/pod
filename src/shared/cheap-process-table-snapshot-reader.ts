import { runProcess } from './child-process/run-process'
import { getNativeProcessInfo } from './native-process-info'
import {
  CHEAP_PS_ARGS,
  PS_MAX_BUFFER_BYTES,
  ProcessTableCaptureError,
  parseCheapProcessTableRows,
  type CheapProcessTableRow
} from './process-table-snapshot'
import {
  PS_TIMEOUT_MS,
  createProcessTableSnapshotReader,
  withEvidenceBudget
} from './process-table-snapshot-reader'

/**
 * The cheap-tier sibling of the strict evidence reader: same coalescing and TTL, a
 * column set without `tty=`/`command=`. Separate instance because the two column sets
 * parse differently and a cheap capture must never be served to an evidence consumer.
 */
const cheapProcessTableReader = createProcessTableSnapshotReader<CheapProcessTableRow[]>({
  runPs: async () => {
    const native = await readNativeCheapProcessTable()
    if (native) {
      return native
    }
    const result = await runProcess({
      program: 'ps',
      args: CHEAP_PS_ARGS,
      timeoutMs: PS_TIMEOUT_MS,
      maxOutputBytes: PS_MAX_BUFFER_BYTES
    })
    // A ceiling hit is truncation, not absence: name it in the domain vocabulary.
    if (result.outputTruncated) {
      throw new ProcessTableCaptureError('capture_truncated')
    }
    if (result.timedOut) {
      throw new ProcessTableCaptureError('capture_timeout')
    }
    if (result.code !== 0) {
      throw new ProcessTableCaptureError(`ps_exit_${result.code ?? result.signal ?? 'unknown'}`)
    }
    return parseCheapProcessTableRows(result.stdout)
  },
  now: () => Date.now()
})

/** Native worker capture; null retains the ps fallback on unsupported or failed hosts. */
async function readNativeCheapProcessTable(): Promise<CheapProcessTableRow[] | null> {
  const native = getNativeProcessInfo()
  if (!native) {
    return null
  }
  try {
    const rows = (await native.listProcesses()).map(
      ({ pid, ppid, pgid, tpgid, stat, startTime }) => ({
        pid,
        ppid,
        pgid,
        tpgid,
        stat,
        ...(startTime ? { startTime } : {})
      })
    )
    return rows.length > 0 ? rows : null
  } catch {
    return null
  }
}

/** Same wait bound as the evidence read: a stalled cheap capture must fall through to the full
 *  path's own handling rather than pin a polled tick. */
export async function getCheapProcessTableSnapshot(): Promise<CheapProcessTableRow[]> {
  return withEvidenceBudget(cheapProcessTableReader.getSnapshot())
}

export function resetCheapProcessTableSnapshotForTests(): void {
  cheapProcessTableReader.reset()
}
