// Fork-only (Pod): the one-app control channel between PodNative and this runtime, version 3.
// NDJSON on a 0600 unix socket in a 0700 directory of the profile. A connection is admitted only
// from PodNative signed by Pod's team (audit token) and only after a `hello` carrying the
// runtime's authToken from orca-runtime.json. The verbs are fixed; anything else is refused.
// PodNative's side mirrors these shapes (PodRuntime/UIHostChannel.swift in outof-place/pod-native).
// Version 2 answers a quit: `quitting` and a heartbeat until exit, or `needsConfirmation`.
// Version 3 adds browserPane: which attached browser panes are on screen.
import { z } from 'zod'
import {
  POD_BROWSER_PANE_CLIENT_MESSAGES,
  type PodBrowserPaneServerMessage
} from '../browser-pane/pod-browser-pane-protocol'

export const POD_UI_HOST_PROTOCOL_VERSION = 3
// The oldest PodNative still admitted; its quit gets no answer (the version 1 behaviour).
export const POD_UI_HOST_MIN_PROTOCOL_VERSION = 1
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

// `update`: the updater swaps Pod.app next and starts it again. `confirmed`: the user answered a
// needsConfirmation with "quit anyway".
const Quit = z
  .object({
    type: z.literal('quit'),
    reason: z.enum(['user', 'update']),
    confirmed: z.literal(true).optional()
  })
  .strict()

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
  SecondInstance,
  ...POD_BROWSER_PANE_CLIENT_MESSAGES
])
export type PodUiHostClientMessage = z.infer<typeof PodUiHostClientMessage>
export type PodUiHostOpenSurface = z.infer<typeof OpenSurface>
export type PodUiHostSecondInstance = z.infer<typeof SecondInstance>
export type PodUiHostQuitReason = z.infer<typeof Quit>['reason']

// What a welcome's `features` may name beyond the base verbs; PodNative sends only what it lists.
// `headless`: no classic window posts agent notifications or sets the Dock badge; PodNative does.
export const POD_UI_HOST_FEATURES = ['browser', 'headless'] as const

export type PodUiHostServerMessage =
  | { type: 'welcome'; v: number; pid: number; features: readonly string[] }
  // `visible` is false when this launch must not take the screen (ORCA_BACKGROUND_LAUNCH=1).
  | { type: 'surfaceShown'; surface: PodUiHostOpenSurface['surface']; visible: boolean }
  | { type: 'surfaceHidden' }
  // A Quit in one of this runtime's windows (`user`), or logout or a signal (`system`): Pod quits.
  | { type: 'quitRequested'; reason: 'user' | 'system' }
  | { type: 'badge'; label: string }
  // Bring PodNative forward (a reopen, a second launch, a notification click), at a tab if known.
  | { type: 'activate'; worktreeId?: string; tabId?: string; leafId?: string }
  // v2, the answers to a quit. `quitting`: committed; a `quitHeartbeat` follows every second
  // until this process exits, so a PodNative that stops hearing it knows the runtime hung.
  | { type: 'quitting'; reason: PodUiHostQuitReason }
  | { type: 'quitHeartbeat' }
  // The quit would lose something: PodNative asks the user, then sends quit again, confirmed.
  // `runningAgents`: agents working in terminals; they keep running in the terminal daemon.
  | {
      type: 'needsConfirmation'
      reason: 'unsavedChanges' | 'remoteWork'
      unsavedFiles: number
      remoteWork: 'running' | 'unverifiable' | null
      runningAgents: number
    }
  // A committed quit was vetoed (the session could not be saved): this runtime keeps running.
  | { type: 'quitAborted'; reason: string }
  | PodBrowserPaneServerMessage

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
