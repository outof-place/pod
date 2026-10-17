// Fork-only (Pod): what a build's log says while it runs and after. Progress counts the `› ` lines
// expo run:ios prints per step (`› Compiling react-native-screens`, about 1,700 for Portivo's mobile
// client) against the last good build of the same bundle id, read incrementally; the phase is the
// latest of them, `pod install`, or claude-acc's scheduler holding it for memory (`[sched]` lines
// before any step). A failure is answered with the log's last lines.
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

export type SimBuildProgress = { offset: number; steps: number; phase?: string }

export type SimBuildProgressReader = {
  /** Reads the log's new whole lines since the last call for this build. */
  advance(build: SimBuildRecord): Promise<SimBuildProgress>
  forget(buildId: string): void
}

export function createSimBuildProgress(): SimBuildProgressReader {
  const seen = new Map<string, SimBuildProgress>()
  return {
    async advance(build) {
      const now = seen.get(build.buildId) ?? { offset: 0, steps: 0 }
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
              if (line.startsWith('› ')) {
                now.steps += 1
                now.phase = line.slice(2).trim().slice(0, 120)
              } else if (line.startsWith('[sched]') && now.steps === 0) {
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
      seen.set(build.buildId, now)
      return now
    },
    forget(buildId) {
      seen.delete(buildId)
    }
  }
}
