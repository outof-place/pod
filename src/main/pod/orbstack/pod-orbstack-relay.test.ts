import { execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, connect, type AddressInfo, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { spawnProcess } from '../../../shared/child-process/run-process'
import { RELAY_FRAME } from './pod-orbstack-relay-agent'
import {
  buildRelayWait,
  createSandboxRelays,
  decodeRelayFrames,
  encodeRelayFrame,
  type SandboxRelays
} from './pod-orbstack-relay'

function hasPython(): boolean {
  try {
    execFileSync('python3', ['-I', '-c', 'pass'])
    return true
  } catch {
    return false
  }
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address: AddressInfo | string | null = server.address()
  return typeof address === 'object' && address ? address.port : 0
}

async function freePort(): Promise<number> {
  const server = createServer()
  const port = await listen(server)
  await new Promise((resolve) => server.close(resolve))
  return port
}

function roundTrip(port: number, payload: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port })
    const chunks: Buffer[] = []
    socket.on('data', (chunk: Buffer) => chunks.push(chunk))
    socket.on('end', () => resolve(Buffer.concat(chunks)))
    socket.on('error', reject)
    socket.end(payload)
  })
}

describe('relay frames', () => {
  it('round-trips frames split at any byte', () => {
    const bytes = Buffer.concat([
      encodeRelayFrame(RELAY_FRAME.open, 7, Buffer.from([1])),
      encodeRelayFrame(RELAY_FRAME.data, 7, Buffer.from('hello')),
      encodeRelayFrame(RELAY_FRAME.end, 7)
    ])
    for (let split = 0; split <= bytes.length; split += 1) {
      const frames: [number, number, string][] = []
      const collect = (kind: number, conn: number, payload: Buffer) =>
        frames.push([kind, conn, payload.toString('hex')])
      const rest = decodeRelayFrames(bytes.subarray(0, split), collect)
      expect(decodeRelayFrames(Buffer.concat([rest, bytes.subarray(split)]), collect)).toHaveLength(
        0
      )
      expect(frames).toEqual([
        [RELAY_FRAME.open, 7, '01'],
        [RELAY_FRAME.data, 7, Buffer.from('hello').toString('hex')],
        [RELAY_FRAME.end, 7, '']
      ])
    }
  })

  it('waits for this relay by nonce, then gives up', () => {
    expect(buildRelayWait('abc123', '/run/x')).toBe(
      'w=0; until [ "$(cat /run/x/ready 2>/dev/null)" = abc123 ] || [ $w -ge 150 ]; do sleep 0.1; w=$((w+1)); done;'
    )
  })
})

describe('host side', () => {
  it('dials only the listed routes, whatever the VM asks for', async () => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const fake = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr: new PassThrough(),
      kill: () => true
    })
    const dialed: number[] = []
    const relays = createSandboxRelays({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the relay touches only stdin/stdout/stderr, kill and events, all present on the fake.
      spawnAgent: () => fake as unknown as ChildProcessWithoutNullStreams,
      connectHost: (port) => {
        dialed.push(port)
        return connect({ host: '127.0.0.1', port })
      }
    })
    relays.ensure('pod-x-sbx', [{ vmPort: 1, hostPort: 1 }])
    const replies: number[][] = []
    stdin.on('data', (chunk: Buffer) => {
      decodeRelayFrames(chunk, (kind, conn) => replies.push([kind, conn]))
    })
    stdout.write(encodeRelayFrame(RELAY_FRAME.open, 9, Buffer.from([4])))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(dialed).toEqual([])
    expect(replies).toEqual([[RELAY_FRAME.close, 9]])
  })
})

describe.skipIf(process.platform === 'win32' || !hasPython())('relay agent over stdio', () => {
  const cleanups: (() => void)[] = []
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup()
    }
  })

  async function setup() {
    const stateDir = mkdtempSync(join(tmpdir(), 'pod-relay-'))
    const echo = createServer({ allowHalfOpen: true }, (socket) => socket.pipe(socket))
    const hostPort = await listen(echo)
    const vmPort = await freePort()
    const relays: SandboxRelays = createSandboxRelays({
      stateDir,
      spawnAgent: (_machine, args) => spawnProcess({ program: 'python3', args })
    })
    cleanups.push(() => {
      relays.stopAll()
      echo.close()
      rmSync(stateDir, { recursive: true, force: true })
    })
    return { relays, vmPort, hostPort, stateDir }
  }

  it('carries concurrent connections both ways, including half-close and large bodies', async () => {
    const { relays, vmPort, hostPort, stateDir } = await setup()
    const handle = relays.ensure('pod-x-sbx', [{ vmPort, hostPort }])
    expect(await handle.ready).toBe(true)
    expect(readFileSync(join(stateDir, 'ready'), 'utf8')).toBe(handle.nonce)

    const big = Buffer.alloc(3 * 1024 * 1024, 7)
    const results = await Promise.all([
      roundTrip(vmPort, Buffer.from('hook post')),
      roundTrip(vmPort, big),
      roundTrip(vmPort, Buffer.from('second'))
    ])
    expect(results[0]?.toString()).toBe('hook post')
    expect(results[1]?.equals(big)).toBe(true)
    expect(results[2]?.toString()).toBe('second')
  })

  it('reuses a live relay with the same routes and replaces it when they change', async () => {
    const { relays, vmPort, hostPort } = await setup()
    const first = relays.ensure('pod-x-sbx', [{ vmPort, hostPort }])
    expect(await first.ready).toBe(true)
    expect(relays.ensure('pod-x-sbx', [{ vmPort, hostPort }])).toBe(first)

    const otherPort = await freePort()
    const second = relays.ensure('pod-x-sbx', [
      { vmPort, hostPort },
      { vmPort: otherPort, hostPort }
    ])
    expect(second.nonce).not.toBe(first.nonce)
    expect(await second.ready).toBe(true)
    expect((await roundTrip(otherPort, Buffer.from('again'))).toString()).toBe('again')
  })
})
