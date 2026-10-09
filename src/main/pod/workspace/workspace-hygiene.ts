import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  PodWorkspaceSpotlight,
  PodWorkspaceTimeMachineDestination
} from '../../../shared/pod-workspace-types'
import { mapWithConcurrency } from '../../../shared/map-with-concurrency'
import { findWorktreeBuildDirs } from './workspace-build-dirs'
import type { WorkspaceToolRunner } from './workspace-tool-runner'

// Why batches: one tmutil per path costs a spawn each; one per thousand paths risks ARG_MAX.
export const TMUTIL_BATCH_SIZE = 64
const TMUTIL_TIMEOUT_MS = 10_000
const MDFIND_TIMEOUT_MS = 3_000
const MAX_SPOTLIGHT_PROBES = 3
// Spotlight picks a file up within minutes; one this old that it misses is outside the index.
const SPOTLIGHT_PROBE_MIN_AGE_MS = 2 * 60 * 60 * 1000
// Tracked at the root of most repos; fixed names keep the mdfind query free of user input.
const SPOTLIGHT_PROBE_NAMES = [
  'README.md',
  'package.json',
  'Cargo.toml',
  'go.mod',
  'pyproject.toml',
  'Package.swift',
  'LICENSE'
] as const

export type ExclusionState = 'excluded' | 'included' | 'unknown'

function batches<T>(items: readonly T[]): T[][] {
  const out: T[][] = []
  for (let index = 0; index < items.length; index += TMUTIL_BATCH_SIZE) {
    out.push(items.slice(index, index + TMUTIL_BATCH_SIZE))
  }
  return out
}

const EXCLUSION_LINE = /^\[(Excluded|Included|UNKNOWN)\]\s+(.+)$/

function parseExclusionLines(stdout: string): { state: ExclusionState; path: string }[] {
  const parsed: { state: ExclusionState; path: string }[] = []
  for (const line of stdout.split('\n')) {
    const match = EXCLUSION_LINE.exec(line.trim())
    if (match) {
      const state =
        match[1] === 'Excluded' ? 'excluded' : match[1] === 'Included' ? 'included' : 'unknown'
      parsed.push({ state, path: match[2].trim() })
    }
  }
  return parsed
}

/** `tmutil isexcluded` for many paths, batched; unreported paths stay unknown. */
export async function readTimeMachineExclusions(
  run: WorkspaceToolRunner,
  paths: readonly string[]
): Promise<Map<string, ExclusionState>> {
  const states = new Map<string, ExclusionState>()
  for (const batch of batches(paths)) {
    const result = await run('tmutil', ['isexcluded', ...batch], { timeoutMs: TMUTIL_TIMEOUT_MS })
    const lines = parseExclusionLines(result.stdout)
    // tmutil answers one line per argument, in order; fall back to the echoed path otherwise.
    const byOrder = lines.length === batch.length
    batch.forEach((path, index) => {
      const line = byOrder ? lines[index] : lines.find((entry) => entry.path === path)
      states.set(path, line?.state ?? 'unknown')
    })
  }
  return states
}

/** Sticky `tmutil addexclusion` (an xattr, no root); re-read so only verified paths count. */
export async function addTimeMachineExclusions(
  run: WorkspaceToolRunner,
  paths: readonly string[]
): Promise<{ excluded: string[]; failed: string[] }> {
  for (const batch of batches(paths)) {
    // A path that vanished fails the call but tmutil still applies the rest of the batch.
    await run('tmutil', ['addexclusion', ...batch], { timeoutMs: TMUTIL_TIMEOUT_MS })
  }
  const states = await readTimeMachineExclusions(run, paths)
  const excluded = paths.filter((path) => states.get(path) === 'excluded')
  return { excluded, failed: paths.filter((path) => states.get(path) !== 'excluded') }
}

/** Build dirs under the given checkouts, split by whether Time Machine already skips them. */
export async function readBuildDirExclusions(
  run: WorkspaceToolRunner,
  worktreePaths: readonly string[]
): Promise<{ excluded: string[]; missing: string[] }> {
  const dirs = [
    ...new Set((await mapWithConcurrency(worktreePaths, 4, findWorktreeBuildDirs)).flat())
  ]
  const states = await readTimeMachineExclusions(run, dirs)
  return {
    excluded: dirs.filter((dir) => states.get(dir) === 'excluded'),
    // Why unknown counts as missing: addexclusion is idempotent and the re-read settles it.
    missing: dirs.filter((dir) => states.get(dir) !== 'excluded')
  }
}

