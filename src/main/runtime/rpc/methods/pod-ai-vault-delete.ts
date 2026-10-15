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
  // Why host-admin: it deletes files, and an SSH host's CLI with remote control on holds `workspace`.
  // A paired device is refused below as well, since the IPC it twins was local.
  defineMethod({
    name: 'aiVault.deleteSession',
    permission: 'host-admin',
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
