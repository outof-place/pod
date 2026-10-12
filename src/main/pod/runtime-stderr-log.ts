// Fork-only (Pod): a runtime LaunchServices started has no stderr, so why the daemon fell back
// to local PTYs (or any other startup error) was lost. Tee it into userData/logs.
import { createWriteStream, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { getLogsDirectory } from '../observability/logs-directory'

export const RUNTIME_STDERR_LOG_NAME = 'runtime-stderr.log'
/** Per file and per session: the previous file is kept once as `.1`. */
export const RUNTIME_STDERR_LOG_MAX_BYTES = 2 * 1024 * 1024

let installed = false

export function installRuntimeStderrLog(
  logsDir: string = getLogsDirectory(),
  stream: Pick<NodeJS.WriteStream, 'write'> = process.stderr
): void {
  if (installed) {
    return
  }
  installed = true
  try {
    mkdirSync(logsDir, { recursive: true, mode: 0o700 })
    const path = join(logsDir, RUNTIME_STDERR_LOG_NAME)
    try {
      if (statSync(path).size > RUNTIME_STDERR_LOG_MAX_BYTES) {
        renameSync(path, `${path}.1`)
      }
    } catch {
      // No log yet.
    }
    const file = createWriteStream(path, { flags: 'a', mode: 0o600 })
    // A log that can't be written is no reason to stop.
    file.on('error', () => {})
    file.write(`--- ${new Date().toISOString()} pid ${process.pid}\n`)
    let written = 0
    const original = stream.write
    stream.write = (
      chunk: string | Uint8Array,
      encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
      callback?: (error?: Error | null) => void
    ): boolean => {
      if (written < RUNTIME_STDERR_LOG_MAX_BYTES) {
        const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
        written += text.length
        file.write(`${new Date().toISOString()} ${text}`)
      }
      return Reflect.apply(original, stream, [chunk, encodingOrCallback, callback])
    }
  } catch {
    // Same: stderr keeps working without the copy.
  }
}

export function resetRuntimeStderrLogForTests(): void {
  installed = false
}
