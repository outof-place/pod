// Fork-only (Pod): the one-app control channel between PodNative and this runtime. NDJSON on a 0600
// unix socket in the profile; the first line must be `hello` carrying the runtime's authToken from
// orca-runtime.json, the same boundary as the runtime socket. PodNative's side mirrors these shapes
// (PodRuntime/UIHostChannel.swift in outof-place/pod-native).
import { z } from 'zod'

export const POD_UI_HOST_PROTOCOL_VERSION = 1
export const POD_UI_HOST_SOCKET_NAME = 'pod-ui-host.sock'
export const POD_UI_HOST_MAX_LINE_BYTES = 64 * 1024

const Hello = z.object({
  type: z.literal('hello'),
  v: z.number().int(),
  token: z.string().min(1),
  pid: z.number().int().positive()
})

// A surface PodNative has no native view for yet: the hidden window shows, at the worktree if given.
const Show = z.object({
  type: z.literal('show'),
  surface: z.enum(['window', 'settings']),
  repoId: z.string().optional(),
  worktreeId: z.string().optional(),
  tabId: z.string().optional()
})

const Quit = z.object({ type: z.literal('quit') })

export const PodUiHostClientMessage = z.discriminatedUnion('type', [Hello, Show, Quit])
export type PodUiHostClientMessage = z.infer<typeof PodUiHostClientMessage>
export type PodUiHostShowRequest = z.infer<typeof Show>

export type PodUiHostServerMessage =
  | { type: 'welcome'; v: number; pid: number }
  // `visible` is false when this launch must not take the screen (ORCA_BACKGROUND_LAUNCH=1).
  | { type: 'shown'; surface: PodUiHostShowRequest['surface']; visible: boolean }
  | { type: 'hidden' }
  // The user asked a host-owned surface (a fallback window's Quit) to quit Pod: PodNative quits both.
  | { type: 'quitRequested' }
  | { type: 'badge'; label: string }
  // A notification click: PodNative shows that worktree (and tab, when known).
  | { type: 'focus'; worktreeId: string; tabId?: string; leafId?: string }

/** One line from the client, or null when it isn't a message this version knows. */
export function parsePodUiHostClientLine(line: string): PodUiHostClientMessage | null {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  const parsed = PodUiHostClientMessage.safeParse(value)
  return parsed.success ? parsed.data : null
}

export function encodePodUiHostServerMessage(message: PodUiHostServerMessage): string {
  return `${JSON.stringify(message)}\n`
}
