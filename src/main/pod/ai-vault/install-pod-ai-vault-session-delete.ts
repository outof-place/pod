// Fork-only (Pod): the AI vault's Delete for runtime RPC, with the caches its IPC handler drops.
import { deleteAiVaultSession } from '../../ipc/ai-vault-delete'
import { invalidateAiVaultHostLegCache } from '../../ipc/ai-vault-host-leg-cache'
import { setPodAiVaultSessionDelete } from './pod-ai-vault-session-delete'

/**
 * At startup, not with the IPC handlers: a headless runtime registers those only when a window
 * attaches, and PodNative's AI vault works without one.
 */
export function installPodAiVaultSessionDelete(): void {
  // The same deps as ai-vault.ts's aiVaultDeleteDeps.
  setPodAiVaultSessionDelete((args) =>
    deleteAiVaultSession(args, { invalidateMultiHostListCache: invalidateAiVaultHostLegCache })
  )
}
