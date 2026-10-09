import { app } from 'electron'
import type { NativeTerminalForwardedChord } from '../../shared/native-terminal-forwarded-chords'
import type { GhosttyTerminalAddon } from './ghostty-native-terminal-addon'

type DebugHookSources = {
  surfaceIds: () => number[]
  addon: () => GhosttyTerminalAddon | null
  forwardedChords: () => NativeTerminalForwardedChord[]
}

// Unpackaged builds only: lets E2E drive and inspect surfaces through electronApp.evaluate.
export function installGhosttyDebugHooks(sources: DebugHookSources): void {
  if (app.isPackaged) {
    return
  }
  const { addon } = sources
  Object.assign(globalThis, {
    __orcaNativeTerminalDebug: {
      surfaceIds: sources.surfaceIds,
      state: (surfaceId: number) => addon()?.debugState(surfaceId) ?? null,
      grid: (surfaceId: number) => addon()?.gridSize(surfaceId) ?? null,
      screenText: (surfaceId: number) => addon()?.debugScreenText(surfaceId) ?? null,
      snapshotBase64: (surfaceId: number) =>
        addon()?.debugSnapshot(surfaceId)?.toString('base64') ?? null,
      key: (surfaceId: number, characters: string, keyCode: number, modifierFlags = 0) =>
        addon()?.debugKey(surfaceId, characters, keyCode, modifierFlags),
      scrollbar: (surfaceId: number) => addon()?.debugState(surfaceId)?.scrollbar ?? null,
      scrollbarScroll: (surfaceId: number, fraction: number) =>
        addon()?.debugScrollbarScroll(surfaceId, fraction) ?? false,
      focus: (surfaceId: number) => addon()?.focus(surfaceId),
      modifiersChanged: (surfaceId: number, keyCode: number, modifierFlags: number) =>
        addon()?.debugModifiersChanged(surfaceId, keyCode, modifierFlags),
      drop: (surfaceId: number, paths: string[]) => addon()?.debugDrop(surfaceId, paths) ?? null,
      forwardedChords: sources.forwardedChords
    }
  })
}
