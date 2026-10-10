// Fork-only (Pod): one long-lived `orb` process per sampled machine. A stats tick writes a line to
// it instead of starting a Go client per machine, which cost ~16-22 ms/s of CPU at two machines.
import type { Readable, Writable } from 'node:stream'

/**
 * The reader's process, as spawnProcess returns it with piped stdio.
 * Why its own type: Orca allows child process modules only through its process-host package.
 */
export type StatsReaderProcess = {
  stdin: Writable
  stdout: Readable
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  kill(): boolean
}

const END = '@@END'
// Why a loop on stdin: each line asks for one read; stdin closing (idle, Pod quitting) ends it.
export const STATS_READER_SCRIPT = `while read -r _; do for f in "$@"; do echo "@@ $f"; cat "$f"; done; echo "${END}"; done`

type Reader = {
  child: StatsReaderProcess
  buffer: string
  waiting: ((text: string | null) => void) | null
  idle: ReturnType<typeof setTimeout> | null
}

export function createStatsReaders(deps: {
  /** Starts `orb -m <machine> <args>`; the machine must already run, or `orb` starts it. */
  spawn: (machine: string, args: readonly string[]) => StatsReaderProcess
  files: readonly string[]
  timeoutMs: number
  /** A reader nobody asked for this long is closed. */
  idleMs: number
}) {
  const readers = new Map<string, Reader>()

  const close = (name: string): void => {
    const reader = readers.get(name)
    if (!reader) {
      return
    }
    readers.delete(name)
    if (reader.idle) {
      clearTimeout(reader.idle)
    }
    reader.waiting?.(null)
    reader.waiting = null
    reader.child.stdin.end()
    // The loop ends on EOF; a reader stuck in a read goes anyway.
    setTimeout(() => reader.child.kill(), 1_000).unref?.()
  }

  const open = (name: string): Reader => {
    const child = deps.spawn(name, ['sh', '-c', STATS_READER_SCRIPT, 'pod-stats', ...deps.files])
    const reader: Reader = { child, buffer: '', waiting: null, idle: null }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      reader.buffer += chunk
      const end = reader.buffer.indexOf(`${END}\n`)
      if (end !== -1 && reader.waiting) {
        const text = reader.buffer.slice(0, end)
        reader.buffer = reader.buffer.slice(end + END.length + 1)
        const resolve = reader.waiting
        reader.waiting = null
        resolve(text)
      }
    })
    child.stdin.on('error', () => undefined)
    child.on('error', () => close(name))
    // The machine stopped or went: `orb` exits with it.
    child.on('exit', () => {
      if (readers.get(name) === reader) {
        readers.delete(name)
        reader.waiting?.(null)
        reader.waiting = null
        if (reader.idle) {
          clearTimeout(reader.idle)
        }
      }
    })
    readers.set(name, reader)
    return reader
  }

  return {
    has: (name: string): boolean => readers.has(name),
    /** One read of the machine's cgroup files, marked per file; null on a timeout or exit. */
    read: (name: string): Promise<string | null> => {
      const reader = readers.get(name) ?? open(name)
      if (reader.waiting) {
        return Promise.resolve(null)
      }
      if (reader.idle) {
        clearTimeout(reader.idle)
      }
      reader.idle = setTimeout(() => close(name), deps.idleMs)
      reader.idle.unref?.()
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          // A reader that misses its deadline is not trusted again.
          close(name)
          resolve(null)
        }, deps.timeoutMs)
        timer.unref?.()
        reader.waiting = (text) => {
          clearTimeout(timer)
          resolve(text)
        }
        reader.child.stdin.write('\n')
      })
    },
    /** Readers of machines no longer sampled. */
    retain: (names: ReadonlySet<string>): void => {
      for (const name of readers.keys()) {
        if (!names.has(name)) {
          close(name)
        }
      }
    },
    closeAll: (): void => {
      for (const name of readers.keys()) {
        close(name)
      }
    }
  }
}

export type StatsReaders = ReturnType<typeof createStatsReaders>
