// Fork-only (Pod): a terminal's foreground process group, read now and synchronously, for a guarded
// write's fence (pod-terminal-foreground-fence.ts). Native proc-info (sysctl, the tty pinned by its
// device) in every build; only a development build without the addon falls back to one /bin/ps under
// LC_ALL=C. A packaged build without the addon, a failed read, a root that's gone, a root on another
// terminal, or no foreground group all refuse.
import { runProcessSync } from '@orca/process-host'
import { getAppEnvironment, hasAppEnvironment } from '../../../shared/app-environment'
import { getNativeProcessInfo } from '../../../shared/native-process-info'

export type ForegroundGroupRefusal =
  | 'reader_unavailable'
  | 'read_failed'
  | 'root_gone'
  | 'other_tty'
  | 'no_foreground_group'

export type ForegroundGroupRead =
  | { ok: true; group: number }
  | { ok: false; reason: ForegroundGroupRefusal }

const PS_TIMEOUT_MS = 250
const PS_MAX_OUTPUT_BYTES = 64 * 1024

function ttyName(tty: string): string {
  return tty.replace(/^\/dev\//, '')
}

function fromRow(row: { tpgid: number; tty: string } | null, tty: string): ForegroundGroupRead {
  if (!row) {
    return { ok: false, reason: 'root_gone' }
  }
  if (ttyName(row.tty) !== ttyName(tty)) {
    return { ok: false, reason: 'other_tty' }
  }
  // tpgid is -1 or 0 when no group owns the terminal, and pid 1 is never one.
  return row.tpgid > 1
    ? { ok: true, group: row.tpgid }
    : { ok: false, reason: 'no_foreground_group' }
}

function isDevelopmentBuild(): boolean {
  return hasAppEnvironment() && !getAppEnvironment().isPackaged()
}

function readWithPs(rootPid: number, tty: string): ForegroundGroupRead {
  const result = runProcessSync({
    program: '/bin/ps',
    args: ['-p', String(rootPid), '-o', 'pid=,tpgid=,tty='],
    env: { LC_ALL: 'C' },
    timeoutMs: PS_TIMEOUT_MS,
    maxOutputBytes: PS_MAX_OUTPUT_BYTES
  })
  // `ps -p` exits 1 for a pid it can't find: as a throwing read did, that is a failed read.
  if (result.code !== 0 || result.timedOut) {
    return { ok: false, reason: 'read_failed' }
  }
  const match = /^\s*\d+\s+(-?\d+)\s+(\S+)/m.exec(result.stdout)
  return fromRow(match ? { tpgid: Number(match[1]), tty: match[2] ?? '' } : null, tty)
}

export function readTerminalForegroundGroupNow(rootPid: number, tty: string): ForegroundGroupRead {
  try {
    const native = getNativeProcessInfo()
    if (native) {
      return fromRow(native.readProcessForegroundGroup(rootPid, tty), tty)
    }
    return isDevelopmentBuild()
      ? readWithPs(rootPid, tty)
      : { ok: false, reason: 'reader_unavailable' }
  } catch {
    return { ok: false, reason: 'read_failed' }
  }
}
