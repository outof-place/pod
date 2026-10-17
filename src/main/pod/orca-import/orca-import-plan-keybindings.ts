// Fork-only (Pod): Orca's shortcut overrides that Pod's own keybindings file doesn't have yet.
import { existsSync, realpathSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import {
  isKeybindingActionId,
  type KeybindingActionId,
  type KeybindingOverrides
} from '../../../shared/keybindings'
import type { PodOrcaImportItem } from '../../../shared/pod-orca-import-types'
import { readKeybindingFile } from '../../keybindings/keybinding-file'
import { displayValue } from './orca-import-plan-settings'

export type KeybindingAction = {
  kind: 'keybinding'
  actionId: KeybindingActionId
  bindings: string[]
}

export type PlannedKeybindingItem = { item: PodOrcaImportItem; action: KeybindingAction | null }

export const SHARED_KEYBINDINGS_ITEM_ID = 'keybindings:shared'

function sameFile(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right)
  } catch {
    return left === right
  }
}

/** Null when Orca has no keybindings file; one `shared` row while Pod reads Orca's own file. */
export function planKeybindings(
  orcaPath: string | null,
  podPath: string,
  platform: NodeJS.Platform = process.platform
): PlannedKeybindingItem[] {
  if (orcaPath === null || sameFile(orcaPath, podPath)) {
    return orcaPath === null
      ? []
      : [
          {
            item: {
              id: SHARED_KEYBINDINGS_ITEM_ID,
              kind: 'keybinding',
              state: 'shared',
              title: 'Keyboard shortcuts',
              detail: podPath,
              selected: false
            },
            action: null
          }
        ]
  }
  if (!existsSync(orcaPath)) {
    return []
  }
  const orca: KeybindingOverrides = readKeybindingFile(orcaPath, platform).overrides
  const pod: KeybindingOverrides = readKeybindingFile(podPath, platform).overrides
  const planned: PlannedKeybindingItem[] = []
  for (const [actionId, bindings] of Object.entries(orca)) {
    if (!bindings || !isKeybindingActionId(actionId)) {
      continue
    }
    const id = actionId
    const current = pod[id]
    const state =
      current === undefined ? 'new' : isDeepStrictEqual(current, bindings) ? 'present' : 'conflict'
    planned.push({
      item: {
        id: `keybinding:${id}`,
        kind: 'keybinding',
        state,
        title: id,
        orcaValue: displayValue(bindings),
        ...(current === undefined ? {} : { podValue: displayValue(current) }),
        selected: state === 'new'
      },
      action: state === 'present' ? null : { kind: 'keybinding', actionId: id, bindings }
    })
  }
  return planned
}
