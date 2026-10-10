// Fork-only (Pod): the one-app control socket. Electron-free: pod-ui-host.ts wires it to the app.
import { timingSafeEqual } from 'node:crypto'
import { chmodSync, lstatSync, unlinkSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import {
  encodePodUiHostServerMessage,
  parsePodUiHostClientLine,
  POD_UI_HOST_MAX_LINE_BYTES,
  POD_UI_HOST_PROTOCOL_VERSION,
  type PodUiHostServerMessage,
  type PodUiHostShowRequest
} from './pod-ui-host-protocol'

// sockaddr_un.sun_path is 104 bytes on macOS, NUL included.
const MAX_SOCKET_PATH_BYTES = 103
const HELLO_TIMEOUT_MS = 5_000

export type PodUiHostServerOptions = {
  socketPath: string
  /** The runtime's authToken from orca-runtime.json; null until the runtime RPC has published it. */
  readToken: () => string | null
  pid: number
  onShow: (request: PodUiHostShowRequest) => void
  onQuit: () => void
  /** A UI attached (true), or the attached one went away without asking to quit (false). */
  onUiPresence: (attached: boolean) => void
  log: (message: string) => void
}

function tokensMatch(expected: string | null, actual: string): boolean {
  if (!expected) {
    return false
  }
  const a = Buffer.from(expected)
  const b = Buffer.from(actual)
  return a.length === b.length && timingSafeEqual(a, b)
}

function removeStaleSocket(path: string): void {
  try {
    // Why lstat: only ever unlink a socket a previous run left, never a file or a link to one.
    if (lstatSync(path).isSocket()) {
      unlinkSync(path)
    }
  } catch {
    // Nothing there.
  }
}

/** One PodNative at a time; a newer authenticated connection replaces the older one. */
export class PodUiHostServer {
  private server: Server | null = null
  private ui: Socket | null = null
  private readonly quitting = new WeakSet<Socket>()

  constructor(private readonly options: PodUiHostServerOptions) {}

  get attached(): boolean {
    return this.ui !== null
  }

  async start(): Promise<boolean> {
    const { socketPath, log } = this.options
    if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) {
      log(`ui-host: socket path over ${MAX_SOCKET_PATH_BYTES} bytes, not listening: ${socketPath}`)
      return false
    }
    removeStaleSocket(socketPath)
    const server = createServer((socket) => this.accept(socket))
    this.server = server
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(socketPath, () => {
          server.removeListener('error', reject)
          resolve()
        })
      })
      chmodSync(socketPath, 0o600)
    } catch (error) {
      log(`ui-host: listen failed: ${error instanceof Error ? error.message : String(error)}`)
      this.close()
      return false
    }
    return true
  }

  send(message: PodUiHostServerMessage): boolean {
    const ui = this.ui
    if (!ui || ui.destroyed) {
      return false
    }
    ui.write(encodePodUiHostServerMessage(message))
    return true
  }

  close(): void {
    this.ui?.destroy()
    this.ui = null
    this.server?.close()
    if (this.server) {
      removeStaleSocket(this.options.socketPath)
    }
    this.server = null
  }

  private accept(socket: Socket): void {
    let buffered = ''
    let authenticated = false
    const helloTimer = setTimeout(() => socket.destroy(), HELLO_TIMEOUT_MS)
    helloTimer.unref?.()
    socket.setEncoding('utf8')
    socket.on('error', () => socket.destroy())
    socket.on('data', (chunk: string) => {
      buffered += chunk
      if (Buffer.byteLength(buffered) > POD_UI_HOST_MAX_LINE_BYTES && !buffered.includes('\n')) {
        socket.destroy()
        return
      }
      let newline = buffered.indexOf('\n')
      while (newline !== -1 && !socket.destroyed) {
        const line = buffered.slice(0, newline)
        buffered = buffered.slice(newline + 1)
        if (authenticated) {
          this.handle(socket, line)
        } else {
          authenticated = this.authenticate(socket, line)
          clearTimeout(helloTimer)
          if (!authenticated) {
            socket.destroy()
            return
          }
        }
        newline = buffered.indexOf('\n')
      }
    })
    socket.on('close', () => {
      clearTimeout(helloTimer)
      if (this.ui !== socket) {
        return
      }
      this.ui = null
      if (!this.quitting.has(socket)) {
        this.options.onUiPresence(false)
      }
    })
  }

  private authenticate(socket: Socket, line: string): boolean {
    const message = parsePodUiHostClientLine(line)
    if (
      message?.type !== 'hello' ||
      message.v !== POD_UI_HOST_PROTOCOL_VERSION ||
      !tokensMatch(this.options.readToken(), message.token)
    ) {
      this.options.log('ui-host: refused a connection without a valid hello')
      return false
    }
    const previous = this.ui
    this.ui = socket
    // Why: the replaced UI is not "gone"; its close must not start the no-UI grace.
    previous?.destroy()
    socket.write(
      encodePodUiHostServerMessage({
        type: 'welcome',
        v: POD_UI_HOST_PROTOCOL_VERSION,
        pid: this.options.pid
      })
    )
    this.options.log(`ui-host: PodNative ${message.pid} attached`)
    this.options.onUiPresence(true)
    return true
  }

  private handle(socket: Socket, line: string): void {
    const message = parsePodUiHostClientLine(line)
    if (!message || socket !== this.ui) {
      return
    }
    if (message.type === 'show') {
      this.options.onShow(message)
    } else if (message.type === 'quit') {
      this.quitting.add(socket)
      this.options.onQuit()
    }
  }
}
