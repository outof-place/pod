import { createConnection, type Socket } from 'node:net'
import {
  encodeOgdJsonFrame,
  OGD_FRAME_BINARY,
  OGD_FRAME_JSON,
  OgdFrameDecoder,
  OgdProtocolError,
  type OgdFrame
} from './ogd-frame-codec'

export const OGD_PROTOCOL_VERSION = 1

export type OgdMessage = Record<string, unknown>
export type OgdReply = { message: OgdMessage; binary: Buffer | null }

/** No daemon, a dropped connection or a connect timeout: callers fall back without retrying now. */
export class OgdUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OgdUnavailableError'
  }
}

export class OgdVersionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OgdVersionError'
  }
}

export class OgdTimeoutError extends Error {
  constructor(op: string) {
    super(`ogd ${op} timed out`)
    this.name = 'OgdTimeoutError'
  }
}

export class OgdAbortedError extends Error {
  constructor(op: string) {
    super(`ogd ${op} aborted`)
    this.name = 'OgdAbortedError'
  }
}

/** The daemon answered `ok:false`; `code` is the protocol's error code (`not_indexed`, `busy`, ...). */
export class OgdRequestError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'OgdRequestError'
  }
}

export function isOgdMessage(value: unknown): value is OgdMessage {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requestError(message: OgdMessage): OgdRequestError {
  const error = message.error
  const code = isOgdMessage(error) && typeof error.code === 'string' ? error.code : 'internal'
  const text = isOgdMessage(error) && typeof error.message === 'string' ? error.message : code
  return new OgdRequestError(code, text)
}

type PendingRequest = {
  op: string
  resolve: (reply: OgdReply) => void
  reject: (error: Error) => void
  cleanup: () => void
}

export type OgdRequestOptions = { signal?: AbortSignal; timeoutMs: number }

/** One handshaken connection. Requests are answered in order and matched by `id`. */
export class OgdConnection {
  private readonly decoder = new OgdFrameDecoder()
  private readonly pending = new Map<number, PendingRequest>()
  private awaitingBinary: OgdMessage | null = null
  private hello: PendingRequest | null = null
  private nextId = 1
  private failure: Error | null = null
  features: readonly string[] = []
  server = ''

  private constructor(private readonly socket: Socket) {
    socket.on('data', (chunk: Buffer) => this.onData(chunk))
    socket.on('error', (error) => this.fail(new OgdUnavailableError(error.message)))
    socket.on('close', () => this.fail(new OgdUnavailableError('ogd connection closed')))
  }

  static open(
    socketPath: string,
    handshake: { client: string; timeoutMs: number }
  ): Promise<OgdConnection> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(socketPath)
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new OgdUnavailableError('ogd connect timed out'))
      }, handshake.timeoutMs)
      const onConnectError = (error: Error): void => {
        clearTimeout(timer)
        reject(new OgdUnavailableError(error.message))
      }
      socket.once('error', onConnectError)
      socket.once('connect', () => {
        clearTimeout(timer)
        socket.off('error', onConnectError)
        const connection = new OgdConnection(socket)
        connection.handshake(handshake).then(
          () => resolve(connection),
          (error: Error) => {
            connection.close()
            reject(error)
          }
        )
      })
    })
  }

  get usable(): boolean {
    return this.failure === null
  }

  hasFeature(feature: string): boolean {
    return this.features.includes(feature)
  }

  request(op: string, fields: OgdMessage, options: OgdRequestOptions): Promise<OgdReply> {
    if (this.failure) {
      return Promise.reject(this.failure)
    }
    if (options.signal?.aborted) {
      return Promise.reject(new OgdAbortedError(op))
    }
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        cleanup()
        reject(new OgdTimeoutError(op))
        // Why close: requests are served in order, so a stuck one would stall every later one.
        this.close()
      }, options.timeoutMs)
      const onAbort = (): void => {
        this.pending.delete(id)
        cleanup()
        reject(new OgdAbortedError(op))
        this.close()
      }
      const cleanup = (): void => {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, { op, resolve, reject, cleanup })
      this.socket.write(encodeOgdJsonFrame({ ...fields, op, id }))
    })
  }

  close(): void {
    this.fail(new OgdUnavailableError('ogd connection closed'))
    this.socket.destroy()
  }

  private handshake(handshake: { client: string; timeoutMs: number }): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new OgdUnavailableError('ogd hello timed out'))
      }, handshake.timeoutMs)
      this.hello = {
        op: 'hello',
        resolve: ({ message }) => {
          if (message.ok !== true || message.proto !== OGD_PROTOCOL_VERSION) {
            reject(
              new OgdVersionError(
                `ogd speaks protocol ${String(message.proto ?? message.proto_supported)}, Orca speaks ${OGD_PROTOCOL_VERSION}`
              )
            )
            return
          }
          const features = message.features
          this.features = Array.isArray(features)
            ? features.filter((item): item is string => typeof item === 'string')
            : []
          this.server = typeof message.server === 'string' ? message.server : ''
          resolve()
        },
        reject,
        cleanup: () => clearTimeout(timer)
      }
      this.socket.write(
        encodeOgdJsonFrame({
          op: 'hello',
          proto: OGD_PROTOCOL_VERSION,
          client: handshake.client,
          pid: process.pid
        })
      )
    })
  }

  private onData(chunk: Buffer): void {
    let frames: OgdFrame[]
    try {
      frames = this.decoder.push(chunk)
    } catch (error) {
      this.fail(error instanceof Error ? error : new OgdProtocolError(String(error)))
      this.socket.destroy()
      return
    }
    for (const frame of frames) {
      this.onFrame(frame)
    }
  }

  private onFrame(frame: OgdFrame): void {
    if (frame.kind === OGD_FRAME_BINARY) {
      const message = this.awaitingBinary
      this.awaitingBinary = null
      // Why tolerate a stray binary frame: an empty attachment may or may not be sent for `bin: 0`.
      if (message) {
        this.deliver(message, frame.payload)
      }
      return
    }
    if (frame.kind !== OGD_FRAME_JSON) {
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(frame.payload.toString('utf8'))
    } catch {
      this.fail(new OgdProtocolError('ogd sent malformed JSON'))
      this.socket.destroy()
      return
    }
    if (!isOgdMessage(parsed)) {
      return
    }
    if (typeof parsed.bin === 'number' && parsed.bin > 0) {
      this.awaitingBinary = parsed
      return
    }
    this.deliver(parsed, null)
  }

  private deliver(message: OgdMessage, binary: Buffer | null): void {
    if (this.hello) {
      const hello = this.hello
      this.hello = null
      hello.cleanup()
      hello.resolve({ message, binary })
      return
    }
    const id = message.id
    const request = typeof id === 'number' ? this.pending.get(id) : undefined
    if (typeof id !== 'number' || !request) {
      return
    }
    this.pending.delete(id)
    request.cleanup()
    if (message.ok === true) {
      request.resolve({ message, binary })
    } else {
      request.reject(requestError(message))
    }
  }

  private fail(error: Error): void {
    if (this.failure) {
      return
    }
    this.failure = error
    const hello = this.hello
    this.hello = null
    if (hello) {
      hello.cleanup()
      hello.reject(error)
    }
    for (const request of this.pending.values()) {
      request.cleanup()
      request.reject(error)
    }
    this.pending.clear()
  }
}
