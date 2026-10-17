// Fork-only (Pod): podImport.* — "Import from Orca" for this Mac's own Pod clients.
import { defineMethod, type RpcContext } from '../../runtime/rpc/core'
import { assertLocalRpcCaller } from '../../runtime/rpc/methods/pod-local-caller'
import { POD_ORCA_IMPORT_RPC } from '../../../shared/pod-orca-import-types'
import {
  PodOrcaImportApplyParams,
  PodOrcaImportPreviewParams
} from '../../../shared/rpc-contract/pod-orca-import-params'
import { getAppBundleId } from '../../../shared/app-identity'
import { getOrcaImportService } from './orca-import-service'

// A build without the import (no Orca lineage) still answers, as a refusal, for the advertised capability.
const NOT_HERE = { reason: 'no-legacy-identity' } as const

type ApplyOrigin = 'desktop' | 'podnative' | 'owner-token'

/** Pod's classic window, or PodNative by the kernel's audit token; never just the owner token. */
export function applyOrigin(ctx: Pick<RpcContext, 'caller' | 'podNativePeer'>): ApplyOrigin {
  if (ctx.caller?.kind === 'desktop') {
    return 'desktop'
  }
  return ctx.podNativePeer?.().ok === true ? 'podnative' : 'owner-token'
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
      const origin = applyOrigin(ctx)
      // Why a stderr line: a signed-package run reads from it whether PodNative's apply carried its
      // audit token. Only the origin and this runtime's id: no token, no path.
      console.warn(
        `[orca-import] apply from Pod's window: ${origin === 'owner-token' ? 'no' : 'yes'} (${origin}, runtime ${getAppBundleId()})`
      )
      return service
        ? service.apply(params.previewId, params.itemIds, origin !== 'owner-token')
        : { status: 'refused', ...NOT_HERE }
    }
  })
]
