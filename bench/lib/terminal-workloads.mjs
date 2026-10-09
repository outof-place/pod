// The output workloads every terminal runs, and the deterministic 100 MiB log `cat` prints.
import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeSync
} from 'node:fs'
import path from 'node:path'
import { TOOLS_BIN } from './bench-session.mjs'
import { PROFILE_BASE } from './orca-instance.mjs'

export const SEQ_LINES = 3_000_000
export const LOG_BYTES = 100 * 2 ** 20
export const TUI_FRAMES = 10_000

/** Bytes `seq 1 N` prints. */
export function seqBytes(n) {
  let bytes = 0
  for (let digits = 1, low = 1; low <= n; digits += 1, low *= 10) {
    bytes += (Math.min(n, low * 10 - 1) - low + 1) * (digits + 1)
  }
  return bytes
}

// mulberry32: a fixed seed gives the same file on every machine.
function prng(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const LEVELS = [
  [0.8, '\x1b[32mINFO \x1b[0m'],
  [0.92, '\x1b[33mWARN \x1b[0m'],
  [0.98, '\x1b[2mDEBUG\x1b[0m'],
  [1, '\x1b[31mERROR\x1b[0m']
]
const VERBS = ['GET', 'GET', 'GET', 'POST', 'PUT', 'DELETE']
const ROUTES = [
  '/api/v1/projects/%/tasks',
  '/api/v1/users/%',
  '/api/v1/search?q=%',
  '/healthz',
  '/api/v1/agents/%/runs',
  '/static/app.%.js'
]

/** A colored application log, LOG_BYTES long (cut at a line end); cached under the bench profile base. */
export function ensureLogFile() {
  const file = path.join(PROFILE_BASE, 'bench-100mib.log')
  if (!existsSync(file) || statSync(file).size < LOG_BYTES) {
    mkdirSync(PROFILE_BASE, { recursive: true })
    const random = prng(20261009)
    const fd = openSync(file, 'w')
    let written = 0
    let at = Date.parse('2026-10-09T08:00:00.000Z')
    const chunk = []
    let chunkBytes = 0
    while (written < LOG_BYTES) {
      at += Math.floor(random() * 40)
      const roll = random()
      const level = LEVELS.find(([limit]) => roll < limit)[1]
      const route = ROUTES[Math.floor(random() * ROUTES.length)].replace(
        '%',
        String(Math.floor(random() * 100000))
      )
      const status = roll < 0.98 ? (random() < 0.9 ? 200 : 304) : 500
      const line = `${new Date(at).toISOString()} ${level} [worker-${String(Math.floor(random() * 16)).padStart(2, '0')}] ${VERBS[Math.floor(random() * VERBS.length)]} ${route} ${status} ${(random() * 300).toFixed(1)}ms req=${Math.floor(
        random() * 2 ** 32
      )
        .toString(16)
        .padStart(8, '0')} bytes=${Math.floor(random() * 100000)}\n`
      const bytes = Buffer.byteLength(line)
      if (written + chunkBytes + bytes > LOG_BYTES) {
        break
      }
      chunk.push(line)
      chunkBytes += bytes
      if (chunkBytes > 1 << 20) {
        writeSync(fd, chunk.join(''))
        written += chunkBytes
        chunk.length = 0
        chunkBytes = 0
      }
    }
    writeSync(fd, chunk.join(''))
    closeSync(fd)
  }
  return {
    path: file,
    bytes: statSync(file).size,
    sha256: createHash('sha256').update(readFileSync(file)).digest('hex')
  }
}

/** The shell command line that runs one workload under termload and writes its timings to `out`. */
export function workloads(logFile) {
  const termload = path.join(TOOLS_BIN, 'termload')
  return {
    seq: {
      label: `seq 1 ${SEQ_LINES}`,
      bytes: seqBytes(SEQ_LINES),
      command: (out) => `'${termload}' --out '${out}' -- seq 1 ${SEQ_LINES}`
    },
    cat: {
      label: `cat ${(logFile.bytes / 2 ** 20).toFixed(0)} MiB log`,
      bytes: logFile.bytes,
      command: (out) => `'${termload}' --out '${out}' -- cat '${logFile.path}'`
    },
    tui: {
      label: `TUI repaint flood, ${TUI_FRAMES} full 80x24 frames`,
      bytes: null,
      command: (out) => `'${termload}' --out '${out}' --tui ${TUI_FRAMES}`
    }
  }
}
