// Fork-only (Pod): the browser pane's verbs on the one-app control socket. PodNative shows an
// offscreen page in a native pane: frames arrive over Mach (native/pod-peer-identity-macos
// browser_frames.c), and these lines carry everything else. PodNative mirrors them in
// PodRuntime/BrowserPaneProtocol.swift (outof-place/pod-native).
import { z } from 'zod'

const PageId = z.string().min(1).max(200)
const Size = z.number().int().min(1).max(8192)
const Scale = z.number().min(1).max(4)
const Coordinate = z.number().finite().min(-100_000).max(100_000)
const Delta = z.number().finite().min(-100_000).max(100_000)
const Modifiers = z
  .array(z.enum(['shift', 'control', 'alt', 'meta', 'capsLock', 'isAutoRepeat']))
  .max(6)

// PodNative's own launchd name for this launch, random, handed over the authenticated socket.
export const POD_BROWSER_RENDEZVOUS_PATTERN = /^codes\.pod\.native(\.dev)?\.browser\.[0-9a-f]{32}$/

const Rendezvous = z
  .object({
    type: z.literal('browserRendezvous'),
    service: z.string().regex(POD_BROWSER_RENDEZVOUS_PATTERN)
  })
  .strict()

const Attach = z
  .object({
    type: z.literal('browserAttach'),
    pageId: PageId,
    token: z.number().int().min(1).max(2_147_483_647),
    width: Size,
    height: Size,
    scale: Scale
  })
  .strict()

const Detach = z.object({ type: z.literal('browserDetach'), pageId: PageId }).strict()

const Resize = z
  .object({
    type: z.literal('browserResize'),
    pageId: PageId,
    width: Size,
    height: Size,
    scale: Scale
  })
  .strict()

const MouseEvent = z
  .object({
    kind: z.literal('mouse'),
    action: z.enum(['down', 'up', 'move', 'enter', 'leave']),
    x: Coordinate,
    y: Coordinate,
    button: z.enum(['left', 'right', 'middle']),
    clickCount: z.number().int().min(0).max(3),
    modifiers: Modifiers
  })
  .strict()

const WheelEvent = z
  .object({
    kind: z.literal('wheel'),
    x: Coordinate,
    y: Coordinate,
    deltaX: Delta,
    deltaY: Delta,
    precise: z.boolean(),
    modifiers: Modifiers
  })
  .strict()

const KeyEvent = z
  .object({
    kind: z.literal('key'),
    action: z.enum(['down', 'up', 'char']),
    keyCode: z.string().min(1).max(32),
    modifiers: Modifiers
  })
  .strict()

const TextEvent = z.object({ kind: z.literal('text'), text: z.string().min(1).max(4096) }).strict()

export const PodBrowserInputEvent = z.discriminatedUnion('kind', [
  MouseEvent,
  WheelEvent,
  KeyEvent,
  TextEvent
])
export type PodBrowserInputEvent = z.infer<typeof PodBrowserInputEvent>

const Input = z
  .object({ type: z.literal('browserInput'), pageId: PageId, event: PodBrowserInputEvent })
  .strict()

const Navigate = z.discriminatedUnion('action', [
  z
    .object({
      type: z.literal('browserNavigate'),
      pageId: PageId,
      action: z.enum(['back', 'forward', 'reload', 'stop'])
    })
    .strict(),
  z
    .object({
      type: z.literal('browserNavigate'),
      pageId: PageId,
      action: z.literal('load'),
      url: z.string().min(1).max(8192)
    })
    .strict()
])

const Find = z
  .object({
    type: z.literal('browserFind'),
    pageId: PageId,
    text: z.string().min(1).max(1024),
    forward: z.boolean(),
    findNext: z.boolean()
  })
  .strict()

const FindStop = z.object({ type: z.literal('browserFindStop'), pageId: PageId }).strict()

const Focus = z
  .object({ type: z.literal('browserFocus'), pageId: PageId, focused: z.boolean() })
  .strict()

const DevTools = z.object({ type: z.literal('browserDevTools'), pageId: PageId }).strict()

// PodNative's pick from a <select> menu the runtime reported (browserPopupMenu); -1 closes it.
const PopupChoose = z
  .object({
    type: z.literal('browserPopupChoose'),
    pageId: PageId,
    menuId: z.number().int().min(1).max(2_147_483_647),
    index: z.number().int().min(-1).max(10_000)
  })
  .strict()

/** Every browser verb, for the socket's discriminated union of client messages. */
export const POD_BROWSER_PANE_CLIENT_MESSAGES = [
  Rendezvous,
  Attach,
  Detach,
  Resize,
  Input,
  Navigate,
  Find,
  FindStop,
  Focus,
  DevTools,
  PopupChoose
] as const

export type PodBrowserPaneClientMessage =
  | z.infer<typeof Rendezvous>
  | z.infer<typeof Attach>
  | z.infer<typeof Detach>
  | z.infer<typeof Resize>
  | z.infer<typeof Input>
  | z.infer<typeof Navigate>
  | z.infer<typeof Find>
  | z.infer<typeof FindStop>
  | z.infer<typeof Focus>
  | z.infer<typeof DevTools>
  | z.infer<typeof PopupChoose>

export type PodBrowserPaneServerMessage =
  | {
      type: 'browserState'
      pageId: string
      url: string
      title: string
      loading: boolean
      canGoBack: boolean
      canGoForward: boolean
      agentDriving: boolean
    }
  | { type: 'browserCursor'; pageId: string; cursor: string }
  | { type: 'browserFound'; pageId: string; matches: number; active: number; final: boolean }
  | { type: 'browserAttachFailed'; pageId: string; reason: string }
  // A download of a page in a pane, the whole record each time it changes.
  | {
      type: 'browserDownload'
      pageId: string
      downloadId: string
      filename: string
      state: 'downloading' | 'interrupted' | 'completed' | 'canceled' | 'failed'
      receivedBytes: number
      totalBytes: number | null
      savePath: string
      error: string | null
    }
  // A <select> the user opened: PodNative shows its options natively, below the select's rect.
  | {
      type: 'browserPopupMenu'
      pageId: string
      menuId: number
      x: number
      y: number
      width: number
      height: number
      items: { label: string; enabled: boolean; selected: boolean; group: string }[]
    }

export function isPodBrowserPaneMessage(message: {
  type: string
}): message is PodBrowserPaneClientMessage {
  return message.type.startsWith('browser')
}
