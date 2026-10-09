import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  PodWorkspaceRootIssue,
  PodWorkspaceRootValidation
} from '../../../shared/pod-workspace-types'
import { expandWorkspaceRoot, isPathInsideRoot } from './workspace-root-path'
import type { WorkspaceToolRunner } from './workspace-tool-runner'

export type DesktopDocumentsSync = 'on' | 'off' | 'unknown'

export type RootValidationDeps = {
  home: string
  readDesktopDocumentsSync: () => Promise<DesktopDocumentsSync>
  isDirectory?: (path: string) => Promise<boolean | null>
}

async function isDirectoryOnDisk(path: string): Promise<boolean | null> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return null
  }
}

export function iCloudDrivePath(home: string): string {
  return join(home, 'Library', 'Mobile Documents')
}

/** True when the path is iCloud Drive itself; cheap enough for synchronous defaults. */
export function isInsideICloudDrive(path: string, home: string): boolean {
  return isPathInsideRoot(path, iCloudDrivePath(home))
}

/**
 * Reads Finder's "Desktop & Documents Folders" switch without root. Keys absent (older macOS,
 * never signed in) or unreadable mean unknown, which warns instead of refusing.
 */
export async function readDesktopDocumentsSync(
  run: WorkspaceToolRunner
): Promise<DesktopDocumentsSync> {
  const read = async (key: string): Promise<string | null> => {
    const result = await run('defaults', ['read', 'com.apple.finder', key], { timeoutMs: 2_000 })
    return result.code === 0 ? result.stdout.trim() : null
  }
  const [desktop, documents] = await Promise.all([
    read('FXICloudDriveDesktop'),
    read('FXICloudDriveDocuments')
  ])
  if (desktop === '1' || documents === '1') {
    return 'on'
  }
  return desktop === '0' && documents === '0' ? 'off' : 'unknown'
}

export async function validateWorkspaceRoot(
  value: string,
  deps: RootValidationDeps
): Promise<PodWorkspaceRootValidation> {
  if (!value.trim()) {
    return { root: null, issues: [{ code: 'empty', severity: 'error' }] }
  }
  const root = expandWorkspaceRoot(value, deps.home)
  if (!root) {
    return { root: null, issues: [{ code: 'not-absolute', severity: 'error' }] }
  }
  const issues: PodWorkspaceRootIssue[] = []
  if ((await (deps.isDirectory ?? isDirectoryOnDisk)(root)) === false) {
    issues.push({ code: 'not-a-directory', severity: 'error' })
  }
  if (isInsideICloudDrive(root, deps.home)) {
    // Why refuse: iCloud evicts files to placeholders and syncs every node_modules write.
    issues.push({ code: 'icloud-drive', severity: 'error' })
  }
  const inDesktopOrDocuments =
    isPathInsideRoot(root, join(deps.home, 'Desktop')) ||
    isPathInsideRoot(root, join(deps.home, 'Documents'))
  if (inDesktopOrDocuments) {
    const sync = await deps.readDesktopDocumentsSync()
    if (sync === 'on') {
      issues.push({ code: 'icloud-desktop-documents', severity: 'error' })
    } else if (sync === 'unknown') {
      issues.push({ code: 'icloud-desktop-documents-unknown', severity: 'warning' })
    }
    // Why: launchd jobs (agents, the index daemon) hit a TCC prompt for these folders.
    issues.push({ code: 'documents-desktop-tcc', severity: 'warning' })
  }
  return { root, issues }
}

export function hasBlockingRootIssue(validation: PodWorkspaceRootValidation): boolean {
  return validation.root === null || validation.issues.some((issue) => issue.severity === 'error')
}
