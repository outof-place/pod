import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PodEffectiveKeybindings } from '../../../shared/pod-keybindings-event'
import { eraseRpcMethods, isStreamingMethod, type RpcContext } from '../../runtime/rpc/core'
import {
  installPodKeybindings,
  isPodKeybindingsRpcEnabled,
  uninstallPodKeybindingsForTests
} from './install-pod-keybindings'
import { PodKeybindingsHub, readEffectiveKeybindings } from './pod-keybindings-hub'
import { POD_KEYBINDINGS_METHODS } from './pod-keybindings-rpc-methods'

let dir: string
let path: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pod-keybindings-'))
  path = join(dir, 'keybindings.json')
})

afterEach(() => {
  uninstallPodKeybindingsForTests()
  rmSync(dir, { recursive: true, force: true })
})

const action = (keybindings: PodEffectiveKeybindings, id: string) =>
  keybindings.actions.find((entry) => entry.id === id)

function nextChange(hub: PodKeybindingsHub, timeoutMs = 3000) {
  return new Promise<{ keybindings: PodEffectiveKeybindings; stop: () => void }>(
    (resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no keybindings change')), timeoutMs)
      const stop = hub.subscribe((keybindings) => {
        clearTimeout(timer)
        resolve({ keybindings, stop })
      }, reject)
      // The watch is armed synchronously; the edit lands after it.
      writeFileSync(path, JSON.stringify({ keybindings: { 'tab.newTerminal': 'Mod+Alt+Y' } }))
    }
  )
}

describe('readEffectiveKeybindings', () => {
  it('answers Pod defaults without a file', () => {
    const keybindings = readEffectiveKeybindings(path, 'darwin')
    expect(keybindings.exists).toBe(false)
    expect(keybindings.platform).toBe('darwin')
    expect(action(keybindings, 'tab.newTerminal')).toMatchObject({
      scope: 'tabs',
      bindings: ['Mod+T'],
      defaults: ['Mod+T'],
      overridden: false
    })
    expect(action(keybindings, 'app.settings')?.bindings).toEqual([])
  })

  it("reads the file with Pod's rules: rebinds, unbinds, clashes dropped", () => {
    writeFileSync(
      path,
      JSON.stringify({
        keybindings: {
          'tab.newTerminal': 'Mod+Alt+Y',
          'tab.close': null,
          'tab.newBrowser': 'Mod+Shift+T'
        },
        platforms: { darwin: { 'app.settings': 'Cmd+Comma' } }
      })
    )
    const keybindings = readEffectiveKeybindings(path, 'darwin')
    expect(action(keybindings, 'tab.newTerminal')).toMatchObject({
      bindings: ['Mod+Alt+Y'],
      overridden: true
    })
    expect(action(keybindings, 'app.settings')?.bindings).toEqual(['Cmd+Comma'])
    expect(action(keybindings, 'tab.newBrowser')?.overridden).toBe(false)
    expect(
      keybindings.diagnostics.some((entry) =>
        entry.message.startsWith('Conflicting custom shortcuts')
      )
    ).toBe(true)
    expect(action(keybindings, 'tab.close')?.overridden).toBe(true)
    expect(action(keybindings, 'tab.close')?.bindings).toEqual([])
    expect(keybindings.revision).not.toBe(
      readEffectiveKeybindings(join(dir, 'none.json'), 'darwin').revision
    )
  })
})

describe('PodKeybindingsHub', () => {
  it('reports an edit of the file, once settled', async () => {
    const hub = new PodKeybindingsHub(() => path, 'darwin', 10)
    const { keybindings, stop } = await nextChange(hub)
    expect(action(keybindings, 'tab.newTerminal')?.bindings).toEqual(['Mod+Alt+Y'])
    stop()
  })

  it('stays quiet for an edit that changes no binding', async () => {
    writeFileSync(path, JSON.stringify({ keybindings: { 'tab.newTerminal': 'Mod+Alt+Y' } }))
    const hub = new PodKeybindingsHub(() => path, 'darwin', 10)
    const seen: PodEffectiveKeybindings[] = []
    const stop = hub.subscribe(
      (keybindings) => seen.push(keybindings),
      () => {}
    )
    writeFileSync(
      path,
      JSON.stringify({ keybindings: { 'tab.newTerminal': 'Mod+Alt+Y' } }, null, 2)
    )
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(seen).toEqual([])
    stop()
  })
})

describe('keybindings.effective', () => {
  const methods = eraseRpcMethods(POD_KEYBINDINGS_METHODS)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads no context.
  const ctx = {} as RpcContext
  function call(): unknown {
    const entry = methods.find((candidate) => candidate.name === 'keybindings.effective')
    if (!entry || isStreamingMethod(entry)) {
      throw new Error('missing keybindings.effective')
    }
    return entry.handler(undefined, ctx)
  }

  it('is read-only for workspace clients', () => {
    expect(POD_KEYBINDINGS_METHODS.map((entry) => [entry.name, entry.permission])).toEqual([
      ['keybindings.effective', 'workspace']
    ])
  })

  it("answers the installed file's effective bindings", () => {
    writeFileSync(path, JSON.stringify({ keybindings: { 'tab.newTerminal': 'Mod+Alt+Y' } }))
    installPodKeybindings(() => path, true, 'darwin')
    const result = call()
    expect(result).toEqual(readEffectiveKeybindings(path, 'darwin'))
  })

  it('refuses without Pod', () => {
    installPodKeybindings(() => path, false)
    expect(() => call()).toThrow(/off in this build/)
    expect(isPodKeybindingsRpcEnabled({ POD_KEYBINDINGS_RPC: '0' }, () => true)).toBe(false)
    expect(isPodKeybindingsRpcEnabled({ POD_KEYBINDINGS_RPC: '1' }, () => false)).toBe(true)
  })
})
