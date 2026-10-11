// Triage repro for stablyai/orca#27033 review findings (b) and (c). Each "bug" test asserts the
// behavior the ordinary delivery path already has, so it FAILS on the sidecar-only early return.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type PtyDataPayload = { id: string; data: string; sidecarOnly?: boolean }

describe('#27033 triage: sidecar-only early return', () => {
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

  async function setup(): Promise<{
    unregisterPtyDataHandlers: (ids: string[]) => { commit: () => void; rollback: () => void }[]
  }> {
    const { registerEagerPtyBuffer } = await import('./pty-dispatcher')
    const { unregisterPtyDataHandlers } = await import('./pty-shutdown-data-suspension')
    registerEagerPtyBuffer('pty-1', vi.fn())
    return { unregisterPtyDataHandlers }
  }

  it('control: ordinary chunk still credits main when a sidecar throws', async () => {
    await setup()
    const { subscribeToPtyData } = await import('./pty-data-sidecar-subscriptions')
    subscribeToPtyData('pty-1', () => {
      throw new Error('sidecar bug')
    })
    expect(() => dataCallback?.({ id: 'pty-1', data: 'visible' })).toThrow('sidecar bug')
    expect(ackData).toHaveBeenCalledWith('pty-1', 7, 7)
  })

  it('(b) sidecar-only chunk credits main when a sidecar throws', async () => {
    await setup()
    const { subscribeToPtyData } = await import('./pty-data-sidecar-subscriptions')
    subscribeToPtyData('pty-1', () => {
      throw new Error('sidecar bug')
    })
    expect(() => dataCallback?.({ id: 'pty-1', data: 'hidden', sidecarOnly: true })).toThrow(
      'sidecar bug'
    )
    // Bug: ackPtyData sits after the sidecar loop with no finally, so these 6 chars stay
    // in-flight forever (received > acked also blocks main's delivery-heal write-off).
    expect(ackData).toHaveBeenCalledWith('pty-1', 6, 6)
  })

  it('control: ordinary chunk during a pending shutdown is held, then discarded on commit', async () => {
    const { unregisterPtyDataHandlers } = await setup()
    const { subscribeToPtyData } = await import('./pty-data-sidecar-subscriptions')
    const sidecar = vi.fn()
    subscribeToPtyData('pty-1', sidecar)
    const [snapshot] = unregisterPtyDataHandlers(['pty-1'])
    dataCallback?.({ id: 'pty-1', data: 'teardown output' })
    expect(sidecar).not.toHaveBeenCalled()
    snapshot.commit()
    expect(sidecar).not.toHaveBeenCalled()
  })

  it('(c) sidecar-only chunk during a pending shutdown is held like an ordinary chunk', async () => {
    const { unregisterPtyDataHandlers } = await setup()
    const { subscribeToPtyData } = await import('./pty-data-sidecar-subscriptions')
    const sidecar = vi.fn()
    subscribeToPtyData('pty-1', sidecar)
    const [snapshot] = unregisterPtyDataHandlers(['pty-1'])
    dataCallback?.({ id: 'pty-1', data: 'teardown output', sidecarOnly: true })
    // Bug: the early return skips isPtyDataHandlerShutdownPending, so sidecars see speculative
    // teardown output at once, and a committed shutdown cannot take it back.
    expect(sidecar).not.toHaveBeenCalled()
    snapshot.commit()
    expect(sidecar).not.toHaveBeenCalled()
  })
})
