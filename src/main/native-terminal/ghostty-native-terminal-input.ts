import type { NativeTerminalForwardedChord } from '../../shared/native-terminal-forwarded-chords'
import type { NativeTerminalEvent } from '../../shared/native-terminal-ipc'
import type { GhosttyTerminalAddon } from './ghostty-native-terminal-addon'

let appliedChords: NativeTerminalForwardedChord[] = []

export function appliedForwardedChords(): NativeTerminalForwardedChord[] {
  return appliedChords
}

// Keybindings are app-wide, so the latest set from a window hosting surfaces stands for all.
export function applyForwardedChords(
  addon: GhosttyTerminalAddon,
  chords: NativeTerminalForwardedChord[]
): void {
  appliedChords = chords
  addon.setForwardedChords(
    chords.map((chord) => [chord.keyCode, chord.modifierFlags, chord.character])
  )
}

export function toMouseEnterEvent(surfaceId: number, args: unknown[]): NativeTerminalEvent {
  return {
    surfaceId,
    kind: 'mouseEnter',
    buttons: Number(args[0]),
    windowFocused: args[1] === true
  }
}
