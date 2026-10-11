// The local stream's two bounds: buffered bytes per socket, and request slots that streams never take.
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { connect, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { UnixSocketStreamConnection } from './unix-socket-stream-connection'
import { UnixSocketTransport } from './unix-socket-transport'
import { RUNTIME_LOCAL_STREAM_UPGRADE_METHOD } from '../../../shared/runtime-local-stream-protocol'

class CountingSocket extends EventEmitter {
  destroyed = false
  writable = true
  writableLength = 0
  write(data: Buffer): boolean {
    this.writableLength += data.length
    return true
  }
  destroy(): this {
    this.destroyed = true
    this.writable = false
    this.emit('close')
    return this
  }
}

describe('UnixSocketStreamConnection buffered-bytes ceiling', () => {
  it('never queues more than the per-socket ceiling for a text reply', () => {
    const ceiling = 1024
    const socket = new CountingSocket()
    socket.writableLength = ceiling - 10
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the connection uses only write, writableLength, writable, destroyed, destroy and the close event.
    const connection = new UnixSocketStreamConnection(socket as unknown as Socket, ceiling)
    connection.sendText('x'.repeat(64 * 1024))
    expect(socket.writableLength).toBeLessThanOrEqual(ceiling)
    // A reply can't be dropped silently: the connection closes, and the client resyncs.
    expect(socket.destroyed).toBe(true)
  })
})

describe('UnixSocketTransport request slots', () => {
  const sockets: Socket[] = []
  let transport: UnixSocketTransport | null = null
  let dir: string | null = null
  afterEach(async () => {
    for (const socket of sockets) {
      socket.destroy()
    }
    sockets.length = 0
    await transport?.stop()
    transport = null
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
      dir = null
    }
  })

  function openClient(
    endpoint: string
  ): Promise<{ socket: Socket; firstLine: Promise<string | null> }> {
    return new Promise((resolve, reject) => {
      const socket = connect(endpoint)
      sockets.push(socket)
      const firstLine = new Promise<string | null>((done) => {
        let buffered = ''
        socket.on('data', (chunk) => {
          buffered += chunk.toString('utf8')
          const newline = buffered.indexOf('\n')
          if (newline !== -1) {
            done(buffered.slice(0, newline))
          }
        })
        socket.on('close', () => done(null))
        socket.on('error', () => done(null))
      })
      socket.once('connect', () => resolve({ socket, firstLine }))
      socket.once('error', reject)
    })
  }

  it('still answers a CLI call while 32 long-lived streams are open', async () => {
    // Why /tmp: sun_path is 104 bytes, and the test temp dir can be longer.
    dir = mkdtempSync('/tmp/uss-')
    const endpoint = join(dir, 's.sock')
    transport = new UnixSocketTransport({ endpoint, kind: 'unix' })
    transport.onMessage((_message, reply) => reply('{"ok":true}'))
    transport.onStreamUpgrade((_raw, upgrade) => {
      upgrade.accept('{"ok":true,"upgraded":true}')?.bind({
        onText: () => {},
        onBinary: () => {},
        onClose: () => {}
      })
    })
    await transport.start()

    const upgradeLine = JSON.stringify({
      id: 'u',
      method: RUNTIME_LOCAL_STREAM_UPGRADE_METHOD,
      params: { protocol: 'orca-local-stream', versions: [1] }
    })
    for (let index = 0; index < 32; index += 1) {
      const client = await openClient(endpoint)
      client.socket.write(`${upgradeLine}\n`)
      expect(await client.firstLine).toContain('upgraded')
    }

    const cli = await openClient(endpoint)
    cli.socket.write('{"id":"cli","method":"status.get"}\n')
    expect(await cli.firstLine).toBe('{"ok":true}')
  })
})
