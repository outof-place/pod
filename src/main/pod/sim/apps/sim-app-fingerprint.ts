// Fork-only (Pod): a worktree app's native fingerprint, the key of its dev client. The recipe's
// command prints it: @expo/fingerprint's JSON (`{ sources, hash }`, 1.2 to 2.7 s a call on
// Portivo's mobile app with Expo 58 and @expo/fingerprint 0.21.3) or a bare hash.
//
// Repeat calls are cheap: the answer is kept against what it hashed, and checked by stat alone
// (size, mtime, inode): every file and package.json the JSON lists as a source, the app's own config
// files (app.json, app.config.*, package.json, .env*, which @expo/fingerprint reads through `expo
// config` without listing them, and which of them exist), and the lockfiles and install markers
// from the app's folder up to the worktree root (a dependency install changes autolinking). A
// source directory with a hash is walked; a bare hash has no sources, so only the config files and
// install markers guard it. Anything changed, or changed while the command ran, runs it again. A
// local module that app.config.ts imports is not watched. Calls for one app in one worktree share
// one run; a `fresh` call runs it again whatever is kept (before a build: @expo/fingerprint 0.21.3
// leaves a config that failed to load out of the hash with only a warning, ExpoConfig.js
// getExpoConfigAsync, so one run's hash may not hold).
import { readdir, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import type { SimRecipeApp } from '../../../../shared/pod-sim/sim-recipe'
import { simRunFailure } from '../adapters/sim-command-run'
import { isSimFingerprint } from './sim-app-paths'
import { simAppEnv, simShell, type SimShell } from './sim-app-shell'

export const SIM_FINGERPRINT_TIMEOUT_MS = 5 * 60_000
/** A source directory past this many entries is not walked on every call: the answer is not kept. */
const DIR_WALK_LIMIT = 5_000
const INSTALL_MARKERS = [
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'node_modules/.modules.yaml',
  'node_modules/.package-lock.json',
  'node_modules/.yarn-state.yml',
  '.pnp.cjs'
] as const

export type SimFingerprintInput = Readonly<{
  worktreeRoot: string
  appId: string
  app: SimRecipeApp
}>

export type SimFingerprintAnswer =
  | Readonly<{ ok: true; hash: string; cached: boolean; ms: number }>
  | Readonly<{ ok: false; message: string }>

export type SimFingerprints = {
  of(input: SimFingerprintInput, how?: Readonly<{ fresh?: boolean }>): Promise<SimFingerprintAnswer>
}

type Source = { type: string; filePath?: string; hash?: string | null }

export type SimFingerprintOutput = Readonly<{ hash: string; sources: readonly Source[] | null }>

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** The hash a fingerprint command printed, and the sources it hashed when it said. */
export function parseSimFingerprint(stdout: string): SimFingerprintOutput | null {
  const text = stdout.trim()
  if (text.startsWith('{')) {
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      return null
    }
    if (!isRecord(json) || typeof json.hash !== 'string' || !isSimFingerprint(json.hash)) {
      return null
    }
    const sources = Array.isArray(json.sources)
      ? json.sources.filter(
          (source): source is Source => isRecord(source) && typeof source.type === 'string'
        )
      : null
    return { hash: json.hash, sources }
  }
  // A bare hash: the last line, a word of 8 or more hash characters (not `done`, not a path).
  const line = text.split('\n').at(-1)?.trim() ?? ''
  return /^[A-Za-z0-9_-]{8,256}$/.test(line) ? { hash: line, sources: null } : null
}

type Stamp = string

// The app config @expo/fingerprint evaluates, and the fingerprint's own config.
const CONFIG_FILE =
  /^(app\.json|app\.config\.[cm]?[jt]s|package\.json|\.env(\..+)?|\.fingerprintignore|fingerprint\.config\.[cm]?js)$/

/** The config files in the app's folder, by name, sorted. */
async function configFiles(appDir: string): Promise<string[]> {
  const entries = await readdir(appDir).catch(() => [])
  return entries.filter((entry) => CONFIG_FILE.test(entry)).sort()
}

const CONFIG_NAMES = '\u0000config files'

async function stampOf(path: string): Promise<Stamp> {
  try {
    const info = await stat(path)
    return `${info.isDirectory() ? 'd' : 'f'}:${info.size}:${info.mtimeMs}:${info.ino}`
  } catch {
    return 'absent'
  }
}

/** Every entry under `dir` with its stamp, or null past the walk limit. */
async function walk(
  dir: string,
  out: Map<string, Stamp>,
  budget: { left: number }
): Promise<boolean> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    out.set(dir, 'absent')
    return true
  }
  for (const entry of entries) {
    budget.left -= 1
    if (budget.left < 0) {
      return false
    }
    const path = join(dir, entry)
    const stamp = await stampOf(path)
    out.set(path, stamp)
    if (stamp.startsWith('d:') && !(await walk(path, out, budget))) {
      return false
    }
  }
  return true
}

