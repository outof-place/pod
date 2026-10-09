import type { Terminal } from '@xterm/xterm'

// Forwards every byte the pane's xterm parses to a native Ghostty surface, so the native
// view and the hidden xterm (which still owns search, copy, serialize and query replies)
// hold the same screen.
export type NativeTerminalMirror = {
  attach: (surfaceId: number, serialize: () => string) => void
  // Re-seed after state the byte stream cannot express (xterm clear(), PTY rebind).
  resync: () => void
  detach: () => void
  getSurfaceId: () => number | null
  setFocusTarget: (focusNative: (() => boolean) | null) => void
  // DOM-focus xterm's textarea without moving the keyboard off the native view.
  focusShadow: () => void
  dispose: () => void
}

type MirrorState =
  | { kind: 'detached' }
  | { kind: 'seeding'; surfaceId: number; pending: string[]; generation: number }
  | { kind: 'live'; surfaceId: number }

// RIS: a re-seed starts from a blank surface; the snapshot restores modes and content.
const RESET_TERMINAL = '\x1bc'

// Why not '': xterm's resize() runs WriteBuffer.flushSync, whose `while (chunk = shift())`
// stops at a falsy chunk and clears the rest of the queue, losing the callback and the bytes
// behind it. A zero-length Uint8Array parses as nothing but is truthy.
const SEED_MARKER = new Uint8Array(0)

export function installNativeTerminalMirror(
  terminal: Terminal,
  send: (surfaceId: number, data: string) => void
): NativeTerminalMirror {
  let state: MirrorState = { kind: 'detached' }
  let serializeSnapshot: (() => string) | null = null
  let focusTarget: (() => boolean) | null = null
  let generation = 0
  const decoder = new TextDecoder()

  const originalWrite = terminal.write.bind(terminal)
  const originalClear = terminal.clear.bind(terminal)
  const originalFocus = terminal.focus.bind(terminal)

  const observe = (data: string | Uint8Array): void => {
    if (state.kind === 'detached') {
      return
    }
    const text = typeof data === 'string' ? data : decoder.decode(data, { stream: true })
    if (text.length === 0) {
      return
    }
    if (state.kind === 'seeding') {
      state.pending.push(text)
    } else {
      send(state.surfaceId, text)
    }
  }

  const seed = (surfaceId: number, reset: boolean): void => {
    generation += 1
    const seedGeneration = generation
    state = { kind: 'seeding', surfaceId, pending: [], generation: seedGeneration }
    // Why: the empty write's callback runs once everything queued before it has parsed, so
    // the snapshot covers exactly the bytes ahead of the marker and `pending` the rest.
    originalWrite(SEED_MARKER, () => {
      if (state.kind !== 'seeding' || state.generation !== seedGeneration) {
        return
      }
      const snapshot = serializeSnapshot?.() ?? ''
      const pending = state.pending.join('')
      state = { kind: 'live', surfaceId }
      send(surfaceId, `${reset ? RESET_TERMINAL : ''}${snapshot}${pending}`)
    })
  }

  // Why arity 2: the output pipeline checks `terminal.write.length < 2` to decide whether
  // parse callbacks are supported; a rest-args wrapper would report 0 and break pacing.
  terminal.write = function mirroredWrite(data: string | Uint8Array, callback?: () => void): void {
    observe(data)
    originalWrite(data, callback)
  }

  terminal.clear = function mirroredClear(): void {
    originalClear()
    if (state.kind !== 'detached') {
      seed(state.surfaceId, true)
    }
  }

  // Focus calls across Orca target xterm's textarea. The textarea still takes DOM focus,
  // so paste/copy ownership checks keep resolving to this pane, but while the native view
  // is on screen it becomes the first responder and receives the keyboard.
  terminal.focus = function mirroredFocus(): void {
    originalFocus()
    focusTarget?.()
  }

  return {
    attach: (surfaceId, serialize) => {
      serializeSnapshot = serialize
      seed(surfaceId, false)
    },
    resync: () => {
      if (state.kind !== 'detached') {
        seed(state.surfaceId, true)
      }
    },
    detach: () => {
      generation += 1
      state = { kind: 'detached' }
      serializeSnapshot = null
      focusTarget = null
    },
    getSurfaceId: () => (state.kind === 'detached' ? null : state.surfaceId),
    setFocusTarget: (focusNative) => {
      focusTarget = focusNative
    },
    focusShadow: () => originalFocus(),
    dispose: () => {
      generation += 1
      state = { kind: 'detached' }
      serializeSnapshot = null
      focusTarget = null
      terminal.write = originalWrite
      terminal.clear = originalClear
      terminal.focus = originalFocus
    }
  }
}
