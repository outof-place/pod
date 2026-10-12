import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import {
  eraseRpcMethods,
  isStreamingMethod,
  type RpcContext,
  type RpcStreamingMethod
} from '../../runtime/rpc/core'
// Why: importing client-events directly trips its module-init cycle through ipc/ssh; the index resolves it.
import { ALL_RPC_METHODS } from '../../runtime/rpc/methods/index'
import { installPodKeybindings, uninstallPodKeybindingsForTests } from './install-pod-keybindings'

const subscribe = eraseRpcMethods(ALL_RPC_METHODS).find(
  (method) => method.name === 'runtime.clientEvents.subscribe' && isStreamingMethod(method)
)
if (!subscribe || !isStreamingMethod(subscribe)) {
  throw new Error('missing runtime.clientEvents.subscribe')
}
const subscribeMethod: RpcStreamingMethod = subscribe

let dir: string | null = null

afterEach(() => {
  uninstallPodKeybindingsForTests()
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
  }
  dir = null
})

function start(params: unknown) {
  const cleanups: (() => void)[] = []
  const frames: Record<string, unknown>[] = []
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler only uses these two runtime hooks here.
  const runtime = {
    onClientEvent: vi.fn(() => () => {}),
    registerSubscriptionCleanup: (_id: string, cleanup: () => void) => cleanups.push(cleanup)
  } as unknown as OrcaRuntimeService
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only these fields.
  const context = { runtime, connectionId: 'conn-1' } as RpcContext
  const done = subscribeMethod.handler(subscribeMethod.params?.parse(params), context, (frame) => {
    frames.push(frame as Record<string, unknown>)
  })
  return {
    frames,
    stop: async () => {
      cleanups.forEach((cleanup) => cleanup())
      await done
    }
  }
}

describe('runtime.clientEvents.subscribe keybindings opt-in', () => {
  it('sends keybindingsChanged after the file changes an action', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pod-keybindings-events-'))
    const path = join(dir, 'keybindings.json')
    installPodKeybindings(() => path, true, 'darwin')
    const { frames, stop } = start({ keybindings: true })
    expect(frames.find((frame) => frame.type === 'ready')).toMatchObject({ keybindings: true })

    writeFileSync(path, JSON.stringify({ keybindings: { 'tab.newTerminal': 'Mod+Alt+Y' } }))
    await vi.waitFor(
      () => expect(frames.some((frame) => frame.type === 'keybindingsChanged')).toBe(true),
      {
        timeout: 3000
      }
    )
    const changed = frames.find((frame) => frame.type === 'keybindingsChanged')
    expect(changed).toMatchObject({ path, platform: 'darwin' })
    await stop()
  })

  it('leaves a subscription that did not opt in alone', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pod-keybindings-events-'))
    installPodKeybindings(() => join(dir ?? '', 'keybindings.json'), true, 'darwin')
    const { frames, stop } = start(undefined)
    expect(frames.find((frame) => frame.type === 'ready')).not.toHaveProperty('keybindings')
    await stop()
  })
})
