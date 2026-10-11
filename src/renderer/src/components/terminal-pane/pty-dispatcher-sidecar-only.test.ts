// Why: main sends a hidden view's bytes "sidecar only" when a raw-byte consumer holds delivery
// interest. They must reach sidecars, never the view (it restores from the model on reveal), and be
// credited on receipt so a throttled hidden renderer cannot pace the PTY.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type PtyDataPayload = { id: string; data: string; sidecarOnly?: boolean }

describe('pty dispatcher sidecar-only delivery', () => {
  let ackData: ReturnType<typeof vi.fn>
  let dataCallback: ((payload: PtyDataPayload) => void) | null = null

  beforeEach(() => {
    vi.resetModules()
    dataCallback = null
    ackData = vi.fn()
    vi.stubGlobal('window', {
      api: {
        pty: {
          setPtyDeliveryInterest: vi.fn(),
          onData: vi.fn((cb: (payload: PtyDataPayload) => void) => {
            dataCallback ??= cb
            return () => {}
          }),
          onReplay: vi.fn(() => () => {}),
          onExit: vi.fn(() => () => {}),
          ackData
        }
      }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('feeds sidecars, skips the view, and credits on receipt', async () => {
    const { registerEagerPtyBuffer } = await import('./pty-dispatcher')
    const { subscribeToPtyData } = await import('./pty-data-sidecar-subscriptions')
    const handle = registerEagerPtyBuffer('pty-1', vi.fn())
    const sidecar = vi.fn()
    subscribeToPtyData('pty-1', sidecar)

    dataCallback?.({ id: 'pty-1', data: 'agent output', sidecarOnly: true })

    expect(sidecar).toHaveBeenCalledWith('agent output')
    expect(handle.flush()).toBe('')
    expect(ackData).toHaveBeenCalledWith('pty-1', 12, 12)
  })

  it('credits a sidecar-only chunk even when a sidecar throws', async () => {
    const { registerEagerPtyBuffer } = await import('./pty-dispatcher')
    const { subscribeToPtyData } = await import('./pty-data-sidecar-subscriptions')
    registerEagerPtyBuffer('pty-1', vi.fn())
    subscribeToPtyData('pty-1', () => {
      throw new Error('sidecar bug')
    })

    expect(() => dataCallback?.({ id: 'pty-1', data: 'hidden', sidecarOnly: true })).toThrow(
      'sidecar bug'
    )

    expect(ackData).toHaveBeenCalledWith('pty-1', 6, 6)
  })

  it('still hands ordinary chunks to the view and the sidecars', async () => {
    const { registerEagerPtyBuffer } = await import('./pty-dispatcher')
    const { subscribeToPtyData } = await import('./pty-data-sidecar-subscriptions')
    const handle = registerEagerPtyBuffer('pty-1', vi.fn())
    const sidecar = vi.fn()
    subscribeToPtyData('pty-1', sidecar)

    dataCallback?.({ id: 'pty-1', data: 'visible output' })

    expect(sidecar).toHaveBeenCalledWith('visible output')
    expect(handle.flush()).toBe('visible output')
    expect(ackData).toHaveBeenCalledWith('pty-1', 14, 14)
  })

  it('holds sidecar-only teardown output and discards it when the shutdown commits', async () => {
    const { registerEagerPtyBuffer } = await import('./pty-dispatcher')
    const { subscribeToPtyData } = await import('./pty-data-sidecar-subscriptions')
    const { unregisterPtyDataHandlers } = await import('./pty-shutdown-data-suspension')
    registerEagerPtyBuffer('pty-1', vi.fn())
    const sidecar = vi.fn()
    subscribeToPtyData('pty-1', sidecar)
    const [snapshot] = unregisterPtyDataHandlers(['pty-1'])

    dataCallback?.({ id: 'pty-1', data: 'teardown output', sidecarOnly: true })
    expect(sidecar).not.toHaveBeenCalled()
    expect(ackData).toHaveBeenCalledWith('pty-1', 15, 15)
    snapshot.commit()

    expect(sidecar).not.toHaveBeenCalled()
  })

  it('hands held sidecar-only output to sidecars, never the view, when the shutdown rolls back', async () => {
    const { registerEagerPtyBuffer } = await import('./pty-dispatcher')
    const { subscribeToPtyData } = await import('./pty-data-sidecar-subscriptions')
    const { ptyReplayHandlers, unregisterPtyDataHandlers } =
      await import('./pty-shutdown-data-suspension')
    const handle = registerEagerPtyBuffer('pty-1', vi.fn())
    ptyReplayHandlers.set('pty-1', vi.fn())
    const sidecar = vi.fn()
    subscribeToPtyData('pty-1', sidecar)
    const [snapshot] = unregisterPtyDataHandlers(['pty-1'])

    dataCallback?.({ id: 'pty-1', data: 'held', sidecarOnly: true })
    dataCallback?.({ id: 'pty-1', data: 'view' })
    snapshot.rollback()

    expect(sidecar.mock.calls).toEqual([['held'], ['view']])
    expect(handle.flush()).toBe('view')
  })
})
