import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { ProcessResult, ProcessSpec } from '@orca/process-host/process-spec'
import { compareAppVersions, parseCliVersion } from '../../../shared/app-version'
import { podGoCacheHelperPath } from './pod-gocache-paths'

// A fresh binary's first exec waits on the macOS malware scan; a few seconds is normal.
const VERSION_TIMEOUT_MS = 15_000
const TEMP_PREFIX = '.pod-gocache.'

export type RunProcess = (spec: ProcessSpec) => Promise<ProcessResult>

/** `<helper> version`, parsed; null when missing, not executable, garbage or never answered. */
export async function probeHelperVersion(
  path: string,
  run: RunProcess
): Promise<{ version: string | null; timedOut: boolean }> {
  try {
    const result = await run({ program: path, args: ['version'], timeoutMs: VERSION_TIMEOUT_MS })
    const version = result.code === 0 ? parseCliVersion(result.stdout) : null
    return { version, timedOut: result.timedOut }
  } catch {
    return { version: null, timedOut: false }
  }
}

export async function readHelperVersion(path: string, run: RunProcess): Promise<string | null> {
  return (await probeHelperVersion(path, run)).version
}

export function isRegularFile(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isFile() === true
}

/** Same bytes: the installed copy is the bundled build, no exec needed. */
export function sameBytes(a: string, b: string): boolean {
  try {
    if (statSync(a).size !== statSync(b).size) {
      return false
    }
    return readFileSync(a).equals(readFileSync(b))
  } catch {
    return false
  }
}

export type HelperReplacement =
  | {
      replace: 'first-install' | 'installed-broken' | 'version-changed' | 'forced'
      from: string | null
    }
  | { replace: null; from: string }
  | 'newer-installed'
  | 'installed-unanswered'

/** Replaced only for a strictly newer version or a broken install: osx-sign makes every build's bytes differ. */
export async function helperReplacement(
  input: { home: string; bundledHelper: string; force?: boolean },
  version: string,
  run: RunProcess
): Promise<HelperReplacement> {
  const installed = podGoCacheHelperPath(input.home)
  if (!existsSync(installed)) {
    return { replace: 'first-install', from: null }
  }
  const same = sameBytes(input.bundledHelper, installed)
  const probe = same ? { version, timedOut: false } : await probeHelperVersion(installed, run)
  // a slow first exec is not a broken install: replacing it could roll a newer helper back
  if (probe.timedOut) {
    return 'installed-unanswered'
  }
  const from = probe.version
  if (!from) {
    return { replace: 'installed-broken', from: null }
  }
  const order = compareAppVersions(version, from)
  if (order > 0) {
    return { replace: 'version-changed', from }
  }
  if (input.force && !same) {
    return { replace: 'forced', from }
  }
  return order < 0 ? 'newer-installed' : { replace: null, from }
}

/** Copies a previous install left behind when it stopped between copy and rename. */
function removeStaleTemps(dir: string): void {
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (name.startsWith(TEMP_PREFIX)) {
      rmSync(join(dir, name), { force: true })
    }
  }
}

/**
 * Puts `source` at `target` so a reader only ever sees the old file or the whole new one: copy to a
 * temp file beside it, prove the copy answers `version` with `expected`, then rename over. Callers
 * hold the install lock.
 */
export async function installHelperAtomically(
  source: string,
  target: string,
  expected: string,
  run: RunProcess
): Promise<string | null> {
  const dir = dirname(target)
  mkdirSync(dir, { recursive: true })
  removeStaleTemps(dir)
  const temp = join(dir, `${TEMP_PREFIX}${process.pid}.${basename(target)}.tmp`)
  try {
    // A clone on one APFS volume; a plain copy anywhere else.
    copyFileSync(source, temp, constants.COPYFILE_FICLONE)
    chmodSync(temp, 0o755)
    const answered = await readHelperVersion(temp, run)
    if (answered !== expected) {
      return `the copy answers version ${answered ?? '(nothing)'}, expected ${expected}`
    }
    renameSync(temp, target)
    return null
  } finally {
    rmSync(temp, { force: true })
  }
}
