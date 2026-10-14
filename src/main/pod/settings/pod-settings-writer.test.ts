import { describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import type { Store } from '../../persistence'
import { registerSettingsHandlersOnce } from './pod-settings-registration'
import { getPodSettingsWriter, podSettingsWritePath } from './pod-settings-writer'

const { registerSettingsHandlers, identity } = vi.hoisted(() => ({
  registerSettingsHandlers: vi.fn(),
  identity: { pod: false }
}))
vi.mock('../../ipc/settings', () => ({ registerSettingsHandlers }))
vi.mock('../../product-identity/product-identity', () => ({
  getProductIdentity: () => (identity.pod ? { displayName: 'Pod' } : null)
}))

function stubStore(): Store {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: registerSettingsHandlers is mocked; the store is only a WeakSet key here.
  return {} as Store
}

describe('podSettings write path', () => {
  it("gives settings:set the renderer's id and podSettings.set none", async () => {
    const write = vi.fn(async () => getDefaultSettings('/Users/e2e'))
    const listener = podSettingsWritePath(write)
    await listener({ sender: { id: 7 } }, { theme: 'dark' })
    expect(write).toHaveBeenLastCalledWith({ theme: 'dark' }, 7)
    await getPodSettingsWriter()?.({ theme: 'light' })
    expect(write).toHaveBeenLastCalledWith({ theme: 'light' })
  })

  it('drops a Claude host selection from both writes in Pod', async () => {
    identity.pod = true
    const write = vi.fn(async () => getDefaultSettings('/Users/e2e'))
    const listener = podSettingsWritePath(write)
    await listener({ sender: { id: 7 } }, { theme: 'dark', activeClaudeManagedAccountId: 'p1' })
    expect(write).toHaveBeenLastCalledWith({ theme: 'dark' }, 7)
    await getPodSettingsWriter()?.({
      activeClaudeManagedAccountIdsByRuntime: { host: 'p1', wsl: {} }
    })
    expect(write).toHaveBeenLastCalledWith({
      activeClaudeManagedAccountIdsByRuntime: { host: null, wsl: {} }
    })
    identity.pod = false
  })

  it('registers the settings handlers once per store', () => {
    const [store, other] = [stubStore(), stubStore()]
    registerSettingsHandlersOnce(store)
    registerSettingsHandlersOnce(store)
    registerSettingsHandlersOnce(other)
    expect(registerSettingsHandlers).toHaveBeenCalledTimes(2)
  })
})