export async function excludeMissingBuildDirs(
  run: WorkspaceToolRunner,
  worktreePaths: readonly string[]
): Promise<{ excluded: string[]; failed: string[] }> {
  const { missing } = await readBuildDirExclusions(run, worktreePaths)
  return missing.length === 0
    ? { excluded: [], failed: [] }
    : addTimeMachineExclusions(run, missing)
}

export async function readTimeMachineDestination(
  run: WorkspaceToolRunner
): Promise<PodWorkspaceTimeMachineDestination> {
  const result = await run('tmutil', ['destinationinfo'], { timeoutMs: TMUTIL_TIMEOUT_MS })
  const text = `${result.stdout}\n${result.stderr}`
  if (/no destinations configured/i.test(text)) {
    return 'none'
  }
  return result.code === 0 && /^\s*(Name|ID|Kind)\s*:/m.test(text) ? 'configured' : 'unknown'
}

export type SpotlightProbeDeps = {
  run: WorkspaceToolRunner
  /** Repos under the root, nearest first. */
  repoPaths: readonly string[]
  /** Which of `names` git tracks at the repo root. */
  listTrackedRootFiles: (repoPath: string, names: readonly string[]) => Promise<string[]>
  now: number
  statTimes?: (path: string) => Promise<{ mtimeMs: number; ctimeMs: number } | null>
}

async function statTimes(path: string): Promise<{ mtimeMs: number; ctimeMs: number } | null> {
  try {
    const info = await stat(path)
    return { mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs }
  } catch {
    return null
  }
}

async function pickSpotlightProbes(
  deps: SpotlightProbeDeps
): Promise<{ repoPath: string; name: string }[]> {
  const readTimes = deps.statTimes ?? statTimes
  const isOld = (times: { mtimeMs: number; ctimeMs: number } | null): boolean =>
    times !== null &&
    deps.now - Math.max(times.mtimeMs, times.ctimeMs) >= SPOTLIGHT_PROBE_MIN_AGE_MS
  const probes: { repoPath: string; name: string }[] = []
  for (const repoPath of deps.repoPaths) {
    // A just-moved or just-cloned repo has a fresh root; Spotlight may not have seen it yet.
    if (probes.length >= MAX_SPOTLIGHT_PROBES || !isOld(await readTimes(repoPath))) {
      continue
    }
    const tracked = await deps.listTrackedRootFiles(repoPath, SPOTLIGHT_PROBE_NAMES)
    for (const name of tracked) {
      if (isOld(await readTimes(join(repoPath, name)))) {
        probes.push({ repoPath, name })
        break
      }
    }
  }
  return probes
}

/** Whether Spotlight indexes the root, judged from old tracked files; no root needed. */
export async function detectSpotlightState(
  deps: SpotlightProbeDeps
): Promise<PodWorkspaceSpotlight> {
  const unknown = (reason: PodWorkspaceSpotlight['reason']): PodWorkspaceSpotlight => ({
    state: 'unknown',
    reason,
    checkedAt: deps.now
  })
  const indexing = await deps.run('mdutil', ['-s', '/'], { timeoutMs: MDFIND_TIMEOUT_MS })
  if (/disabled/i.test(indexing.stdout)) {
    return unknown('indexing-disabled')
  }
  const probes = await pickSpotlightProbes(deps)
  if (probes.length === 0) {
    return unknown('no-old-files')
  }
  let answered = 0
  for (const probe of probes) {
    const result = await deps.run(
      'mdfind',
      ['-onlyin', probe.repoPath, `kMDItemFSName == "${probe.name}"`],
      { timeoutMs: MDFIND_TIMEOUT_MS }
    )
    if (result.code !== 0 || result.timedOut) {
      continue
    }
    answered += 1
    if (result.stdout.split('\n').some((line) => line.trim().endsWith(`/${probe.name}`))) {
      return { state: 'indexed', reason: null, checkedAt: deps.now }
    }
  }
  return answered === probes.length
    ? { state: 'excluded', reason: null, checkedAt: deps.now }
    : unknown('error')
}
