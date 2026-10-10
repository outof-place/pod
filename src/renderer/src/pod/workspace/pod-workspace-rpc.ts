// Fork-only (Pod): a thin client of the podWorkspace.* runtime RPC methods; the native shell calls the same ones.
import {
  POD_WORKSPACE_RPC,
  type PodWorkspaceExcludeResult,
  type PodWorkspaceRootValidation,
  type PodWorkspaceStatusReply
} from '../../../../shared/pod-workspace-types'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'

// The workspace root lives on this Mac, so these always go to the local runtime.
const LOCAL = { kind: 'local' } as const
// Every change is the user's own click.
const USER = { reason: 'user' } as const

function call<T>(method: string, params?: unknown): Promise<T> {
  return callRuntimeRpc<T>(LOCAL, method, params)
}

export const podWorkspaceRpc = {
  isEnabled: async (): Promise<boolean> =>
    (await call<{ enabled: boolean }>(POD_WORKSPACE_RPC.enabled)).enabled,
  getStatus: (refresh: boolean): Promise<PodWorkspaceStatusReply> =>
    call(POD_WORKSPACE_RPC.status, { refresh }),
  validateRoot: (value: string): Promise<PodWorkspaceRootValidation> =>
    call(POD_WORKSPACE_RPC.validateRoot, { value }),
  excludeBuildFolders: (planId: string): Promise<PodWorkspaceExcludeResult> =>
    call(POD_WORKSPACE_RPC.excludeBuildFolders, { planId, ...USER }),
  openSpotlightSettings: async (): Promise<boolean> =>
    (await call<{ opened: boolean }>(POD_WORKSPACE_RPC.openSpotlightSettings, USER)).opened,
  /** Parent folder for a clone of `url`; null keeps Orca's default. */
  getCloneDestination: async (url: string): Promise<string | null> =>
    (await call<{ destination: string | null }>(POD_WORKSPACE_RPC.cloneDestination, { url }))
      .destination
}
