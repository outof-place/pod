import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { createConnection, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PodLaneClientFrame,
  PodLaneFrameReader,
  PodLaneServerFrame,
  encodePodLaneFence,
  encodePodLaneFrame,
  encodePodLaneJson,
  type PodLaneFrame
} from '../../../shared/pod-terminal-lane-protocol'
import type { PodLanePorts, PodLaneTap } from './pod-lane-connection'
import { PodLaneServer, type PodLaneServerOptions } from './pod-lane-server'
import type { DaemonEvent } from '../types'

const MAIN = 'main-client'
const SESSION = 'session-1'
const servers: PodLaneServer[] = []
const sockets: Socket[] = []
const scratchDirectories: string[] = []

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    socket.destroy()
  }
  for (const server of servers.splice(0)) {
    await server.close()
  }
  for (const directory of scratchDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
  vi.unstubAllEnvs()
})

// Why /tmp: sun_path is 104 bytes and macOS's per-user tmpdir is long.
function scratch(): string {
  const directory = mkdtempSync(
    join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'pod-lane-')
  )
  scratchDirectories.push(directory)
  return directory
}

type Recorder = {
  ports: PodLanePorts
  events: DaemonEvent[]
  writes: string[]
  taps: Map<string, PodLaneTap>
  order: string[]
  log: ReturnType<typeof vi.fn>
}

function recorder(): Recorder {
  const events: DaemonEvent[] = []
  const writes: string[] = []
  const taps = new Map<string, PodLaneTap>()
  const order: string[] = []
  const log = vi.fn()
  return {
    events,
    writes,
    taps,
    order,
    log,
    ports: {
      attachedClientId: (sessionId) => (sessionId === SESSION ? MAIN : undefined),
      attachTap: (sessionId, tap) => {
        if (sessionId !== SESSION) {
          return null
        }
        order.push('tap')
        taps.set(sessionId, tap)
        return Symbol('tap')
      },
      detachTap: (sessionId) => {
        order.push('untap')
        taps.delete(sessionId)
      },
      write: (_sessionId, data) => {
        order.push('write')
        writes.push(data)
      },
      recordInput: () => {},
      enqueueEvent: (_clientId, _sessionId, event) => {
        order.push(event.event === 'podLane' ? `marker:${event.payload.phase}` : event.event)
        events.push(event)
      },
      flush: () => {},
      log
    }
  }
}

async function startServer(overrides: Partial<PodLaneServerOptions> = {}) {
  const rec = recorder()
  const server = new PodLaneServer({
    socketPath: join(scratch(), 'lane.sock'),
    verifyPeer: () => ({ ok: true, pid: 99 }),
    ports: rec.ports,
    ...overrides
  })
  servers.push(server)
  return { server, rec, started: await server.start() }
}

type Client = {
  socket: Socket
  frames: PodLaneFrame[]
  closed: Promise<void>
  next: (type: number) => Promise<PodLaneFrame>
}

function connect(socketPath: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath)
    sockets.push(socket)
    const reader = new PodLaneFrameReader(64 * 1024 * 1024)
    const frames: PodLaneFrame[] = []
    const waiters: (() => void)[] = []
    socket.on('data', (chunk: Buffer) => {
      frames.push(...reader.push(chunk))
      for (const wake of waiters.splice(0)) {
        wake()
      }
    })
    const closed = new Promise<void>((done) => socket.on('close', () => done()))
    const next = async (type: number): Promise<PodLaneFrame> => {
      for (;;) {
        const index = frames.findIndex((frame) => frame.type === type)
        if (index !== -1) {
          const [frame] = frames.splice(index, 1)
          if (frame) {
            return frame
          }
        }
        await new Promise<void>((wake) => waiters.push(wake))
      }
    }
    socket.once('connect', () => resolve({ socket, frames, closed, next }))
    socket.once('error', reject)
  })
}

function json(frame: PodLaneFrame): Record<string, unknown> {
  return JSON.parse(frame.payload.toString('utf8'))
}

