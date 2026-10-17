// Fork-only (Pod): what a build's log says while it runs and after. Progress counts the `› ` lines
// expo run:ios prints per step (`› Compiling react-native-screens`, about 1,700 for Portivo's mobile
// client) against the last good build of the same bundle id, read incrementally; the phase is the
// latest of them, `pod install`, or claude-acc's scheduler holding it for memory (`[sched]` lines
// before its start line). A failure is answered with the log's last lines.
import { open } from 'node:fs/promises'
import { SIM_BUILD_WAITING_FOR_MEMORY, type SimBuildRecord } from './sim-app-build-records'

const TAIL_BYTES = 16 * 1024
const READ_MAX = 4 * 1024 * 1024
// ANSI colour escapes in build output.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g')

function lines(text: string): string[] {
  return text
    .replace(ANSI, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '')
}

/** The log's last non-empty lines, escapes stripped. */
export async function readSimBuildTail(path: string): Promise<string[]> {
  try {
    const handle = await open(path, 'r')
    try {
      const size = (await handle.stat()).size
      const length = Math.min(size, TAIL_BYTES)
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, size - length)
      return lines(buffer.toString('utf8'))
    } finally {
      await handle.close()
    }
  } catch {
    return []
  }
}

// claude-acc's scheduler taking a waiting build off its queue (sched.py: `sched cancel` ends it
// 130, its own `--timeout` 75), in its own words.
const SCHED_DEQUEUED = /^\[sched\] (anulowane po |timeout \d+s w kolejce)/

// The exit codes of a build its scheduler or the memory brake signalled.
const STOPPED_BY_SIGNAL: ReadonlyMap<number, string> = new Map([
  [130, 'it was interrupted (exit 130), as claude-acc sched cancel does'],
  [137, "it was killed (exit 137, SIGKILL), as claude-acc's memory brake does"],
  [143, "it was terminated (exit 143, SIGTERM), as claude-acc's memory brake and sched cancel do"]
])

/**
 * Why something stopped a build that did not end by itself (claude-acc's cancel or memory brake),
 * or null for a build that failed: `exit` is its wrapper's record, `none` when the wrapper was
 * killed with it.
 */
export function simBuildStopReason(
  exit: number | null | 'none',
  lines: readonly string[]
): string | null {
  const sched = lines.findLast((line) => SCHED_DEQUEUED.test(line))
  if (sched) {
    return `claude-acc's scheduler took it off its queue (${sched.slice(0, 200)})`
  }
  if (exit === 'none') {
    return "it was killed with its whole process group, as claude-acc's memory brake does"
  }
  return typeof exit === 'number' ? (STOPPED_BY_SIGNAL.get(exit) ?? null) : null
}

// claude-acc's line once a job leaves its queue: `start po 2m54s czekania, local` (sched.py human_s:
// 12s, 3m, 2m54s, 1h05m).
const SCHED_STARTED = /^\[sched\] start po (?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)? czekania/

/** `queuedMs`: how long claude-acc's queue held the build before it started. */
export type SimBuildProgress = {
  offset: number
  steps: number
  phase?: string
  queuedMs?: number
}

export type SimBuildProgressReader = {
  /** Reads the log's new whole lines since the last call for this build. */
  advance(build: Pick<SimBuildRecord, 'buildId' | 'logPath'>): Promise<SimBuildProgress>
  forget(buildId: string): void
}

export function createSimBuildProgress(): SimBuildProgressReader {
  const seen = new Map<string, SimBuildProgress>()
  return {
    async advance(build) {
      // A copy: two overlapping reads (a snapshot during a reconcile) must not both count a line.
      const now = { ...(seen.get(build.buildId) ?? { offset: 0, steps: 0 }) }
      try {
        const handle = await open(build.logPath, 'r')
        try {
          const size = (await handle.stat()).size
          const length = Math.min(Math.max(0, size - now.offset), READ_MAX)
          if (length > 0) {
            const buffer = Buffer.alloc(length)
            await handle.read(buffer, 0, length, now.offset)
            const text = buffer.toString('utf8')
            const end = text.lastIndexOf('\n') + 1
            for (const line of lines(text.slice(0, end))) {
              const started = line.startsWith('[sched]') ? SCHED_STARTED.exec(line) : null
              if (line.startsWith('› ')) {
                now.steps += 1
                now.phase = line.slice(2).trim().slice(0, 120)
              } else if (started) {
                const [, h = '0', m = '0', sec = '0'] = started
                now.queuedMs = ((Number(h) * 60 + Number(m)) * 60 + Number(sec)) * 1000
                now.phase = undefined
              } else if (
                line.startsWith('[sched]') &&
                now.steps === 0 &&
                now.queuedMs === undefined
              ) {
                now.phase = SIM_BUILD_WAITING_FOR_MEMORY
              } else if (/Installing CocoaPods|pod install/i.test(line)) {
                now.phase = 'pod install'
              }
            }
            now.offset += Buffer.byteLength(text.slice(0, end))
          }
        } finally {
          await handle.close()
        }
      } catch {
        // No log yet.
      }
      const latest = seen.get(build.buildId)
      if (latest && latest.offset > now.offset) {
        return latest
      }
      seen.set(build.buildId, now)
      return now
    },
    forget(buildId) {
      seen.delete(buildId)
    }
  }
}
