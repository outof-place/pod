import type { Terminal } from '@xterm/xterm'
import type { ManagedPaneInternal } from './pane-manager-types'

// Parse once: a pane under a main-fed native view paints nothing, so it holds no WebGL
// context. Keyed on the terminal: PTY connections only hold the public pane.
const suspendedTerminals = new WeakSet<Terminal>()
const panesByTerminal = new WeakMap<Terminal, ManagedPaneInternal>()

export function rememberPaneForWebglSuspension(pane: ManagedPaneInternal): void {
  panesByTerminal.set(pane.terminal, pane)
}

export function isPaneWebglSuspendedUnderNativeView(pane: ManagedPaneInternal): boolean {
  return suspendedTerminals.has(pane.terminal)
}

// The pane whose suspension changed, or null when nothing changed.
export function markTerminalWebglSuspendedUnderNativeView(
  terminal: Terminal,
  suspended: boolean
): ManagedPaneInternal | null {
  if (suspendedTerminals.has(terminal) === suspended) {
    return null
  }
  if (suspended) {
    suspendedTerminals.add(terminal)
  } else {
    suspendedTerminals.delete(terminal)
  }
  return panesByTerminal.get(terminal) ?? null
}
