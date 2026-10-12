// Fork-only (Pod): when startup fell back to local PTYs, keep trying the daemon in the background so
// fresh terminals become persistent again; the ones spawned meanwhile stay on the local provider.
import type { DaemonProviderInitOptions } from './daemon-provider-init'

export const LATE_DAEMON_START_DELAYS_MS = [5_000, 30_000, 120_000]

export type LateDaemonStart = {
  /** One daemon init in late mode; rejects when the daemon still can't start. */
  start: () => Promise<void>
  hasDaemon: () => boolean
  isQuitting: () => boolean
  delaysMs?: readonly number[]
}

let scheduled = false

/** Once per process; each failed attempt waits for the next delay. */
export function scheduleLateDaemonStart({
  start,
  hasDaemon,
  isQuitting,
  delaysMs = LATE_DAEMON_START_DELAYS_MS
}: LateDaemonStart): void {
  if (scheduled) {
    return
  }
  scheduled = true
  const attempt = (index: number): void => {
    if (index >= delaysMs.length) {
      console.warn('[daemon] late start gave up; fresh terminals stay local until Pod restarts')
      return
    }
    const timer = setTimeout(() => {
      if (isQuitting() || hasDaemon()) {
        return
      }
      start().then(
        () => {
          if (hasDaemon()) {
            console.info('[daemon] started late; fresh terminals are daemon-backed')
          }
        },
        (error: unknown) => {
          const reason = error instanceof Error ? error.message : String(error)
          console.warn(`[daemon] late start attempt ${index + 1} failed: ${reason}`)
          attempt(index + 1)
        }
      )
    }, delaysMs[index])
    timer.unref?.()
  }
  attempt(0)
}

export function resetLateDaemonStartForTests(): void {
  scheduled = false
}

/** macOS only: where a fresh clone's first exec can outlast the startup gate. */
export function scheduleLateDaemonStartOnDarwin(
  init: (options: DaemonProviderInitOptions) => Promise<void>,
  options: DaemonProviderInitOptions,
  hasDaemon: () => boolean,
  platform: NodeJS.Platform = process.platform
): void {
  if (platform !== 'darwin') {
    return
  }
  scheduleLateDaemonStart({
    start: () => init({ ...options, late: true }),
    hasDaemon,
    isQuitting: options.isQuitting ?? (() => false)
  })
}
