// Fork-only (Pod): `terminal.processes`, the pids behind this Mac's terminals.
import { defineMethod, type RpcContext } from '../../runtime/rpc/core'
import type { PodTerminalProcessesResult } from '../../../shared/pod-terminal-processes-types'
import {
  isPodTerminalProcessesEnabled,
  listPodTerminalProcesses,
  type PodTerminalPlacement
} from './pod-terminal-processes'

const PLACEMENT_LIMIT = 1_000

/** The runtime's terminal records: worktree and handle for PTYs whose id doesn't say. */
async function runtimePlacements(context: RpcContext): Promise<Map<string, PodTerminalPlacement>> {
  const { terminals } = await context.runtime.listTerminals(undefined, PLACEMENT_LIMIT)
  return new Map(
    terminals.flatMap((terminal) =>
      terminal.ptyId
        ? [[terminal.ptyId, { worktreeId: terminal.worktreeId, handle: terminal.handle }] as const]
        : []
    )
  )
}

// Why host-admin: pids and worktrees of every terminal on the Mac, which only the desktop's own
// clients may read; phones and SSH hosts are refused.
export function createPodTerminalProcessesMethods(
  enabled: () => boolean = () => isPodTerminalProcessesEnabled(),
  list: (context: RpcContext) => Promise<PodTerminalProcessesResult['terminals']> = async (
    context
  ) => listPodTerminalProcesses(undefined, await runtimePlacements(context))
) {
  return [
    defineMethod({
      name: 'terminal.processes',
      permission: 'host-admin',
      params: null,
      handler: async (_params, context): Promise<PodTerminalProcessesResult> => {
        if (!enabled()) {
          throw new Error('Terminal processes are not reported in this build.')
        }
        return { terminals: await list(context) }
      }
    })
  ]
}

export const POD_TERMINAL_PROCESSES_METHODS = createPodTerminalProcessesMethods()
