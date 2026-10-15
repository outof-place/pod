// Fork-only (Pod): the AI vault's Delete over RPC, for PodNative's session view.
import { defineMethod } from '../core'
import { getPodAiVaultSessionDelete } from '../../../pod/ai-vault/pod-ai-vault-session-delete'
import { AiVaultDeleteSessionParams } from '../../../../shared/rpc-contract/pod-ai-vault-params'
import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId
} from '../../../../shared/execution-host'
import { assertLocalRpcCaller } from './pod-local-caller'

export const POD_AI_VAULT_METHODS = [
  // Why workspace: the AI vault's own family; a paired device is refused below, as its IPC was local.
  defineMethod({
    name: 'aiVault.deleteSession',
    permission: 'workspace',
    params: AiVaultDeleteSessionParams,
    handler: (params, ctx) => {
      assertLocalRpcCaller(ctx, 'aiVault.deleteSession')
      const remove = getPodAiVaultSessionDelete()
      if (!remove) {
        throw new Error('runtime_unavailable')
      }
      // Moves the log (and its companions) to the Trash; an unknown host id stays non-local.
      return remove({
        agent: params.agent,
        filePath: params.filePath,
        sessionId: params.sessionId,
        executionHostId:
          normalizeExecutionHostId(params.executionHostId ?? LOCAL_EXECUTION_HOST_ID) ?? undefined
      })
    }
  })
]
