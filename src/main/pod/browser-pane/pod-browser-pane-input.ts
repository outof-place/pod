// Fork-only (Pod): a browser pane's input, from PodNative's wire events to what an offscreen
// WebContents takes. Electron-free so the mapping is testable on its own.
import type { InputEvent } from 'electron'
import type { PodBrowserInputEvent } from './pod-browser-pane-protocol'

type Button = 'left' | 'right' | 'middle'
type Modifier = NonNullable<InputEvent['modifiers']>[number]
type WireModifier = PodBrowserInputEvent extends infer E
  ? E extends { modifiers: (infer M)[] }
    ? M
    : never
  : never

// Electron's names for the wire's modifiers.
const MODIFIER: Record<WireModifier, Modifier> = {
  shift: 'shift',
  control: 'control',
  alt: 'alt',
  meta: 'meta',
  capsLock: 'capslock',
  isAutoRepeat: 'isautorepeat'
}
const BUTTON_DOWN: Record<Button, Modifier> = {
  left: 'leftbuttondown',
  right: 'rightbuttondown',
  middle: 'middlebuttondown'
}

function electronModifiers(modifiers: readonly WireModifier[]): Modifier[] {
  return modifiers.map((modifier) => MODIFIER[modifier])
}

// Chromium's pixels per wheel line on macOS: a line-based wheel arrives in lines.
const PIXELS_PER_LINE = 40

export type PaneInput =
  | {
      type: 'mouseDown' | 'mouseUp' | 'mouseMove' | 'mouseEnter' | 'mouseLeave'
      x: number
      y: number
      button: Button
      clickCount: number
      modifiers: Modifier[]
    }
  | {
      type: 'mouseWheel'
      x: number
      y: number
      deltaX: number
      deltaY: number
      wheelTicksX?: number
      wheelTicksY?: number
      hasPreciseScrollingDeltas: boolean
      canScroll: boolean
      modifiers: Modifier[]
    }
  | { type: 'keyDown' | 'keyUp' | 'char'; keyCode: string; modifiers: Modifier[] }

export type EditCommand = 'cut' | 'copy' | 'paste' | 'selectAll' | 'undo' | 'redo'

export type PaneInputAction =
  | { kind: 'send'; input: PaneInput }
  | { kind: 'insertText'; text: string }
  | { kind: 'edit'; command: EditCommand }
  | { kind: 'none' }

const EDIT_KEYS: Record<string, EditCommand> = {
  x: 'cut',
  c: 'copy',
  v: 'paste',
  a: 'selectAll',
  z: 'undo'
}

/** ⌘X/C/V/A/Z and ⇧⌘Z: an offscreen page runs no menu, so these become its edit commands. */
function editCommand(keyCode: string, modifiers: readonly WireModifier[]): EditCommand | null {
  const key = keyCode.toLowerCase()
  const others = modifiers.filter((m) => m !== 'meta' && m !== 'capsLock' && m !== 'isAutoRepeat')
  if (!modifiers.includes('meta')) {
    return null
  }
  if (others.length === 0) {
    return EDIT_KEYS[key] ?? null
  }
  return key === 'z' && others.length === 1 && others[0] === 'shift' ? 'redo' : null
}

/** Per page: which buttons are down (drags), and which edit keys' key-ups to swallow. */
export class PaneInputState {
  private readonly buttons = new Set<Button>()
  private readonly swallowedKeyUps = new Set<string>()

  map(event: PodBrowserInputEvent): PaneInputAction {
    switch (event.kind) {
      case 'text':
        return { kind: 'insertText', text: event.text }
      case 'mouse': {
        if (event.action === 'down') {
          this.buttons.add(event.button)
        } else if (event.action === 'up') {
          this.buttons.delete(event.button)
        }
        const modifiers = electronModifiers(event.modifiers)
        if (event.action === 'move') {
          // Why: a drag is a move with a button held, which Chromium reads from the modifiers.
          for (const button of this.buttons) {
            modifiers.push(BUTTON_DOWN[button])
          }
        }
        const type = {
          down: 'mouseDown',
          up: 'mouseUp',
          move: 'mouseMove',
          enter: 'mouseEnter',
          leave: 'mouseLeave'
        } as const
        return {
          kind: 'send',
          input: {
            type: type[event.action],
            x: Math.round(event.x),
            y: Math.round(event.y),
            button: event.button,
            clickCount: event.clickCount,
            modifiers
          }
        }
      }
      case 'wheel': {
        const lines = !event.precise
        return {
          kind: 'send',
          input: {
            type: 'mouseWheel',
            x: Math.round(event.x),
            y: Math.round(event.y),
            deltaX: lines ? event.deltaX * PIXELS_PER_LINE : event.deltaX,
            deltaY: lines ? event.deltaY * PIXELS_PER_LINE : event.deltaY,
            ...(lines ? { wheelTicksX: event.deltaX, wheelTicksY: event.deltaY } : {}),
            hasPreciseScrollingDeltas: event.precise,
            canScroll: true,
            modifiers: electronModifiers(event.modifiers)
          }
        }
      }
      case 'key': {
        const id = event.keyCode.toLowerCase()
        if (event.action === 'down') {
          const command = editCommand(event.keyCode, event.modifiers)
          if (command) {
            this.swallowedKeyUps.add(id)
            return { kind: 'edit', command }
          }
        } else if (event.action === 'up' && this.swallowedKeyUps.delete(id)) {
          return { kind: 'none' }
        } else if (event.action === 'char' && editCommand(event.keyCode, event.modifiers)) {
          return { kind: 'none' }
        }
        const type = { down: 'keyDown', up: 'keyUp', char: 'char' } as const
        return {
          kind: 'send',
          input: {
            type: type[event.action],
            keyCode: event.keyCode,
            modifiers: electronModifiers(event.modifiers)
          }
        }
      }
    }
  }

  /** The pane went away: nothing stays held. */
  reset(): void {
    this.buttons.clear()
    this.swallowedKeyUps.clear()
  }
}

const NAVIGABLE_PROTOCOLS = new Set(['http:', 'https:'])

/** What the address bar may load: http(s), and about:blank. */
export function isNavigablePaneUrl(url: string): boolean {
  if (url === 'about:blank') {
    return true
  }
  try {
    return NAVIGABLE_PROTOCOLS.has(new URL(url).protocol)
  } catch {
    return false
  }
}
