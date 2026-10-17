// Fork-only (Pod): podImport.* — "Import from Orca" for this Mac's own Pod clients.
import { defineMethod } from '../../runtime/rpc/core'
import { assertLocalRpcCaller } from '../../runtime/rpc/methods/pod-local-caller'
import { POD_ORCA_IMPORT_RPC } from '../../../shared/pod-orca-import-types'
import {
  PodOrcaImportApplyParams,
  PodOrcaImportPreviewParams
} from '../../../shared/rpc-contract/pod-orca-import-params'
import { getOrcaImportService, type OrcaImportService } from './orca-import-service'

function service(): OrcaImportService {
  const value = getOrcaImportService()
  if (!value) {
    // Why no app name: RPC errors are branded, and "Orca" would read as "Pod" there.
    throw new Error('This build has no import.')
  }
  return value
}

// Why host-admin and local-only: it reads another app's profile on this Mac and adds projects and
// settings to this one; no paired device or SSH host may start it.
export const POD_ORCA_IMPORT_METHODS = [
  defineMethod({
    name: POD_ORCA_IMPORT_RPC.detect,
    permission: 'host-admin',
    params: null,
    handler: (_params, ctx) => {
      assertLocalRpcCaller(ctx, POD_ORCA_IMPORT_RPC.detect)
      return service().detect()
    }
  }),
  defineMethod({
    name: POD_ORCA_IMPORT_RPC.preview,
    permission: 'host-admin',
    params: PodOrcaImportPreviewParams,
    handler: (params, ctx) => {
      assertLocalRpcCaller(ctx, POD_ORCA_IMPORT_RPC.preview)
      return service().preview(params.profileId)
    }
  }),
  defineMethod({
    name: POD_ORCA_IMPORT_RPC.apply,
    permission: 'host-admin',
    params: PodOrcaImportApplyParams,
    handler: (params, ctx) => {
      assertLocalRpcCaller(ctx, POD_ORCA_IMPORT_RPC.apply)
      return service().apply(params.previewId, params.itemIds)
    }
  })
]
