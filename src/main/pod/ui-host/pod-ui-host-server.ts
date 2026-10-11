// Fork-only (Pod): the one-app control socket. Electron-free: pod-ui-host.ts wires it to the app.
import { timingSafeEqual } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { dirname } from 'node:path'
import type { PodBrowserPaneClientMessage } from '../browser-pane/pod-browser-pane-protocol'
import { isPodBrowserPaneMessage } from '../browser-pane/pod-browser-pane-protocol'
import type { PodPeerVerifier } from './pod-peer-identity'
import {
  encodePodUiHostServerMessage,
  parsePodUiHostClientLine,
  POD_UI_HOST_MAX_LINE_BYTES,
  POD_UI_HOST_MIN_PROTOCOL_VERSION,
  POD_UI_HOST_PROTOCOL_VERSION,
  type PodUiHostOpenSurface,
  type PodUiHostQuitReason,
  type PodUiHostSecondInstance,
  type PodUiHostServerMessage
} from './pod-ui-host-protocol'

// sockaddr_un.sun_path is 104 bytes on macOS, NUL included.
const MAX_SOCKET_PATH_BYTES = 103
const HELLO_TIMEOUT_MS = 5_000

export type PodUiHostServerOptions = {
  socketPath: string
  /** The runtime's authToken from orca-runtime.json; null until the runtime RPC has published it. */
  readToken: () => string | null
  /** Who may connect at all (the peer's code signature); null admits no one. */
  verifyPeer: PodPeerVerifier | null
  pid: number
  onOpenSurface: (request: PodUiHostOpenSurface) => void
  onSecondInstance: (request: PodUiHostSecondInstance) => void
  /** `version`: the asking PodNative's protocol version; below 2 it expects no answer. */
  onQuit: (request: { reason: PodUiHostQuitReason; confirmed: boolean; version: number }) => void
  /** The browser pane's verbs; without a handler the welcome names no `browser` feature. */
  onBrowser?: (message: PodBrowserPaneClientMessage) => void
  /** A UI attached (true), or the attached one went away without asking to quit (false). */
  onUiPresence: (attached: boolean) => void
  /** The headless one-app runtime: the welcome names `headless`. */
  headless?: boolean
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

/** The socket's directory: ours, a real directory, 0700; refuses a link or someone else's. */
function preparePrivateDirectory(directory: string): string | null {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const stat = lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    return 'is not a directory'
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    return 'belongs to another user'
  }
  if ((stat.mode & 0o777) !== 0o700) {
    chmodSync(directory, 0o700)
  }
  return null
}

/** One PodNative at a time; a newer admitted connection replaces the older one. */
export class PodUiHostServer {
  private server: Server | null = null
  private ui: Socket | null = null
  private uiVersion = 0
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
    const directoryProblem = preparePrivateDirectory(dirname(socketPath))
    if (directoryProblem) {
      log(`ui-host: ${dirname(socketPath)} ${directoryProblem}, not listening`)
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

  /** The attached PodNative's quit committed: its going away is no crash. */
  noteQuitCommitted(): void {
    if (this.ui) {
      this.quitting.add(this.ui)
    }
  }

  /** A committed quit was vetoed: the attached PodNative going away is a crash again. */
  noteQuitAborted(): void {
    if (this.ui) {
      this.quitting.delete(this.ui)
    }
  }

  close(): void {
    this.ui?.destroy()
    this.ui = null
    this.stopListening()
  }

  /** No new connections; the attached PodNative stays connected until this process exits. */
  stopListening(): void {
    this.server?.close()
    if (this.server) {
      removeStaleSocket(this.options.socketPath)
    }
    this.server = null
  }

  private accept(socket: Socket): void {
    socket.on('error', () => socket.destroy())
    const peer = this.options.verifyPeer?.(socket) ?? {
      ok: false,
      pid: 0,
      error: 'no peer check available'
    }
    if (!peer.ok) {
      this.options.log(`ui-host: refused pid ${peer.pid}: ${peer.error ?? 'not PodNative'}`)
      socket.destroy()
      return
    }
    let buffered = ''
    let authenticated = false
    const helloTimer = setTimeout(() => socket.destroy(), HELLO_TIMEOUT_MS)
    helloTimer.unref?.()
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      buffered += chunk
      if (Buffer.byteLength(buffered) > POD_UI_HOST_MAX_LINE_BYTES && !buffered.includes('\n')) {
        this.options.log('ui-host: refused a line over the limit')
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
      message.v < POD_UI_HOST_MIN_PROTOCOL_VERSION ||
      message.v > POD_UI_HOST_PROTOCOL_VERSION ||
      !tokensMatch(this.options.readToken(), message.token)
    ) {
      this.options.log('ui-host: refused a connection without a valid hello')
      return false
    }
    const previous = this.ui
    this.ui = socket
    this.uiVersion = message.v
    // Why: the replaced UI is not "gone"; its close must not start the no-UI grace.
    previous?.destroy()
    socket.write(
      encodePodUiHostServerMessage({
        type: 'welcome',
        // The version this connection speaks: the client's own.
        v: message.v,
        pid: this.options.pid,
        features: [
          ...(this.options.onBrowser ? ['browser'] : []),
          ...(this.options.headless ? ['headless'] : [])
        ]
      })
    )
    this.options.log(`ui-host: PodNative ${message.pid} attached`)
    this.options.onUiPresence(true)
    return true
  }

  private handle(socket: Socket, line: string): void {
    if (socket !== this.ui) {
      return
    }
    const message = parsePodUiHostClientLine(line)
    if (!message || message.type === 'hello') {
      // A fixed verb set: anything else (or a second hello) ends the connection.
      this.options.log('ui-host: refused an unknown or repeated message')
      socket.destroy()
      return
    }
    if (message.type === 'openSurface') {
      this.options.onOpenSurface(message)
    } else if (message.type === 'secondInstance') {
      this.options.onSecondInstance(message)
    } else if (isPodBrowserPaneMessage(message)) {
      if (!this.options.onBrowser) {
        this.options.log('ui-host: refused a browser verb this runtime did not offer')
        socket.destroy()
        return
      }
      if (message.type === 'browserPane' && this.uiVersion < 3) {
        this.options.log('ui-host: refused a verb newer than the connection')
        socket.destroy()
        return
      }
      this.options.onBrowser(message)
    } else {
      // Version 2 may answer needsConfirmation; its quit commits later (noteQuitCommitted).
      if (this.uiVersion < 2) {
        this.quitting.add(socket)
      }
      this.options.onQuit({
        reason: message.reason,
        confirmed: message.confirmed === true,
        version: this.uiVersion
      })
    }
  }
}
