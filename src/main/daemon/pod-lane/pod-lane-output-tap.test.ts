import { describe, expect, it } from 'vitest'
import { SessionOutputPlane } from '../session-output-plane'

describe('SessionOutputPlane direct-lane tap (not a viewer for flow control)', () => {
  it('gets what attached clients get, before the emulator has parsed it, and the exit', async () => {
    const plane = new SessionOutputPlane({ cols: 80, rows: 24 })
    const tapped: string[] = []
    const client: string[] = []
    let exited: number | null = null
    const viewer = plane.attachClient({ onData: (data) => client.push(data), onExit: () => {} })
    const tap = plane.attachClient({
      onData: (data) =>
        tapped.push(`${data}|${plane.getSnapshot()?.snapshotAnsi.includes('hello') ?? false}`),
      onExit: (code) => {
        exited = code
      },
      podLane: true
    })
    expect(plane.hasAttachedClients).toBe(true)
    plane.installDeviceAttributesFilter()
    plane.emit({ data: 'hello\x1b[c\x1b[', rawStartSeq: 0, rawEndSeq: 11, transformed: false })
    expect(client).toEqual(['hello'])
    expect(tapped).toEqual(['hello|false'])
    await plane.flushParsedWrites()

    plane.releaseDeviceAttributesFilter()
    expect(tapped.at(-1)).toBe('\x1b[|true')
    plane.detachClient(tap)
    plane.emit({ data: 'more', rawStartSeq: 11, rawEndSeq: 15, transformed: false })
    expect(tapped).toHaveLength(2)
    plane.detachClient(viewer)
    expect(plane.hasAttachedClients).toBe(false)

    plane.attachClient({ onData: () => {}, onExit: (code) => (exited = code), podLane: true })
    plane.broadcastExit(2, 'incarnation')
    expect(exited).toBe(2)
    plane.disposeEmulator()
  })
})