/** The paths that decide the answer, and their stamps now; null when they are too many to check. */
async function guardOf(
  input: SimFingerprintInput,
  appDir: string,
  sources: readonly Source[] | null
): Promise<Map<string, Stamp> | null> {
  const stamps = new Map<string, Stamp>()
  const files = new Set<string>()
  const dirs: string[] = []
  for (const source of sources ?? []) {
    if (!source.filePath) {
      continue
    }
    const path = resolve(appDir, source.filePath)
    if (source.type === 'dir') {
      // A dir without a hash was skipped (gitignored ios/ in a CNG app).
      if (source.hash) {
        dirs.push(path)
      }
    } else {
      files.add(path)
    }
  }
  for (const entry of await configFiles(appDir)) {
    files.add(join(appDir, entry))
  }
  for (let dir = appDir; ; dir = dirname(dir)) {
    for (const marker of INSTALL_MARKERS) {
      files.add(join(dir, marker))
    }
    if (
      dir === input.worktreeRoot ||
      relative(input.worktreeRoot, dir).startsWith('..') ||
      dir === dirname(dir)
    ) {
      break
    }
  }
  const list = [...files]
  const read = await Promise.all(list.map(stampOf))
  list.forEach((path, index) => stamps.set(path, read[index]))
  stamps.set(join(appDir, CONFIG_NAMES), (await configFiles(appDir)).join('\n'))
  const budget = { left: DIR_WALK_LIMIT }
  for (const dir of dirs) {
    stamps.set(dir, await stampOf(dir))
    if (!(await walk(dir, stamps, budget))) {
      return null
    }
  }
  return stamps
}

async function unchanged(guard: ReadonlyMap<string, Stamp>): Promise<boolean> {
  const paths = [...guard.keys()]
  const now = await Promise.all(
    paths.map((path) =>
      path.endsWith(CONFIG_NAMES)
        ? configFiles(dirname(path)).then((names) => names.join('\n'))
        : stampOf(path)
    )
  )
  return paths.every((path, index) => guard.get(path) === now[index])
}

// File systems stamp behind Date.now: Linux by a clock tick, HFS+ to the whole second, FAT to two.
const FS_STAMP_LAG_MS = 2_000

function changedSince(guard: ReadonlyMap<string, Stamp>, sinceMs: number): boolean {
  for (const stamp of guard.values()) {
    const mtime = /^[df]:/.test(stamp) ? Number(stamp.split(':')[2]) : Number.NaN
    if (Number.isFinite(mtime) && mtime >= sinceMs - FS_STAMP_LAG_MS) {
      return true
    }
  }
  return false
}

export type SimFingerprintOptions = Readonly<{
  shell?: SimShell
  env?: NodeJS.ProcessEnv
  now?: () => number
}>

export function createSimFingerprints(options: SimFingerprintOptions = {}): SimFingerprints {
  const shell = options.shell ?? simShell
  const now = options.now ?? Date.now
  const kept = new Map<string, { hash: string; guard: ReadonlyMap<string, Stamp> }>()
  const running = new Map<string, Promise<SimFingerprintAnswer>>()

  const compute = async (
    input: SimFingerprintInput,
    key: string,
    fresh: boolean
  ): Promise<SimFingerprintAnswer> => {
    const started = performance.now()
    const command = input.app.fingerprint
    if (!command) {
      return { ok: false, message: `simulators.apps.${input.appId}.fingerprint is not set` }
    }
    const appDir = join(input.worktreeRoot, input.app.path)
    const before = kept.get(key)
    if (!fresh && before && (await unchanged(before.guard))) {
      return { ok: true, hash: before.hash, cached: true, ms: performance.now() - started }
    }
    kept.delete(key)
    const ranAt = now()
    const result = await shell(command, {
      cwd: appDir,
      env: simAppEnv(input.app.env, options.env),
      timeoutMs: SIM_FINGERPRINT_TIMEOUT_MS
    })
    if (!result.ok || result.code !== 0) {
      return { ok: false, message: simRunFailure('the fingerprint command', result) }
    }
    const output = parseSimFingerprint(result.stdout)
    if (!output) {
      return {
        ok: false,
        message: 'the fingerprint command printed neither @expo/fingerprint JSON nor a hash'
      }
    }
    const guard = await guardOf(input, appDir, output.sources)
    if (guard && !changedSince(guard, ranAt)) {
      kept.set(key, { hash: output.hash, guard })
    }
    return { ok: true, hash: output.hash, cached: false, ms: performance.now() - started }
  }

  return {
    of(input, how = {}) {
      const key = JSON.stringify([
        input.worktreeRoot,
        input.appId,
        input.app.path,
        input.app.fingerprint,
        input.app.env ?? {}
      ])
      if (how.fresh) {
        return compute(input, key, true)
      }
      const inFlight = running.get(key)
      if (inFlight) {
        return inFlight
      }
      const run = compute(input, key, false).finally(() => running.delete(key))
      running.set(key, run)
      return run
    }
  }
}
