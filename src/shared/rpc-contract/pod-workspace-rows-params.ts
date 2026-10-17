// Fork-only (Pod): host.setDisplayLabel and repo.removeSparsePreset, for PodNative's sidebar rows.
import { z } from 'zod'
import { requiredString } from './rpc-param-primitives'
import { RepoSelector } from './github-repo-target-params'
import { ExecutionHostId } from './automation-params'

export const HOST_DISPLAY_LABEL_MAX_LENGTH = 256
export const SPARSE_PRESET_ID_MAX_LENGTH = 256

export const HostSetDisplayLabelParams = z
  .object({
    hostId: ExecutionHostId,
    // Null or blank clears the rename, as the sidebar's Rename dialog does.
    displayLabel: z.string().max(HOST_DISPLAY_LABEL_MAX_LENGTH).nullable()
  })
  .strict()

export const RepoSparsePresetRemove = RepoSelector.extend({
  presetId: requiredString('Missing preset id').pipe(
    z.string().max(SPARSE_PRESET_ID_MAX_LENGTH, 'Preset id too long')
  )
})
