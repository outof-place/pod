// Fork-only (Pod): one-app's quit between the runtime's main process and its renderer. PodNative
// asks to quit over the control socket (src/main/pod/ui-host); before the quit commits, main asks
// the renderer what quitting would lose, so PodNative can ask the user in its own window. The
// renderer's quit prompts never show in one-app: they would open in a hidden window.
import { z } from 'zod'

export const POD_UI_HOST_QUIT_IPC = {
  /** main → renderer, (requestId): what would a quit lose? */
  assess: 'pod:uiHostQuit:assess',
  /** renderer → main, (requestId, PodUiHostQuitBlockers | null) */
  assessed: 'pod:uiHostQuit:assessed',
  /** main → renderer: the quit is committed; the renderer's own quit prompts stand down. */
  commit: 'pod:uiHostQuit:commit'
} as const

export const PodUiHostQuitBlockers = z
  .object({
    /** Editor tabs with unsaved changes. */
    unsavedFiles: z.number().int().min(0).max(100_000),
    /** Work on a remote host a quit would leave: still running, or a host that didn't answer. */
    remoteWork: z.enum(['none', 'running', 'unverifiable'])
  })
  .strict()
export type PodUiHostQuitBlockers = z.infer<typeof PodUiHostQuitBlockers>
