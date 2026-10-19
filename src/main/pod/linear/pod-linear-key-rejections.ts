// Fork-only (Pod): workspaces whose key Linear rejected (an auth error). Pod keeps such a key and marks
// the workspace "needs a new key"; only Disconnect deletes a key. A new key, or a test that passes with
// the kept one, clears the mark. Kept in Pod's own store so the mark survives a restart.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeCredentialFileAtomic } from '../../integration-credential-file'
import { ensurePodLinearDir, podLinearStoreDir } from './pod-linear-key-store'

let cached: ReadonlySet<string> | null = null

function rejectionsPath(): string {
  return join(podLinearStoreDir(), 'rejected-keys.json')
}

function readRejections(): ReadonlySet<string> {
  if (cached) {
    return cached
  }
  const ids = new Set<string>()
  try {
    const parsed: unknown = JSON.parse(readFileSync(rejectionsPath(), 'utf-8'))
    const workspaceIds =
      parsed && typeof parsed === 'object' && 'workspaceIds' in parsed ? parsed.workspaceIds : null
    if (Array.isArray(workspaceIds)) {
      for (const id of workspaceIds) {
        if (typeof id === 'string') {
          ids.add(id)
        }
      }
    }
  } catch {
    // No file yet, or an unreadable one: nothing is marked.
  }
  cached = ids
  return ids
}

function writeRejections(ids: ReadonlySet<string>): void {
  ensurePodLinearDir(podLinearStoreDir())
  const file = { version: 1, workspaceIds: [...ids].sort() }
  writeCredentialFileAtomic(rejectionsPath(), Buffer.from(JSON.stringify(file, null, 2), 'utf-8'))
  cached = ids
}

export function isLinearKeyRejected(workspaceId: string): boolean {
  return readRejections().has(workspaceId)
}

export function markLinearKeyRejected(workspaceId: string): void {
  const ids = readRejections()
  if (!ids.has(workspaceId)) {
    writeRejections(new Set([...ids, workspaceId]))
  }
}

export function clearLinearKeyRejection(workspaceId: string): void {
  const ids = readRejections()
  if (ids.has(workspaceId)) {
    writeRejections(new Set([...ids].filter((id) => id !== workspaceId)))
  }
}

export function linearKeyRejectedMessage(organizationName: string): string {
  return `Linear rejected the saved key for ${organizationName}. Enter a new key.`
}
