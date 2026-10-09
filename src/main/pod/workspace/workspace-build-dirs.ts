import { lstat, readdir, readFile } from 'node:fs/promises'
import { join, normalize, sep } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { mapWithConcurrency } from '../../../shared/map-with-concurrency'

// Regenerable output that Time Machine should never copy.
const BUILD_DIR_NAMES = ['node_modules', '.next', '.turbo', '.pnpm-store', 'DerivedData'] as const
// These names are only build output next to their manifest; elsewhere they may be source.
const MANIFEST_BUILD_DIRS = [
  { dir: 'target', manifest: 'Cargo.toml' },
  { dir: '.build', manifest: 'Package.swift' }
] as const
// Why a cap: a workspace glob over a huge folder must not turn a shallow check into a walk.
const MAX_PACKAGE_DIRS = 200

async function isRealDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory()
  } catch {
    return false
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile()
  } catch {
    return false
  }
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry: unknown): entry is string => typeof entry === 'string')
    : []
}

async function workspacePatterns(root: string): Promise<string[]> {
  const patterns: string[] = []
  const pnpmWorkspace = await readText(join(root, 'pnpm-workspace.yaml'))
  if (pnpmWorkspace !== null) {
    try {
      const parsed: unknown = parseYaml(pnpmWorkspace)
      if (typeof parsed === 'object' && parsed !== null) {
        patterns.push(...stringArray(Reflect.get(parsed, 'packages')))
      }
    } catch {
      // A malformed workspace file only means fewer package dirs are checked.
    }
  }
  const packageJson = await readText(join(root, 'package.json'))
  if (packageJson !== null) {
    try {
      const parsed: unknown = JSON.parse(packageJson)
      const workspaces: unknown =
        typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'workspaces') : null
      patterns.push(
        ...stringArray(workspaces),
        ...(typeof workspaces === 'object' && workspaces !== null && !Array.isArray(workspaces)
          ? stringArray(Reflect.get(workspaces, 'packages'))
          : [])
      )
    } catch {
      // Same as above.
    }
  }
  return patterns
}

/** Package dirs named by `dir` or `dir/*` workspace patterns; deeper globs are skipped. */
export async function listWorkspacePackageDirs(root: string): Promise<string[]> {
  const found = new Set<string>()
  for (const raw of await workspacePatterns(root)) {
    const pattern = raw.trim().replace(/^\.\//, '').replace(/\/+$/, '')
    if (!pattern || pattern.startsWith('!')) {
      continue
    }
    const listsChildren = pattern.endsWith('/*')
    const base = listsChildren ? pattern.slice(0, -2) : pattern
    const normalizedBase = normalize(base)
    if (base.includes('*') || normalizedBase === '..' || normalizedBase.startsWith(`..${sep}`)) {
      continue
    }
    if (!listsChildren) {
      found.add(join(root, normalizedBase))
      continue
    }
    try {
      const entries = await readdir(join(root, normalizedBase), { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
          found.add(join(root, normalizedBase, entry.name))
        }
      }
    } catch {
      // Missing workspace folders are normal in partial checkouts.
    }
    if (found.size >= MAX_PACKAGE_DIRS) {
      break
    }
  }
  return [...found].slice(0, MAX_PACKAGE_DIRS)
}

async function buildDirsIn(dir: string): Promise<string[]> {
  const candidates: string[] = BUILD_DIR_NAMES.map((name) => join(dir, name))
  for (const { dir: name, manifest } of MANIFEST_BUILD_DIRS) {
    if (await isFile(join(dir, manifest))) {
      candidates.push(join(dir, name))
    }
  }
  const present = await Promise.all(candidates.map(isRealDirectory))
  return candidates.filter((_, index) => present[index])
}

/** Existing build dirs directly under a checkout and its workspace packages; never a deep walk. */
export async function findWorktreeBuildDirs(worktreePath: string): Promise<string[]> {
  const dirs = [worktreePath, ...(await listWorkspacePackageDirs(worktreePath))]
  const nested = await mapWithConcurrency(dirs, 8, buildDirsIn)
  return nested.flat()
}
