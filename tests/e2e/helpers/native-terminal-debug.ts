import type { ElectronApplication } from '@stablyai/playwright-test'

// Main installs these hooks in unpackaged builds (installNativeTerminalDebugHooks).
export type NativeTerminalDebugOp =
  | 'surfaceIds'
  | 'state'
  | 'grid'
  | 'screenText'
  | 'snapshotBase64'
  | 'key'
  | 'focus'
  | 'modifiersChanged'
  | 'drop'
  | 'forwardedChords'

export function nativeTerminalDebug(
  app: ElectronApplication,
  op: NativeTerminalDebugOp,
  args: unknown[] = []
): Promise<unknown> {
  return app.evaluate(
    (_electron, [name, callArgs]) => {
      const debug: unknown = Reflect.get(globalThis, '__orcaNativeTerminalDebug')
      const fn: unknown =
        typeof debug === 'object' && debug !== null ? Reflect.get(debug, name) : null
      if (typeof fn !== 'function') {
        throw new Error(`native terminal debug hook ${name} is not installed`)
      }
      return Reflect.apply(fn, debug, callArgs)
    },
    [op, args] as const
  )
}

export async function nativeSurfaceIds(app: ElectronApplication): Promise<number[]> {
  const ids = await nativeTerminalDebug(app, 'surfaceIds')
  return Array.isArray(ids) ? ids.filter((id): id is number => typeof id === 'number') : []
}

export async function nativeSurfaceField(
  app: ElectronApplication,
  surfaceId: number,
  field: string
): Promise<unknown> {
  const state = await nativeTerminalDebug(app, 'state', [surfaceId])
  return typeof state === 'object' && state !== null ? Reflect.get(state, field) : null
}
