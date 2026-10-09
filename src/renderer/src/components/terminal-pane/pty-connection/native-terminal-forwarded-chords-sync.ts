import { useAppStore } from '@/store'
import { buildNativeTerminalForwardedChords } from '../../../../../shared/native-terminal-forwarded-chords'

let syncing = false

// The native view decides at keyDown whether a chord is Orca's, so it needs the chords Orca's
// shortcut handlers would claim, kept current as keybindings and the shortcut policy change.
export function ensureNativeTerminalForwardedChordSync(): void {
  const api = window.api?.nativeTerminal
  if (syncing || !api) {
    return
  }
  syncing = true
  let lastKey: string | null = null
  const push = (): void => {
    const state = useAppStore.getState()
    const chords = buildNativeTerminalForwardedChords({
      overrides: state.keybindings,
      terminalShortcutPolicy: state.settings?.terminalShortcutPolicy
    })
    const key = JSON.stringify(chords)
    if (key !== lastKey) {
      lastKey = key
      api.setForwardedChords(chords)
    }
  }
  push()
  useAppStore.subscribe((state, previous) => {
    if (
      state.keybindings !== previous.keybindings ||
      state.settings?.terminalShortcutPolicy !== previous.settings?.terminalShortcutPolicy
    ) {
      push()
    }
  })
}
