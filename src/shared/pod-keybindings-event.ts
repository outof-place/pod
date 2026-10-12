// Fork-only (Pod): keybindings.effective and the opt-in `keybindingsChanged` client event.
import type {
  KeybindingActionId,
  KeybindingFileDiagnostic,
  KeybindingPlatform,
  KeybindingScope
} from './keybindings/types'

export type PodEffectiveKeybinding = {
  id: KeybindingActionId
  scope: KeybindingScope
  /** What the action answers to now: the user's file where it sets the action, else the defaults. */
  bindings: string[]
  defaults: string[]
  /** The user's file sets this action (an empty `bindings` then means unbound). */
  overridden: boolean
}

/**
 * Every action of Pod's catalog with its bindings on the runtime's platform, read with Pod's own
 * rules (keybinding-file.ts: overrides that clash or don't parse are dropped, with a diagnostic).
 * `revision` changes exactly when one of the actions' bindings does.
 */
export type PodEffectiveKeybindings = {
  path: string
  platform: KeybindingPlatform
  exists: boolean
  revision: string
  actions: PodEffectiveKeybinding[]
  diagnostics: KeybindingFileDiagnostic[]
}

/** Sent to a client events subscription that passed `keybindings: true`, after the file changed
 *  what an action answers to. */
export type PodKeybindingsChangedEvent = { type: 'keybindingsChanged' } & PodEffectiveKeybindings

/** Added to the subscription's `ready` frame when the runtime honours the opt-in. */
export type PodKeybindingsReadyFields = { keybindings?: true }
