// Measurement only: POD_TERMINAL_TRACE_FILE=<path> records hop timestamps (process.hrtime, which is
// mach_absolute_time on macOS, comparable across processes) to <path>.<pid>. Off, it costs one check.
import { appendFileSync } from 'node:fs'

const file = process.env.POD_TERMINAL_TRACE_FILE
const rows: string[] = []
let flushArmed = false

function flush(): void {
  flushArmed = false
  if (!file || rows.length === 0) {
    return
  }
  appendFileSync(`${file}.${process.pid}`, `${rows.join('\n')}\n`)
  rows.length = 0
}

if (file) {
  process.on('exit', flush)
}

export function podTrace(stage: string, size: number): void {
  if (!file) {
    return
  }
  rows.push(`${stage}\t${process.hrtime.bigint()}\t${size}`)
  if (!flushArmed) {
    flushArmed = true
    setTimeout(flush, 500).unref()
  }
}
