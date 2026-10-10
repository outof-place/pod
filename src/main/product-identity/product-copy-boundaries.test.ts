import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as ProductIdentityModule from './product-identity'
import type { ProductIdentity } from './product-identity'
import { podIdentityWithoutStablyServices } from './product-identity.test-fixture'

const identity = vi.hoisted((): { current: ProductIdentity | null } => ({ current: null }))

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), handleOnce: vi.fn() } }))
vi.mock('./product-identity', async (importOriginal) => ({
  ...(await importOriginal<typeof ProductIdentityModule>()),
  getProductIdentity: () => identity.current
}))

import { brandErrorCopy, brandIpcHandlerErrors } from './product-copy-boundaries'
import { errorResponse } from '../runtime/rpc/errors'

type IpcRegistrar = Pick<IpcMain, 'handle' | 'handleOnce'>
type Listener = Parameters<IpcRegistrar['handle']>[1]

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the listeners under test never read the event.
const EVENT = {} as IpcMainInvokeEvent

function fakeIpc(): { listeners: Map<string, Listener>; ipc: IpcRegistrar } {
  const listeners = new Map<string, Listener>()
  const register: IpcRegistrar['handle'] = (channel, listener) => {
    listeners.set(channel, listener)
  }
  return { listeners, ipc: { handle: register, handleOnce: register } }
}

afterEach(() => {
  identity.current = null
})

describe('product copy boundaries', () => {
  it('leave upstream builds alone', () => {
    const { ipc } = fakeIpc()
    const { handle } = ipc
    brandIpcHandlerErrors(ipc)
    expect(ipc.handle).toBe(handle)
    expect(errorResponse('1', { runtimeId: 'r' }, 'x', 'Orca is not running').error.message).toBe(
      'Orca is not running'
    )
    expect(brandErrorCopy('Restart Orca')).toBe('Restart Orca')
  })

  it('brand IPC handler rejections and keep their results and fields', async () => {
    identity.current = podIdentityWithoutStablyServices()
    const { listeners, ipc } = fakeIpc()
    brandIpcHandlerErrors(ipc)
    ipc.handle('ok', () => 'Orca Notes')
    ipc.handleOnce('fails', () => {
      throw Object.assign(
        new Error('Refusing to replace non-Orca command at /usr/local/bin/orca.'),
        {
          code: 'refused'
        }
      )
    })
    await expect(listeners.get('ok')?.(EVENT)).resolves.toBe('Orca Notes')
    await expect(listeners.get('fails')?.(EVENT)).rejects.toMatchObject({
      message: 'Refusing to replace non-Pod command at /usr/local/bin/orca.',
      code: 'refused'
    })
  })

  it('brand RPC error messages, not their codes or data', () => {
    identity.current = podIdentityWithoutStablyServices()
    expect(
      errorResponse('1', { runtimeId: 'r' }, 'runtime_unavailable', 'Orca is not running.', {
        hint: 'Orca'
      }).error
    ).toEqual({
      code: 'runtime_unavailable',
      message: 'Pod is not running.',
      data: { hint: 'Orca' }
    })
  })
})
