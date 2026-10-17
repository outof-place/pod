// Fork-only (Pod): session.tabs.updatePaneLayout from PodNative in a one-app runtime. The hidden
// window's renderer owns its tabs' pane geometry and republishes it, so main hands the layout over
// instead of writing beside the window. Nothing here focuses or shows anything.
import { z } from 'zod'
import { TerminalPaneLayoutNodeSchema } from './rpc-contract/session-tabs-schemas-params'

export const POD_UI_HOST_PANE_LAYOUT_IPC = {
  /** main → renderer, (requestId, PodUiHostPaneLayoutRequest) */
  apply: 'pod:uiHostPaneLayout:apply',
  /** renderer → main, (requestId, PodUiHostPaneLayoutReply) */
  applied: 'pod:uiHostPaneLayout:applied'
} as const

export const PodUiHostPaneLayoutRequest = z
  .object({
    worktreeId: z.string().min(1),
    tabId: z.string().min(1),
    /** Null keeps the tab's splits. */
    root: z.union([z.null(), TerminalPaneLayoutNodeSchema]),
    /** Null collapses an expanded pane, as session.tabs.updatePaneLayout without one does. */
    expandedLeafId: z.string().min(1).nullable(),
    /** Undefined keeps the active pane. */
    activeLeafId: z.string().min(1).optional()
  })
  .strict()
export type PodUiHostPaneLayoutRequest = z.infer<typeof PodUiHostPaneLayoutRequest>

const PodUiHostPaneLayoutReply = z.discriminatedUnion('applied', [
  z.object({ applied: z.literal(true) }),
  z.object({
    applied: z.literal(false),
    reason: z.enum(['tab_not_found', 'layout_mismatch', 'leaf_not_found', 'active_leaf_not_ready'])
  })
])
export type PodUiHostPaneLayoutReply = z.infer<typeof PodUiHostPaneLayoutReply>

/** The renderer's reply off IPC; null for anything else. */
export function readPodUiHostPaneLayoutReply(value: unknown): PodUiHostPaneLayoutReply | null {
  const parsed = PodUiHostPaneLayoutReply.safeParse(value)
  return parsed.success ? parsed.data : null
}
