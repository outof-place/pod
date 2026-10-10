import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { readMigrationMarker, updateMigrationMarker } from './deferred-profile-import'
import { defaultIsProcessAlive, isMovedDaemon, type MovedDaemon } from './legacy-daemon-handover'

// Watches the daemons moved from the legacy app. One that dies while it still holds terminals took
// them along, and nothing in the product caused it: the marker records it and the user is told.

export type DaemonLoss = { protocol: number; pid: number; at: string; reason: string | null }

// Why these are not losses: an idle daemon ran out of terminals; an RPC shutdown came from an app.
// A signal or a crash took live terminals (SIGKILL logs no line at all).
const EXPECTED_SHUTDOWNS = new Set(['idle', 'rpc'])
const LOG_TAIL_BYTES = 256 * 1024
const DEFAULT_INTERVAL_MS = 10_000

function readTail(path: string): string {
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    const size = fstatSync(fd).size
    const length = Math.min(size, LOG_TAIL_BYTES)
    const buffer = Buffer.alloc(length)
    readSync(fd, buffer, 0, length, size - length)
    return buffer.toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd !== null) {
      closeSync(fd)
    }
  }
}

/** The last shutdown reason `pid` wrote to its NDJSON log (or the rotated copy); null for none. */
export function readDaemonShutdownReason(logPath: string, pid: number): string | null {
  for (const path of [logPath, `${logPath}.1`]) {
    const lines = readTail(path).split('\n').toReversed()
    for (const line of lines) {
      try {
        const entry: unknown = JSON.parse(line)
        const field = (key: string): unknown => Reflect.get(Object(entry), key)
        const reason = field('reason')
        if (field('pid') === pid && field('event') === 'shutdown' && typeof reason === 'string') {
          return reason
        }
      } catch {
        // A torn first line of the tail, or not JSON.
      }
    }
  }
  return null
}

function settledPids(handover: unknown): Set<number> {
  const pids = new Set<number>()
  for (const key of ['lost', 'ended']) {
    const list: unknown = Reflect.get(Object(handover), key)
    for (const entry of Array.isArray(list) ? list : []) {
      const pid: unknown = Reflect.get(Object(entry), 'pid')
      if (typeof pid === 'number') {
        pids.add(pid)
      }
    }
  }
  return pids
}

/**
 * Settles each moved daemon once it is gone: `daemonHandover.lost` when it died holding terminals,
 * `ended` when it ran out of them. Polls while any is alive; returns a stop function.
 */
export function watchMovedDaemons(options: {
  userData: string
  onLost: (loss: DaemonLoss) => void
  isAlive?: (pid: number) => boolean
  /** The moved daemons' log; defaults to the legacy app's. */
  logPath?: string
  intervalMs?: number
}): () => void {
  const isAlive = options.isAlive ?? defaultIsProcessAlive
  const marker = readMigrationMarker(options.userData)
  const handover: unknown = marker?.daemonHandover
  const from = marker?.from
  const moved: unknown = Reflect.get(Object(handover), 'moved')
  if (typeof from !== 'string' || !Array.isArray(moved)) {
    return () => {}
  }
  const logPath = options.logPath ?? join(from, 'logs', 'daemon.log')
  const settled = settledPids(handover)
  let watched: MovedDaemon[] = moved.filter(isMovedDaemon).filter(({ pid }) => !settled.has(pid))

  const settle = (daemon: MovedDaemon): void => {
    const reason = readDaemonShutdownReason(logPath, daemon.pid)
    const entry = {
      protocol: daemon.protocol,
      pid: daemon.pid,
      at: new Date().toISOString(),
      reason
    }
    const key = reason !== null && EXPECTED_SHUTDOWNS.has(reason) ? 'ended' : 'lost'
    const current: unknown = readMigrationMarker(options.userData)?.daemonHandover
    const previous: unknown = Reflect.get(Object(current), key)
    updateMigrationMarker(options.userData, {
      daemonHandover: {
        ...Object(current),
        [key]: [...(Array.isArray(previous) ? previous : []), entry]
      }
    })
    if (key === 'lost') {
      console.warn(`[product-migration] moved daemon lost ${JSON.stringify(entry)}`)
      options.onLost(entry)
    }
  }

  let timer: ReturnType<typeof setInterval> | null = null
  const stop = (): void => {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }
  const check = (): void => {
    const gone = watched.filter(({ pid }) => !isAlive(pid))
    watched = watched.filter((daemon) => !gone.includes(daemon))
    for (const daemon of gone) {
      try {
        settle(daemon)
      } catch (error) {
        console.warn('[product-migration] could not record a moved daemon', error)
      }
    }
    if (watched.length === 0) {
      stop()
    }
  }
  check()
  if (watched.length > 0) {
    timer = setInterval(check, options.intervalMs ?? DEFAULT_INTERVAL_MS)
  }
  return stop
}
