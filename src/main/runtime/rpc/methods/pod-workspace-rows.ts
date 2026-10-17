// Fork-only (Pod): the sidebar's host rename and sparse-preset Delete over RPC, for PodNative's rows.
import { defineMethod } from '../core'
import {
  HostSetDisplayLabelParams,
  RepoSparsePresetRemove
} from '../../../../shared/rpc-contract/pod-workspace-rows-params'

export const POD_WORKSPACE_ROW_METHODS = [
  // Why settings-write: the label lives in the host's GlobalSettings, beside what settings.update writes.
  defineMethod({
    name: 'host.setDisplayLabel',
    permission: 'settings-write',
    params: HostSetDisplayLabelParams,
    handler: (params, { runtime }) => ({
      hostSettingOverrides: runtime.setClientHostDisplayLabel(params.hostId, params.displayLabel)
    })
  }),
  defineMethod({
    name: 'repo.removeSparsePreset',
    permission: 'workspace',
    params: RepoSparsePresetRemove,
    handler: async (params, { runtime }) =>
      await runtime.removeSparsePreset(params.repo, params.presetId)
  })
]