function grantFor(server: PodLaneServer, inputOpen = true) {
  const grant = server.route(MAIN, {
    id: '1',
    type: 'podLaneGrant',
    payload: { sessionId: SESSION, inputOpen }
  })
  if (
    typeof grant !== 'object' ||
    grant === null ||
    !('laneId' in grant && typeof grant.laneId === 'string') ||
    !('token' in grant && typeof grant.token === 'string') ||
    !('socketPath' in grant && typeof grant.socketPath === 'string')
  ) {
    throw new Error('no grant')
  }
  return { laneId: grant.laneId, token: grant.token, socketPath: grant.socketPath }
}

async function openLane(server: PodLaneServer, inputOpen = true) {
  const grant = grantFor(server, inputOpen)
  const client = await connect(grant.socketPath)
  client.socket.write(
    encodePodLaneJson(PodLaneClientFrame.Hello, { v: 1, laneId: grant.laneId, token: grant.token })
  )
  await client.next(PodLaneServerFrame.Ready)
  return { client, grant }
}

function tapOf(rec: Recorder): PodLaneTap {
  const tap = rec.taps.get(SESSION)
  if (!tap) {
    throw new Error('no tap')
  }
  return tap
}

const input = (text: string) =>
  encodePodLaneFrame(PodLaneClientFrame.Input, Buffer.from(text, 'utf8'))
const until = (check: () => boolean) => vi.waitFor(() => expect(check()).toBe(true))

