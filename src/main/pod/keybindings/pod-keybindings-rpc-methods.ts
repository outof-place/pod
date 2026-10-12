// Fork-only (Pod): keybindings.effective, read-only; changes arrive as clientEvents' keybindingsChanged.
import { defineMethod } from '../../runtime/rpc/core'
import { readPodKeybindings } from './install-pod-keybindings'

export const POD_KEYBINDINGS_METHODS = [
  defineMethod({
    name: 'keybindings.effective',
    permission: 'workspace',
    params: null,
    handler: () => readPodKeybindings()
  })
]
