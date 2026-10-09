import { stat, statfs } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import type { PodWorkspaceVolumeChecks } from '../../../shared/pod-workspace-types'
import { expandWorkspaceRoot } from './workspace-root-path'
import type { WorkspaceToolRunner } from './workspace-tool-runner'

type PathIdentity = { path: string; dev: number; ino: number }

export type VolumeCheckDeps = {
  home: string
  pnpmStoreDir: string
  stat?: (path: string) => Promise<{ dev: number; ino: number } | null>
  statfs?: (path: string) => Promise<{ bavail: number; blocks: number; bsize: number } | null>
}

async function statIdentity(path: string): Promise<{ dev: number; ino: number } | null> {
  try {
    const info = await stat(path)
    return { dev: info.dev, ino: info.ino }
  } catch {
    return null
  }
}

async function statVolume(
  path: string
): Promise<{ bavail: number; blocks: number; bsize: number } | null> {
  try {
    const info = await statfs(path)
    return { bavail: info.bavail, blocks: info.blocks, bsize: info.bsize }
  } catch {
    return null
  }
}

/** A root or store that does not exist yet lives on its nearest existing ancestor's volume. */
async function nearestExisting(
  path: string,
  readStat: NonNullable<VolumeCheckDeps['stat']>
): Promise<PathIdentity | null> {
  let current = path
  for (;;) {
    const info = await readStat(current)
    if (info) {
      return { path: current, ...info }
    }
    const parent = dirname(current)
    if (parent === current) {
      return null
    }
    current = parent
  }
}

// ASCII only: Unicode case maps can change length (ß to SS) and would name another file.
function flipCase(value: string): string {
  return value.replace(/[A-Za-z]/g, (char) =>
    char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase()
  )
}

/** Stats the path with one component's case flipped: the same inode means case-insensitive. */
async function probeCaseSensitivity(
  target: PathIdentity,
  readStat: NonNullable<VolumeCheckDeps['stat']>
): Promise<boolean | null> {
  let current = target.path
  let suffix = ''
  while (dirname(current) !== current) {
    const name = basename(current)
    if (flipCase(name) !== name) {
      const flipped = await readStat(join(dirname(current), flipCase(name), suffix))
      if (!flipped) {
        return true
      }
      return !(flipped.dev === target.dev && flipped.ino === target.ino)
    }
    suffix = suffix ? join(name, suffix) : name
    current = dirname(current)
  }
  return null
}

export async function checkWorkspaceVolume(
  root: string,
  deps: VolumeCheckDeps
): Promise<PodWorkspaceVolumeChecks> {
  const readStat = deps.stat ?? statIdentity
  const [rootTarget, storeTarget] = await Promise.all([
    nearestExisting(root, readStat),
    nearestExisting(deps.pnpmStoreDir, readStat)
  ])
  const volume = rootTarget ? await (deps.statfs ?? statVolume)(rootTarget.path) : null
  return {
    pnpmStoreDir: deps.pnpmStoreDir,
    // Why it matters: APFS clones and pnpm's hard links only work within one volume.
    sameVolumeAsPnpmStore: rootTarget && storeTarget ? rootTarget.dev === storeTarget.dev : null,
    caseSensitive: rootTarget ? await probeCaseSensitivity(rootTarget, readStat) : null,
    freeBytes: volume ? volume.bavail * volume.bsize : null,
    totalBytes: volume ? volume.blocks * volume.bsize : null
  }
}

export function defaultPnpmStoreDir(home: string): string {
  return join(home, 'Library', 'pnpm', 'store')
}

/** `pnpm config get store-dir`, else pnpm's macOS default. Spawns pnpm: call it on demand only. */
export async function resolvePnpmStoreDir(
  run: WorkspaceToolRunner,
  home: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  const fromEnv = env.PNPM_STORE_DIR?.trim() || env.npm_config_store_dir?.trim()
  if (fromEnv && isAbsolute(fromEnv)) {
    return fromEnv
  }
  const result = await run('pnpm', ['config', 'get', 'store-dir'], { timeoutMs: 3_000, cwd: home })
  const value = result.code === 0 ? result.stdout.trim().split('\n').at(-1)?.trim() : undefined
  const expanded = value && value !== 'undefined' ? expandWorkspaceRoot(value, home) : null
  return expanded ?? defaultPnpmStoreDir(home)
}
