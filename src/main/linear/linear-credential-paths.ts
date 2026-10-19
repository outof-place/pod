import { join } from 'node:path'
import { ensurePodLinearDir, podLinearStoreDir } from '../pod/linear/pod-linear-key-store'

export const LEGACY_WORKSPACE_ID = 'legacy'

// Fork-only (Pod): Linear's files live in Pod's userData, never in ~/.orca, which Orca.app owns.
function getLinearStoreDir(): string {
  return podLinearStoreDir()
}

function getLegacyTokenPath(): string {
  return join(getLinearStoreDir(), 'linear-token.enc')
}

export function getLegacyViewerPath(): string {
  return join(getLinearStoreDir(), 'linear-viewer.json')
}

export function getWorkspaceFilePath(): string {
  return join(getLinearStoreDir(), 'linear-workspaces.json')
}

function getWorkspaceTokenDir(): string {
  return join(getLinearStoreDir(), 'linear-tokens')
}

export function getWorkspaceTokenPath(workspaceId: string): string {
  if (workspaceId === LEGACY_WORKSPACE_ID) {
    return getLegacyTokenPath()
  }
  return join(getWorkspaceTokenDir(), `${Buffer.from(workspaceId).toString('base64url')}.enc`)
}

// Fork-only (Pod): both directories are owner-only (0700).
export function ensureOrcaDir(): void {
  ensurePodLinearDir(getLinearStoreDir())
}

export function ensureWorkspaceTokenDir(): void {
  ensurePodLinearDir(getWorkspaceTokenDir())
}
