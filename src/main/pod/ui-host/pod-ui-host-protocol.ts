// Fork-only (Pod): the one-app control channel between PodNative and this runtime, version 1.
// NDJSON on a 0600 unix socket in a 0700 directory of the profile. A connection is admitted only
// from PodNative signed by Pod's team (audit token) and only after a `hello` carrying the
// runtime's authToken from orca-runtime.json. The verbs are fixed; anything else is refused.
// PodNative's side mirrors these shapes (PodRuntime/UIHostChannel.swift in outof-place/pod-native).
import { z } from 'zod'

export const POD_UI_HOST_PROTOCOL_VERSION = 1
export const POD_UI_HOST_DIRECTORY_NAME = 'pod-ui-host'
export const POD_UI_HOST_SOCKET_NAME = 'host.sock'
export const POD_UI_HOST_MAX_LINE_BYTES = 64 * 1024
const MAX_FORWARDED = 32
const MAX_FORWARDED_LENGTH = 4096

// Opens the lease: the runtime stays while this connection does.
const Hello = z
  .object({
    type: z.literal('hello'),
    v: z.number().int(),
    token: z.string().min(1).max(512),
    pid: z.number().int().positive()
  })
  .strict()

// `update`: the updater swaps Pod.app next and starts it again.
const Quit = z.object({ type: z.literal('quit'), reason: z.enum(['user', 'update']) }).strict()

// A surface PodNative has no native view for yet: the hidden window shows, at the worktree if given.
const OpenSurface = z
  .object({
    type: z.literal('openSurface'),
    surface: z.enum(['window', 'settings']),
    worktreeId: z.string().max(MAX_FORWARDED_LENGTH).optional(),
    tabId: z.string().max(MAX_FORWARDED_LENGTH).optional()
  })
  .strict()

// What macOS handed PodNative that only this runtime handles yet (Pod URLs, documents).
const SecondInstance = z
  .object({
    type: z.literal('secondInstance'),
    urls: z.array(z.string().max(MAX_FORWARDED_LENGTH)).max(MAX_FORWARDED),
    files: z.array(z.string().max(MAX_FORWARDED_LENGTH)).max(MAX_FORWARDED)
  })
  .strict()

export const PodUiHostClientMessage = z.discriminatedUnion('type', [
  Hello,
  Quit,
  OpenSurface,
  SecondInstance
])
export type PodUiHostClientMessage = z.infer<typeof PodUiHostClientMessage>
export type PodUiHostOpenSurface = z.infer<typeof OpenSurface>
export type PodUiHostSecondInstance = z.infer<typeof SecondInstance>
export type PodUiHostQuitReason = z.infer<typeof Quit>['reason']

export type PodUiHostServerMessage =
  | { type: 'welcome'; v: number; pid: number }
  // `visible` is false when this launch must not take the screen (ORCA_BACKGROUND_LAUNCH=1).
  | { type: 'surfaceShown'; surface: PodUiHostOpenSurface['surface']; visible: boolean }
  | { type: 'surfaceHidden' }
  // A Quit in one of this runtime's windows (`user`), or logout or a signal (`system`): Pod quits.
  | { type: 'quitRequested'; reason: 'user' | 'system' }
  | { type: 'badge'; label: string }
  // Bring PodNative forward (a reopen, a second launch, a notification click), at a tab if known.
  | { type: 'activate'; worktreeId?: string; tabId?: string; leafId?: string }

/** One line from the client, or null when it isn't a message of this version. */
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
