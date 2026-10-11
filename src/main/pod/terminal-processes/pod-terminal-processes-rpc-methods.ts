// Fork-only (Pod): `terminal.processes`, the pids behind this Mac's terminals.
import { defineMethod } from '../../runtime/rpc/core'
import type { PodTerminalProcessesResult } from '../../../shared/pod-terminal-processes-types'
import { isPodTerminalProcessesEnabled, listPodTerminalProcesses } from './pod-terminal-processes'

// Why host-admin: pids and worktrees of every terminal on the Mac, which only the desktop's own
// clients may read; phones and SSH hosts are refused.
export function createPodTerminalProcessesMethods(
  enabled: () => boolean = () => isPodTerminalProcessesEnabled(),
  list: () => Promise<PodTerminalProcessesResult['terminals']> = () => listPodTerminalProcesses()
) {
  return [
    defineMethod({
      name: 'terminal.processes',
      permission: 'host-admin',
      params: null,
      handler: async (): Promise<PodTerminalProcessesResult> => {
        if (!enabled()) {
          throw new Error('Terminal processes are not reported in this build.')
        }
        return { terminals: await list() }
      }
    })
  ]
}

export const POD_TERMINAL_PROCESSES_METHODS = createPodTerminalProcessesMethods()
