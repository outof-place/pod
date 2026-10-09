import { app } from 'electron'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

export type NativeSurfaceFrame = [
  surfaceId: number,
  x: number,
  y: number,
  width: number,
  height: number,
  visible: boolean
]

export type NativeSurfaceEventHandler = (kind: string, ...args: unknown[]) => void

// Rows as Ghostty reports them; hit* name the view a click on / beside the scroller reaches.
export type NativeSurfaceScrollbarState = {
  total: number
  offset: number
  len: number
  visible: boolean
  knobProportion: number
  knobPosition: number
  hitScroller: string
  hitBeside: string
}

export type GhosttyTerminalAddon = {
  init: (configPath: string) => boolean
  updateConfig: (configPath: string) => void
  createSurface: (
    windowHandle: Buffer,
    x: number,
    y: number,
    width: number,
    height: number,
    onEvent: NativeSurfaceEventHandler
  ) => number
  writeOutput: (surfaceId: number, data: Buffer) => void
  setFrames: (frames: NativeSurfaceFrame[]) => void
  focus: (surfaceId: number) => void
  setAppFocus: (focused: boolean) => void
  readSelection: (surfaceId: number) => string | null
  performAction: (surfaceId: number, action: string) => boolean
  destroySurface: (surfaceId: number) => void
  gridSize: (surfaceId: number) => { columns: number; rows: number } | null
  debugKey: (surfaceId: number, characters: string, keyCode: number, modifierFlags: number) => void
  debugScreenText: (surfaceId: number) => string | null
  debugSnapshot: (surfaceId: number) => Buffer | null
  debugState: (surfaceId: number) => {
    hidden: boolean
    firstResponder: boolean
    x: number
    y: number
    width: number
    height: number
    scrollbar: NativeSurfaceScrollbarState | null
  } | null
  debugScrollbarScroll: (surfaceId: number, fraction: number) => boolean
}

const ADDON_FILE = 'ghostty_terminal.node'
const requireFromMain = createRequire(__filename)
let cached: GhosttyTerminalAddon | null | undefined

function candidatePaths(): string[] {
  if (app.isPackaged) {
    return [join(process.resourcesPath, 'ghostty-terminal-macos', ADDON_FILE)]
  }
  // Dev and E2E run the bundle from out/main; the addon is built in the repo.
  return [
    join(__dirname, '../../native/ghostty-terminal-macos/build', ADDON_FILE),
    join(app.getAppPath(), 'native/ghostty-terminal-macos/build', ADDON_FILE)
  ]
}

export function loadGhosttyTerminalAddon(): GhosttyTerminalAddon | null {
  if (cached !== undefined) {
    return cached
  }
  cached = null
  if (process.platform !== 'darwin') {
    return cached
  }
  const path = candidatePaths().find((candidate) => existsSync(candidate))
  if (!path) {
    return cached
  }
  try {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the addon's exports are defined in native/ghostty-terminal-macos/src/ghostty_terminal.mm and mirror this type.
    cached = requireFromMain(path) as GhosttyTerminalAddon
  } catch (error) {
    console.error('[native-terminal] failed to load the Ghostty addon', error)
  }
  return cached
}
