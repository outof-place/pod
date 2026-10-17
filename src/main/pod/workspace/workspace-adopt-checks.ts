// Fork-only (Pod): what a Move In plan shows besides its blockers: files held open in the folders,
// and the side effects the user should know before applying (Compose project, Claude trust).
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { PodAdoptOpenFile, PodAdoptWarning } from '../../../shared/pod-workspace-tidy-types'
import type { ProcessCwdReader } from './workspace-process-cwds'

/** The plan lists this many open files at most; the blocker stands for all of them. */
const OPEN_FILES_SHOWN = 20
const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml']

/**
 * Files other processes hold open in the folders, one native pass; none where the addon predates
 * it. Plan reads only: never in a loop or on a timer.
 */
export async function findOpenFilesInside(
  reader: ProcessCwdReader | null,
  folders: readonly string[],
  skipPids: ReadonlySet<number>
): Promise<{ files: PodAdoptOpenFile[]; pids: number[] }> {
  if (!reader?.openPathsUnder) {
    return { files: [], pids: [] }
  }
  const hits = reader
    .openPathsUnder(folders)
    .filter((hit) => hit.pid !== process.pid && !skipPids.has(hit.pid))
  if (hits.length === 0) {
    return { files: [], pids: [] }
  }
  const pids = [...new Set(hits.map((hit) => hit.pid))].sort((a, b) => a - b)
  const names = await reader.readNames(pids)
  const files = hits
    .slice(0, OPEN_FILES_SHOWN)
    .map((hit) => ({ pid: hit.pid, name: names.get(hit.pid) ?? '', path: hit.path }))
  return { files, pids }
}

/** Compose names a project after its folder: lowercase, only `[a-z0-9_-]`. */
function composeProjectName(folder: string): string {
  return basename(folder)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
}

async function readText(path: string): Promise<string | null> {
  return readFile(path, 'utf8').catch(() => null)
}

/** A Compose project keyed by the folder name gets a new name, so its volumes look empty. */
async function composeWarning(from: string, to: string): Promise<PodAdoptWarning | null> {
  const [before, after] = [composeProjectName(from), composeProjectName(to)]
  if (before === after) {
    return null
  }
  for (const file of COMPOSE_FILES) {
    const compose = await readText(join(from, file))
    if (compose === null) {
      continue
    }
    const env = (await readText(join(from, '.env'))) ?? ''
    const pinned = /^name\s*:/m.test(compose) || /^\s*COMPOSE_PROJECT_NAME\s*=/m.test(env)
    return pinned ? null : { kind: 'compose-project', file, from: before, to: after }
  }
  return null
}

export async function adoptWarnings(
  from: string,
  to: string,
  claudeProjectDirs: readonly (readonly [string, string])[]
): Promise<PodAdoptWarning[]> {
  const warnings: PodAdoptWarning[] = []
  const compose = await composeWarning(from, to)
  if (compose) {
    warnings.push(compose)
  }
  // Claude keys folder trust by path in its own config, which Pod never writes.
  if (claudeProjectDirs.length > 0) {
    warnings.push({ kind: 'claude-trust', count: claudeProjectDirs.length })
  }
  return warnings
}
