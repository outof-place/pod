// Fork-only (Pod): podImport.* — "Import from Orca" for this Mac's own Pod clients.
import { defineMethod, type RpcContext } from '../../runtime/rpc/core'
import { assertLocalRpcCaller } from '../../runtime/rpc/methods/pod-local-caller'
import { POD_ORCA_IMPORT_RPC } from '../../../shared/pod-orca-import-types'
import {
  PodOrcaImportApplyParams,
  PodOrcaImportPreviewParams
} from '../../../shared/rpc-contract/pod-orca-import-params'
import { getOrcaImportService } from './orca-import-service'

// A build without the import (no Orca lineage) still answers, as a refusal, for the advertised capability.
const NOT_HERE = { reason: 'no-legacy-identity' } as const

/** Pod's classic window, or PodNative by the kernel's audit token; never just the owner token. */
function fromPodWindow(ctx: Pick<RpcContext, 'caller' | 'podNativePeer'>): boolean {
  return ctx.caller?.kind === 'desktop' || ctx.podNativePeer?.().ok === true
}

// Why host-admin and local-only: it reads another app's profile on this Mac and adds projects and
// settings to this one; no paired device or SSH host may start it. Apply in the user's own Pod
// also needs Pod's window (orca-import-service.ts).
export const POD_ORCA_IMPORT_METHODS = [
  defineMethod({
    name: POD_ORCA_IMPORT_RPC.detect,
    permission: 'host-admin',
    params: null,
    handler: (_params, ctx) => {
      assertLocalRpcCaller(ctx, POD_ORCA_IMPORT_RPC.detect)
      return getOrcaImportService()?.detect() ?? { found: false, refused: NOT_HERE.reason }
    }
  }),
  defineMethod({
    name: POD_ORCA_IMPORT_RPC.preview,
    permission: 'host-admin',
    params: PodOrcaImportPreviewParams,
    handler: (params, ctx) => {
      assertLocalRpcCaller(ctx, POD_ORCA_IMPORT_RPC.preview)
      return getOrcaImportService()?.preview(params.profileId) ?? { status: 'refused', ...NOT_HERE }
    }
  }),
  defineMethod({
    name: POD_ORCA_IMPORT_RPC.apply,
    permission: 'host-admin',
    params: PodOrcaImportApplyParams,
    handler: async (params, ctx) => {
      assertLocalRpcCaller(ctx, POD_ORCA_IMPORT_RPC.apply)
      const service = getOrcaImportService()
      return service
        ? service.apply(params.previewId, params.itemIds, fromPodWindow(ctx))
        : { status: 'refused', ...NOT_HERE }
    }
  })
]
