import { open, readdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import {
  POD_GIT_PROFILE_RECORD_KEY,
  parseGitVersion,
  type PodGitProfileCurrent,
  type PodGitProfileFacts,
  type PodGitProfileKey
} from '../../../shared/pod-workspace-git-profile'
import type { WorkspaceGitExec } from './workspace-git-exec'

export const PROFILE_KEYS: readonly PodGitProfileKey[] = [
  'core.untrackedCache',
  'core.fsmonitor',
  'index.version',
  'checkout.workers',
  'fetch.writeCommitGraph',
  'maintenance.strategy',
  'maintenance.prefetch.enabled',
  'maintenance.geometric-repack.schedule'
]

const RECORD = POD_GIT_PROFILE_RECORD_KEY.toLowerCase()
// git prints canonical names: section and key lowercased, a subsection kept as written.
const KEY_PATTERN = `^(${[...PROFILE_KEYS.map((key) => key.toLowerCase()), RECORD]
  .map((key) => key.replace(/[.-]/g, (char) => `\\${char}`))
  .join('|')})$`

export type RepoGitDirs = { gitDir: string; commonDir: string }

export async function readRepoGitDirs(
  git: WorkspaceGitExec,
  repoPath: string
): Promise<RepoGitDirs | null> {
  const result = await git(['rev-parse', '--git-dir', '--git-common-dir'], repoPath)
  const [gitDir, commonDir] = result.stdout.split('\n').map((line) => line.trim())
  if (result.code !== 0 || !gitDir || !commonDir) {
    return null
  }
  const absolute = (value: string): string => (isAbsolute(value) ? value : join(repoPath, value))
  return { gitDir: absolute(gitDir), commonDir: absolute(commonDir) }
}

/** Entry count from the index header (`DIRC`, version, count); no git spawn. */
export async function readIndexEntryCount(gitDir: string): Promise<number | null> {
  try {
    const handle = await open(join(gitDir, 'index'), 'r')
    try {
      const header = Buffer.alloc(12)
      const { bytesRead } = await handle.read(header, 0, 12, 0)
      return bytesRead === 12 && header.toString('latin1', 0, 4) === 'DIRC'
        ? header.readUInt32BE(8)
        : null
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}

export async function countPacks(commonDir: string): Promise<number | null> {
  try {
    return (await readdir(join(commonDir, 'objects', 'pack'))).filter((name) =>
      name.endsWith('.pack')
    ).length
  } catch {
    return null
  }
}

export type ConfigEntry = { scope: string; key: string; value: string }

/** `git config -z --show-scope --get-regexp`: `scope\0key\nvalue\0` per entry. */
export function parseScopedConfig(stdout: string): ConfigEntry[] {
  const fields = stdout.split('\0')
  const entries: ConfigEntry[] = []
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const record = fields[index + 1]
    const newline = record.indexOf('\n')
    entries.push({
      scope: fields[index],
      key: (newline === -1 ? record : record.slice(0, newline)).toLowerCase(),
      // A bare boolean key has no value line and means true.
      value: newline === -1 ? 'true' : record.slice(newline + 1)
    })
  }
  return entries
}

/** Pod's record entries, `<key>=<value>`, keyed by the lowercased key. */
export function parseProfileRecord(entries: readonly ConfigEntry[]): Map<string, string> {
  const record = new Map<string, string>()
  for (const entry of entries) {
    if (entry.scope === 'local' && entry.key === RECORD) {
      const separator = entry.value.indexOf('=')
      if (separator > 0) {
        record.set(entry.value.slice(0, separator).toLowerCase(), entry.value.slice(separator + 1))
      }
    }
  }
  return record
}

export function currentFromEntries(entries: readonly ConfigEntry[]): PodGitProfileCurrent {
  const record = parseProfileRecord(entries)
  const current: PodGitProfileCurrent = {}
  for (const key of PROFILE_KEYS.map((name) => name.toLowerCase())) {
    const forKey = entries.filter((entry) => entry.key === key)
    const local = forKey.filter((entry) => entry.scope === 'local')
    current[key] = {
      // Last one wins, as git reads it.
      local: local.at(-1)?.value ?? null,
      other: forKey.some((entry) => entry.scope !== 'local') || local.length > 1,
      recorded: record.get(key) ?? null
    }
  }
  return current
}

export async function readProfileConfig(
  git: WorkspaceGitExec,
  repoPath: string
): Promise<ConfigEntry[]> {
  const result = await git(['config', '-z', '--show-scope', '--get-regexp', KEY_PATTERN], repoPath)
  // Exit 1 means no key matched.
  return result.code === 0 ? parseScopedConfig(result.stdout) : []
}

export type GitHostFacts = { version: [number, number, number] | null; geometric: boolean }

/** Facts about the git binary itself; one probe per process is enough. */
export function createGitHostFactsReader(git: WorkspaceGitExec, cwd: string) {
  let cached: Promise<GitHostFacts> | null = null
  return (): Promise<GitHostFacts> => {
    cached ??= (async () => {
      const [version, help] = await Promise.all([
        git(['version'], cwd),
        // Lists every config key this build knows: a capability probe that needs no repo.
        git(['help', '--config'], cwd)
      ])
      return {
        version: parseGitVersion(version.stdout),
        geometric: help.stdout.includes('maintenance.geometric-repack.auto')
      }
    })()
    return cached
  }
}

export async function readRepoProfileFacts(
  git: WorkspaceGitExec,
  repoPath: string,
  host: GitHostFacts
): Promise<PodGitProfileFacts | null> {
  const dirs = await readRepoGitDirs(git, repoPath)
  if (!dirs) {
    return null
  }
  const [trackedFiles, packCount, promisor, fsmonitor] = await Promise.all([
    readIndexEntryCount(dirs.gitDir),
    countPacks(dirs.commonDir),
    git(
      ['config', '--get-regexp', '^(remote\\..*\\.promisor|extensions\\.partialclone)$'],
      repoPath
    ),
    git(['fsmonitor--daemon', 'status'], repoPath)
  ])
  return {
    gitVersion: host.version,
    trackedFiles,
    packCount,
    partialClone: promisor.code === 0 && promisor.stdout.trim().length > 0,
    // Exit 1 with "not watching" is a supported folder; git names refusals explicitly.
    fsmonitorSupported: !/incompatible|not supported|is not a git command/i.test(
      `${fsmonitor.stdout}\n${fsmonitor.stderr}`
    ),
    geometricMaintenance: host.geometric
  }
}
