// Fork-only (Pod): Computer Use's Reset access over RPC, for PodNative's Computer Use settings.
import { defineMethod } from '../../runtime/rpc/core'
import { assertLocalRpcCaller } from '../../runtime/rpc/methods/pod-local-caller'
import { ComputerPermissionsResetParams } from '../../../shared/rpc-contract/pod-computer-use-params'

// Why desktop-control: computer.permissions' family; a paired client holds it only when granted at
// pairing and an SSH host's CLI never, and the local-caller check refuses paired devices as well.
export const POD_COMPUTER_USE_RESET_METHODS = [
  defineMethod({
    name: 'computer.permissionsReset',
    permission: 'desktop-control',
    params: ComputerPermissionsResetParams,
    handler: async (_params, ctx) => {
      assertLocalRpcCaller(ctx, 'computer.permissionsReset')
      // The IPC's own call (computerUsePermissions:reset), with no arguments.
      const { resetComputerUsePermissions } =
        await import('../../computer/macos-computer-use-permissions')
      return resetComputerUsePermissions()
    }
  })
]
