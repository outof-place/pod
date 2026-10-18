// Fork-only (Pod): co-browse's pane verbs (feature browserCobrowse). PodNative sends them only to a
// runtime whose welcome lists the feature; only a page PodNative watches gets the pushes. Mirrored
// in PodRuntime/BrowserCobrowse.swift (outof-place/pod-native).
import { z } from 'zod'
import type { CobrowseBox, CobrowseMarkState } from '../../../shared/browser-cobrowse-types'
import { COBROWSE_LIMITS } from '../../../shared/browser-cobrowse-types'

const PageId = z.string().min(1).max(200)
const Coordinate = z.number().finite().min(-100_000).max(100_000)
const Length = z.number().finite().min(0).max(100_000)

const Watch = z
  .object({ type: z.literal('browserCobrowse'), pageId: PageId, watch: z.boolean() })
  .strict()

const MarkMode = z
  .object({ type: z.literal('browserMarkMode'), pageId: PageId, on: z.boolean() })
  .strict()

// seq: PodNative's own count, echoed in the answer so a refresh push is not taken for it.
const Hover = z
  .object({
    type: z.literal('browserHover'),
    pageId: PageId,
    x: Coordinate,
    y: Coordinate,
    seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional()
  })
  .strict()

const HoverEnd = z.object({ type: z.literal('browserHoverEnd'), pageId: PageId }).strict()

// x, y, width, height: view coordinates as browserInput's; width and height 0 mark the element at x, y.
const MarkAdd = z
  .object({
    type: z.literal('browserMarkAdd'),
    pageId: PageId,
    markId: z.uuid(),
    x: Coordinate,
    y: Coordinate,
    width: Length,
    height: Length
  })
  .strict()

const MarkNote = z
  .object({
    type: z.literal('browserMarkNote'),
    pageId: PageId,
    markId: z.uuid(),
    // UTF-16 units: COBROWSE_LIMITS.note code points (PodNative's Unicode scalars) take up to twice that.
    note: z.string().max(COBROWSE_LIMITS.note * 2)
  })
  .strict()

const MarkRemove = z
  .object({ type: z.literal('browserMarkRemove'), pageId: PageId, markId: z.uuid() })
  .strict()

const MarksSend = z.object({ type: z.literal('browserMarksSend'), pageId: PageId }).strict()

export const POD_BROWSER_COBROWSE_CLIENT_MESSAGES = [
  Watch,
  MarkMode,
  Hover,
  HoverEnd,
  MarkAdd,
  MarkNote,
  MarkRemove,
  MarksSend
] as const

export type PodBrowserCobrowseClientMessage =
  | z.infer<typeof Watch>
  | z.infer<typeof MarkMode>
  | z.infer<typeof Hover>
  | z.infer<typeof HoverEnd>
  | z.infer<typeof MarkAdd>
  | z.infer<typeof MarkNote>
  | z.infer<typeof MarkRemove>
  | z.infer<typeof MarksSend>

// Boxes are view coordinates (CSS px times the page's zoom); null while the element is off the page.
export type PodBrowserCobrowseServerMessage =
  | { type: 'browserHover'; pageId: string; rect: CobrowseBox | null; label: string; seq?: number }
  // A browserMarkAdd that made no mark (the page is full, nothing there): PodNative shows why.
  | { type: 'browserMarkRefused'; pageId: string; markId: string; reason: string }
  | {
      type: 'browserCobrowseState'
      pageId: string
      agentWaiting: boolean
      marks: {
        id: string
        n: number
        note: string
        state: CobrowseMarkState
        kind: 'element' | 'region'
        label: string
        rect: CobrowseBox | null
      }[]
      pointers: { id: string; label: string; rect: CobrowseBox | null }[]
    }

// Why a browserMarkAdd made no mark, as PodNative's hint line shows it.
export const COBROWSE_REFUSALS = {
  full: `This page holds ${COBROWSE_LIMITS.marksPerPage} marks no agent took yet: send or clear some first.`,
  nothing: 'Nothing on the page there to mark.',
  gone: 'The page is gone.',
  failed: 'Could not read the page there.'
} as const

const COBROWSE_TYPES = new Set<string>(
  POD_BROWSER_COBROWSE_CLIENT_MESSAGES.map((s) => s.shape.type.value)
)

export function isPodBrowserCobrowseMessage(message: {
  type: string
}): message is PodBrowserCobrowseClientMessage {
  return COBROWSE_TYPES.has(message.type)
}
