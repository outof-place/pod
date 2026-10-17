import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PodSshPortEvent } from '../../../shared/pod-ssh-port-events'

const mocks = vi.hoisted(() => ({
  listForwards: vi.fn(),
  window: null as null | { isDestroyed: () => boolean; webContents: { send: () => void } }
}))

vi.mock('../../ipc/ssh-ipc-context', () => ({
  connectionManager: null,
  currentRuntime: undefined,
  getCurrentMainWindow: () => mocks.window,
  persistedStore: null,
  portForwardManager: { listForwards: mocks.listForwards }
}))

const { broadcastDetectedPorts, broadcastPortForwards } =
  await import('../../ipc/ssh-renderer-broadcast')
const { getCurrentMainWindow } = await import('../../ipc/ssh-ipc-context')
const { publishPodSshPortEvent, subscribePodSshPortEvents } =
  await import('./pod-ssh-port-forwards')

const forward = {
  id: 'fwd-1',
  connectionId: 'ssh-1',
  localPort: 5173,
  remoteHost: 'localhost',
  remotePort: 5173
}

let stops: (() => void)[] = []
afterEach(() => {
  stops.forEach((stop) => stop())
  stops = []
  mocks.window = null
  vi.clearAllMocks()
})

function listen(): PodSshPortEvent[] {
  const events: PodSshPortEvent[] = []
  stops.push(subscribePodSshPortEvents((event) => events.push(event)))
  return events
}

describe('SSH port events for Pod clients', () => {
  it('builds nothing while no client listens', () => {
    const build = vi.fn((): PodSshPortEvent => ({
      type: 'sshPortForwardsChanged',
      targetId: 'ssh-1',
      forwards: []
    }))
    publishPodSshPortEvent(build)
    expect(build).not.toHaveBeenCalled()
  })

  it("publishes a host's forwards on a windowless host, as the desktop's broadcast lists them", () => {
    mocks.listForwards.mockReturnValue([forward])
    const events = listen()

    broadcastPortForwards(getCurrentMainWindow, 'ssh-1')

    expect(mocks.listForwards).toHaveBeenCalledWith('ssh-1')
    expect(events).toEqual([
      { type: 'sshPortForwardsChanged', targetId: 'ssh-1', forwards: [forward] }
    ])
  })

  it('publishes detected ports beside the window', () => {
    const send = vi.fn()
    mocks.window = { isDestroyed: () => false, webContents: { send } }
    const events = listen()
    const ports = [{ port: 3000, host: '127.0.0.1', processName: 'node' }]

    broadcastDetectedPorts(getCurrentMainWindow, 'ssh-1', ports)

    expect(events).toEqual([{ type: 'sshDetectedPortsChanged', targetId: 'ssh-1', ports }])
    expect(send).toHaveBeenCalledWith('ssh:detected-ports-changed', { targetId: 'ssh-1', ports })
  })
})
