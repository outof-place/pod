import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import {
  LEGACY_WORKSPACE_ID,
  ensureOrcaDir,
  ensureWorkspaceTokenDir,
  getWorkspaceTokenPath
} from './linear-credential-paths'
import {
  clearLegacyViewerOnDisk,
  forgetLegacyViewer,
  resetLegacyViewerCache
} from './linear-legacy-viewer-store'
import { emptyWorkspaceFile } from './linear-workspace-record'
import {
  cacheToken,
  clearCredentialError,
  forgetCachedToken,
  getCachedToken,
  getWorkspaceFile,
  getWorkspaceState,
  recordCredentialError,
  resetCredentialCaches,
  resetWorkspaceFileCacheToEmpty,
  resolveWorkspaceId,
  upsertWorkspace,
  writeWorkspaceFile
} from './linear-workspace-registry'
import { CredentialDecryptionError } from '../integration-credential-file'
import { readPodLinearKey, writePodLinearKey } from '../pod/linear/pod-linear-key-store'
import type { LinearWorkspace } from '../../shared/linear/workspace-types'
import { readCredentialFileProtection } from '../credential-file-protection'
import type { SecretAtRestProtection } from '../../shared/secret-at-rest-protection'

// Fork-only (Pod): sealed and written atomically, or a thrown error; never plain text.
function writeEncryptedToken(path: string, apiKey: string): void {
  writePodLinearKey(path, apiKey)
}

export function saveWorkspaceToken(workspaceId: string, apiKey: string): void {
  ensureOrcaDir()
  if (workspaceId !== LEGACY_WORKSPACE_ID) {
    ensureWorkspaceTokenDir()
  }
  const tokenPath = getWorkspaceTokenPath(workspaceId)
  writeEncryptedToken(tokenPath, apiKey)
  cacheToken(workspaceId, apiKey)
  clearCredentialError(workspaceId)
}

// Backward-compatible export for the legacy single-workspace storage path.
export function saveToken(apiKey: string): void {
  saveWorkspaceToken(LEGACY_WORKSPACE_ID, apiKey)
}

export function loadToken(options: { force?: boolean; workspaceId?: string } = {}): string | null {
  const workspaceId = options.workspaceId ?? resolveWorkspaceId()
  if (!workspaceId) {
    return null
  }
  const cached = getCachedToken(workspaceId)
  if (cached !== undefined) {
    return cached
  }
  if (!options.force) {
    return null
  }
  const tokenPath = getWorkspaceTokenPath(workspaceId)
  if (!existsSync(tokenPath)) {
    return null
  }
  try {
    const raw = readFileSync(tokenPath)
    // Fork-only (Pod): no plain-text fallback on read either.
    const token = readPodLinearKey(raw)
    if (token) {
      cacheToken(workspaceId, token)
    }
    clearCredentialError(workspaceId)
    return token
  } catch (error) {
    if (error instanceof CredentialDecryptionError) {
      recordCredentialError(workspaceId, error.message)
      throw error
    }
    return null
  }
}

/** How a workspace's stored token sits on disk, or null when none is stored. */
export function getWorkspaceTokenProtection(workspaceId: string): SecretAtRestProtection | null {
  return readCredentialFileProtection(getWorkspaceTokenPath(workspaceId))
}

export function clearTokenFile(workspaceId: string): void {
  forgetCachedToken(workspaceId)
  try {
    unlinkSync(getWorkspaceTokenPath(workspaceId))
  } catch {
    // File may not exist — safe to ignore.
  }
}

export function clearToken(workspaceId?: string): void {
  if (!workspaceId) {
    const state = getWorkspaceState()
    for (const workspace of state.workspaces) {
      clearTokenFile(workspace.id)
    }
    resetCredentialCaches()
    resetLegacyViewerCache()
    resetWorkspaceFileCacheToEmpty()
    clearLegacyViewerOnDisk()
    writeWorkspaceFile(emptyWorkspaceFile())
    return
  }

  clearTokenFile(workspaceId)
  if (workspaceId === LEGACY_WORKSPACE_ID) {
    resetLegacyViewerCache()
    clearLegacyViewerOnDisk()
    return
  }

  const file = getWorkspaceFile()
  const workspaces = file.workspaces.filter((workspace) => workspace.id !== workspaceId)
  const activeWorkspaceId =
    file.activeWorkspaceId === workspaceId ? (workspaces[0]?.id ?? null) : file.activeWorkspaceId
  const selectedWorkspaceId =
    file.selectedWorkspaceId === workspaceId ? activeWorkspaceId : file.selectedWorkspaceId
  writeWorkspaceFile({
    version: 1,
    activeWorkspaceId,
    selectedWorkspaceId,
    workspaces
  })
}

export function replaceLegacyWorkspace(workspace: LinearWorkspace, token: string): void {
  saveWorkspaceToken(workspace.id, token)
  clearTokenFile(LEGACY_WORKSPACE_ID)
  clearLegacyViewerOnDisk()
  forgetLegacyViewer()
  upsertWorkspace(workspace, { select: true })
}
