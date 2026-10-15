// Fork-only (Pod): the desktop's session-log delete for runtime RPC. The delete trashes through
// Electron's shell, so the Electron side installs it (install-pod-ai-vault-session-delete.ts).
import type {
  AiVaultDeleteSessionArgs,
  AiVaultDeleteSessionResult
} from '../../../shared/ai-vault-session-deletion'

export type PodAiVaultSessionDelete = (
  args: AiVaultDeleteSessionArgs
) => Promise<AiVaultDeleteSessionResult>

let installed: PodAiVaultSessionDelete | null = null

export function setPodAiVaultSessionDelete(remove: PodAiVaultSessionDelete | null): void {
  installed = remove
}

/** Null where Electron isn't (orcad). */
export function getPodAiVaultSessionDelete(): PodAiVaultSessionDelete | null {
  return installed
}
