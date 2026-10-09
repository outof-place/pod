import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  encodeOgdFrame,
  encodeOgdJsonFrame,
  OGD_FRAME_BINARY,
  OgdFrameDecoder
} from './ogd-frame-codec'
import { isOgdMessage, type OgdMessage } from './ogd-connection'

// Test double for the ogd daemon: speaks protocol v1 framing over a private unix socket.

export type OgdMockReply =
  | { message: OgdMessage; binary?: Buffer }
  | { error: { code: string; message?: string } }
  | 'hang'
  | 'close'

export type OgdMockServer = {
  socketPath: string
  requests: OgdMessage[]
  connections: number
  close: () => Promise<void>
}

export async function startOgdMockServer(options: {
  features?: string[]
  proto?: number
  handle: (request: OgdMessage) => OgdMockReply | Promise<OgdMockReply>
}): Promise<OgdMockServer> {
  const dir = mkdtempSync(join(tmpdir(), 'ogd-mock-'))
  const socketPath = join(dir, 'ogd.sock')
  const sockets = new Set<Socket>()
  const state: OgdMockServer = {
    socketPath,
    requests: [],
    connections: 0,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) {
          socket.destroy()
        }
        server.close(() => {
          rmSync(dir, { recursive: true, force: true })
          resolve()
        })
      })
  }
  const server: Server = createServer((socket) => {
    state.connections++
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => undefined)
    const decoder = new OgdFrameDecoder()
    let greeted = false
    socket.on('data', (chunk: Buffer) => {
      for (const frame of decoder.push(chunk)) {
        const parsed: unknown = JSON.parse(frame.payload.toString('utf8'))
        if (!isOgdMessage(parsed)) {
          continue
        }
        if (!greeted) {
          greeted = true
          const proto = options.proto ?? 1
          if (parsed.proto !== proto) {
            socket.end(
              encodeOgdJsonFrame({
                ok: false,
                error: { code: 'proto', message: 'unsupported proto' },
                proto_supported: [proto]
              })
            )
            continue
          }
          socket.write(
            encodeOgdJsonFrame({
              ok: true,
              proto,
              server: 'ogd/mock',
              pid: process.pid,
              features: options.features ?? []
            })
          )
          continue
        }
        state.requests.push(parsed)
        void Promise.resolve(options.handle(parsed)).then((reply) => {
          if (reply === 'hang') {
            return
          }
          if (reply === 'close') {
            socket.destroy()
            return
          }
          if ('error' in reply) {
            socket.write(encodeOgdJsonFrame({ id: parsed.id, ok: false, error: reply.error }))
            return
          }
          const binary = reply.binary
          socket.write(
            encodeOgdJsonFrame({
              ...reply.message,
              id: parsed.id,
              ok: true,
              ...(binary ? { bin: binary.length } : {})
            })
          )
          if (binary) {
            socket.write(encodeOgdFrame(OGD_FRAME_BINARY, binary))
          }
        })
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  return state
}
