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
import {
  decodeLinearKeyRecord,
  encodeLinearKeyRecord,
  forgetLinearConnectionId,
  newLinearConnectionId,
  rememberLinearConnectionId
} from '../pod/linear/pod-linear-key-record'
import {
  clearLinearKeyRejection,
  markLinearKeyRejected
} from '../pod/linear/pod-linear-key-rejections'
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
  // Fork-only (Pod): sealed with a new connection id (pod-linear-key-record.ts).
  const connectionId = newLinearConnectionId()
  writeEncryptedToken(tokenPath, encodeLinearKeyRecord(apiKey, connectionId))
  rememberLinearConnectionId(workspaceId, connectionId)
  cacheToken(workspaceId, apiKey)
  clearCredentialError(workspaceId)
  // Fork-only (Pod): a new key, or a kept one that passed a test, no longer needs replacing.
  clearLinearKeyRejection(workspaceId)
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
    // Fork-only (Pod): no plain-text fallback on read either; the key comes with its connection id.
    const stored = readPodLinearKey(raw)
    const record = stored === null ? null : decodeLinearKeyRecord(stored)
    if (record) {
      rememberLinearConnectionId(workspaceId, record.connectionId)
    }
    const token = record?.key ?? null
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
  forgetLinearConnectionId(workspaceId)
  try {
    unlinkSync(getWorkspaceTokenPath(workspaceId))
  } catch {
    // File may not exist — safe to ignore.
  }
  clearLinearKeyRejection(workspaceId)
}

// Fork-only (Pod): every Linear call that gets an auth error lands here. Upstream deletes the key;
// Pod keeps it and marks the workspace "needs a new key". Disconnect deletes, with removeToken.
// Only the workspace whose key was refused: without one, nothing is marked.
export function clearToken(workspaceId?: string): void {
  if (!workspaceId) {
    return
  }
  forgetCachedToken(workspaceId)
  markLinearKeyRejected(workspaceId)
}

export function removeToken(workspaceId?: string): void {
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
