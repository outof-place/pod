// Fork-only (Pod): session.tabs.restartTerminal in a one-app runtime. Its hidden window owns the
// failed shell's pane, so main asks the renderer to start the new shell there; a pane started by
// main would leave the window's pane unbound behind its "Terminal exited" overlay.
import { z } from 'zod'

export const POD_UI_HOST_PANE_RESTART_IPC = {
  /** main → renderer, (requestId, PodUiHostPaneRestartRequest) */
  restart: 'pod:uiHostPaneRestart:restart',
  /** renderer → main, (requestId, accepted: boolean) */
  restarted: 'pod:uiHostPaneRestart:restarted'
} as const

export const PodUiHostPaneRestartRequest = z
  .object({
    worktreeId: z.string().min(1),
    tabId: z.string().min(1),
    leafId: z.string().min(1)
  })
  .strict()
export type PodUiHostPaneRestartRequest = z.infer<typeof PodUiHostPaneRestartRequest>
