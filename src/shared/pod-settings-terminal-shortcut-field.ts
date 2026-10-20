// Fork-only (Pod): podSettings' "Shortcuts in a terminal" (terminalShortcutPolicy), on its own:
// pod-settings-schema.ts is at its line limit.
import { z } from 'zod'
import { row } from './pod-settings-row'

export const POD_SETTINGS_TERMINAL_SHORTCUT_FIELDS = {
  terminalShortcutPolicy: row(
    z.enum(['orca-first', 'terminal-first']),
    'Shortcuts in a terminal',
    "Terminal first leaves a focused terminal the shortcuts Pod doesn't run there; Copy, Paste and the menu's other commands still work."
  )
}
