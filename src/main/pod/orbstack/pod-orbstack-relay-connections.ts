// Fork-only (Pod): the relay's wire format and its two kinds of VM connection.
import type { Socket } from 'node:net'
import { Duplex } from 'node:stream'
import { HOOK_CONTINUE, hookRejection, readHookRequest } from './pod-orbstack-hook-filter'
import { RELAY_FRAME, RELAY_HEADER_BYTES } from './pod-orbstack-relay-agent'

/** Claude hook posts from the VM to Pod's hook server. */
export type SandboxHookRoute = {
  /** Port the hook script posts to inside the VM: the hook server's own, so the script is unchanged. */
  vmPort: number
  hostPort: number
  /** The hook server's token. It never enters the VM. */
  hookToken: string
  /** Checks the sandbox's own token, which the VM sends in its place. */
  authorize: (token: string) => boolean
}

export function encodeRelayFrame(kind: number, conn: number, payload?: Uint8Array): Buffer {
  const header = Buffer.alloc(RELAY_HEADER_BYTES)
  header.writeUInt8(kind, 0)
  header.writeUInt32BE(conn, 1)
  header.writeUInt32BE(payload?.byteLength ?? 0, 5)
  return payload ? Buffer.concat([header, payload]) : header
}

/** Splits a byte stream into frames; returns the leftover bytes of an incomplete one. */
export function decodeRelayFrames(
  buffered: Buffer,
  onFrame: (kind: number, conn: number, payload: Buffer) => void
): Buffer {
  let offset = 0
  while (buffered.length - offset >= RELAY_HEADER_BYTES) {
    const length = buffered.readUInt32BE(offset + 5)
    const end = offset + RELAY_HEADER_BYTES + length
    if (buffered.length < end) {
      break
    }
    onFrame(
      buffered.readUInt8(offset),
      buffered.readUInt32BE(offset + 1),
      buffered.subarray(offset + RELAY_HEADER_BYTES, end)
    )
    offset = end
  }
  return buffered.subarray(offset)
}

export type Send = (kind: number, conn: number, payload?: Uint8Array) => boolean

/** One VM connection: buffer one hook post, check it, then forward it or answer it here. */
export function hookConnection(
  conn: number,
  route: SandboxHookRoute,
  send: Send,
  dial: (port: number) => Socket,
  done: () => void
) {
  let buffered = Buffer.alloc(0)
  let continued = false
  let state: 'reading' | 'forwarded' | 'rejected' = 'reading'
  let upstream: Socket | null = null
  const reject = (status: number): void => {
    state = 'rejected'
    buffered = Buffer.alloc(0)
    send(RELAY_FRAME.data, conn, hookRejection(status))
    send(RELAY_FRAME.end, conn)
  }
  return {
    data(chunk: Buffer): void {
      if (state !== 'reading') {
        return
      }
      buffered = Buffer.concat([buffered, chunk])
      const verdict = readHookRequest(buffered, route)
      if (verdict.kind === 'reject') {
        reject(verdict.status)
      } else if (verdict.kind === 'incomplete') {
        if (verdict.expectContinue && !continued) {
          continued = true
          send(RELAY_FRAME.data, conn, HOOK_CONTINUE)
        }
      } else {
        state = 'forwarded'
        buffered = Buffer.alloc(0)
        const socket = dial(route.hostPort)
        upstream = socket
        socket.on('data', (reply: Buffer) => send(RELAY_FRAME.data, conn, reply))
        socket.on('end', () => send(RELAY_FRAME.end, conn))
        socket.on('error', () => socket.destroy())
        socket.on('close', () => {
          send(RELAY_FRAME.close, conn)
          done()
        })
        socket.write(verdict.request)
      }
    },
    end(): void {
      if (state === 'reading') {
        reject(400)
      } else if (state === 'rejected') {
        send(RELAY_FRAME.close, conn)
        done()
      }
    },
    close(): void {
      upstream?.destroy()
      done()
    }
  }
}

/** One VM connection as a stream, for the in-process TLS endpoint of the anthropic-api route. */
export function streamConnection(
  conn: number,
  send: Send,
  waitForDrain: (resume: () => void) => void
) {
  let closedByVm = false
  const stream = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, callback) {
      if (send(RELAY_FRAME.data, conn, chunk)) {
        callback()
      } else {
        waitForDrain(() => callback())
      }
    },
    final(callback) {
      send(RELAY_FRAME.end, conn)
      callback()
    },
    destroy(error, callback) {
      if (!closedByVm) {
        send(RELAY_FRAME.close, conn)
      }
      callback(error)
    }
  })
  return {
    stream,
    data: (chunk: Buffer): void => {
      stream.push(chunk)
    },
    end: (): void => {
      stream.push(null)
    },
    close: (): void => {
      closedByVm = true
      stream.destroy()
    }
  }
}