describe.runIf(process.platform === 'darwin')('PodLaneServer', () => {
  it('listens 0600 in a private directory, and not at all without the peer check or with the kill switch', async () => {
    const { server, started } = await startServer()
    expect(started).toBe(true)
    const { socketPath } = grantFor(server)
    expect(statSync(socketPath).mode & 0o777).toBe(0o600)

    expect((await startServer({ verifyPeer: null })).started).toBe(false)
    const open = scratch()
    chmodSync(open, 0o755)
    expect((await startServer({ socketPath: join(open, 'lane.sock') })).started).toBe(false)
    vi.stubEnv('POD_TERMINAL_DIRECT_LANE', '0')
    expect((await startServer()).started).toBe(false)
  })

  it('drops a peer that fails the identity check before reading its hello', async () => {
    const { server, rec } = await startServer({
      verifyPeer: () => ({ ok: false, pid: 7, error: 'nope' })
    })
    const grant = grantFor(server)
    const client = await connect(grant.socketPath)
    client.socket.write(encodePodLaneJson(PodLaneClientFrame.Hello, { v: 1, ...grant }))
    await client.closed
    expect(client.frames).toEqual([])
    expect(rec.taps.size).toBe(0)
    expect(rec.log).toHaveBeenCalledWith('pod-lane-peer-refused', { pid: 7, error: 'nope' })
  })

  it('grants only a session attached to the asking main, and a token works once', async () => {
    const { server, rec } = await startServer()
    expect(() =>
      server.route('someone-else', {
        id: '1',
        type: 'podLaneGrant',
        payload: { sessionId: SESSION, inputOpen: true }
      })
    ).toThrow('pod_lane_session_not_attached')
    const { client, grant } = await openLane(server)
    client.socket.destroy()
    const replay = await connect(grant.socketPath)
    replay.socket.write(
      encodePodLaneJson(PodLaneClientFrame.Hello, {
        v: 1,
        laneId: grant.laneId,
        token: grant.token
      })
    )
    await replay.closed
    expect(replay.frames).toEqual([])
    expect(rec.events.filter((event) => event.event === 'podLane')).toHaveLength(2)
  })

  it('puts the marker in main stream before the tap, then sends output and the exit', async () => {
    const { server, rec } = await startServer()
    const { client } = await openLane(server)
    expect(rec.order.slice(0, 2)).toEqual(['marker:attached', 'tap'])
    tapOf(rec).onData('héllo')
    expect((await client.next(PodLaneServerFrame.Output)).payload.toString('utf8')).toBe('héllo')
    tapOf(rec).onExit(3)
    expect(json(await client.next(PodLaneServerFrame.Exit))).toEqual({ code: 3 })
    expect(json(await client.next(PodLaneServerFrame.Closed))).toEqual({ reason: 'exited' })
    expect(rec.events.at(-1)).toMatchObject({
      event: 'podLane',
      payload: { phase: 'detached', reason: 'exited' }
    })
  })

  it('records input in main stream before each write, and chunks a paste', async () => {
    const { server, rec } = await startServer()
    const { client } = await openLane(server)
    client.socket.write(input('ls\r'))
    await until(() => rec.writes.length === 1)
    expect(rec.order.slice(-2)).toEqual(['podLaneInput', 'write'])
    expect(rec.events.at(-1)).toMatchObject({ event: 'podLaneInput', payload: { data: 'ls\r' } })
    const paste = 'x'.repeat(40 * 1024)
    client.socket.write(input(paste))
    await until(() => rec.writes.join('').length === 3 + paste.length)
    expect(rec.writes.length).toBe(1 + 3)
    expect(rec.events.at(-1)).toMatchObject({ event: 'podLaneInput', payload: { truncated: true } })
  })

  it('drops input while main keeps the gate closed (a phone drives)', async () => {
    const { server, rec } = await startServer()
    const { client, grant } = await openLane(server, false)
    client.socket.write(input('a'))
    expect(json(await client.next(PodLaneServerFrame.Dropped))).toEqual({
      bytes: 1,
      reason: 'locked'
    })
    server.route(MAIN, {
      id: 'n',
      type: 'podLaneGate',
      payload: { laneId: grant.laneId, open: true }
    })
    client.socket.write(input('b'))
    await until(() => rec.writes.join('') === 'b')
  })

  it('holds input behind a viewport fence until main settles it, and drops it if the claim failed', async () => {
    const { server, rec } = await startServer()
    const { client, grant } = await openLane(server)
    client.socket.write(Buffer.concat([encodePodLaneFence(1), input('a')]))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(rec.writes).toEqual([])
    server.route(MAIN, {
      id: 'n',
      type: 'podLaneSettle',
      payload: { laneId: grant.laneId, fence: 1, applied: true }
    })
    expect(rec.writes).toEqual(['a'])

    client.socket.write(Buffer.concat([encodePodLaneFence(2), input('bc')]))
    await new Promise((resolve) => setTimeout(resolve, 20))
    server.route(MAIN, {
      id: 'n',
      type: 'podLaneSettle',
      payload: { laneId: grant.laneId, fence: 2, applied: false }
    })
    expect(json(await client.next(PodLaneServerFrame.Dropped))).toEqual({
      bytes: 2,
      reason: 'claim'
    })
    expect(rec.writes).toEqual(['a'])
  })

  it('lets held input through when main never settles the fence', async () => {
    const { server, rec } = await startServer({ holdTimeoutMs: 30 })
    const { client } = await openLane(server)
    client.socket.write(Buffer.concat([encodePodLaneFence(5), input('z')]))
    await until(() => rec.writes.join('') === 'z')
    expect(rec.log).toHaveBeenCalledWith(
      'pod-lane-fence-timeout',
      expect.objectContaining({ pendingFence: 5 })
    )
  })

  it('ends lanes with main connection, on revoke, on backpressure and on a bad frame', async () => {
    const { server, rec } = await startServer()
    const first = await openLane(server)
    server.onMainDisconnected(MAIN)
    expect(json(await first.client.next(PodLaneServerFrame.Closed))).toEqual({
      reason: 'main-disconnected'
    })

    const second = await openLane(server)
    server.route(MAIN, {
      id: 'n',
      type: 'podLaneRevoke',
      payload: { laneId: second.grant.laneId, reason: 'stream-detached' }
    })
    expect(json(await second.client.next(PodLaneServerFrame.Closed))).toEqual({
      reason: 'stream-detached'
    })

    const third = await openLane(server)
    third.client.socket.write(encodePodLaneFrame(9, Buffer.from('?')))
    expect(json(await third.client.next(PodLaneServerFrame.Closed))).toEqual({
      reason: 'bad-frame'
    })
    expect(rec.taps.size).toBe(0)

    const tight = await startServer({ maxBufferedBytes: -1 })
    const fourth = await openLane(tight.server)
    tapOf(tight.rec).onData('x')
    expect(json(await fourth.client.next(PodLaneServerFrame.Closed))).toEqual({
      reason: 'backpressure'
    })
  })

  it('replaces an earlier lane on the same session', async () => {
    const { server, rec } = await startServer()
    const first = await openLane(server)
    await openLane(server)
    expect(json(await first.client.next(PodLaneServerFrame.Closed))).toEqual({ reason: 'replaced' })
    expect(rec.taps.size).toBe(1)
  })
})
