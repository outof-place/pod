// Fork-only (Pod): the endpoint of Claude's http hooks in Pod sessions. The daemon lives as long as
// every claude it hosts, so a hook never meets a closed port, and it never waits: 200 at once, then
// the event goes on to the runtime in its pane's order (pod-hook-relay-delivery.ts).
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, rename, unlink, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import {
  decodePodHookRelayPane,
  deliverPodHookRelayEvent,
  type PodHookRelayEvent
} from './pod-hook-relay-delivery'

const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024
const HOOK_PATH = /^\/hook\/([a-z0-9-]+)$/

export const POD_HOOK_RELAY_TOKEN_HEADER = 'x-pod-hook-relay-token'
export const POD_HOOK_RELAY_PANE_HEADER = 'x-pod-hook-relay-pane'

export type PodHookRelayOptions = {
  /** KEY=value file the launcher reads: POD_HOOK_RELAY_PORT, POD_HOOK_RELAY_TOKEN. */
  relayFilePath: string
  log: (event: string, details?: Record<string, unknown>) => void
  deliver?: (event: PodHookRelayEvent) => Promise<unknown>
}

export class PodHookRelay {
  private server: Server | null = null
  private readonly token = randomBytes(24).toString('hex')
  private readonly paneQueues = new Map<string, Promise<unknown>>()

  constructor(private readonly options: PodHookRelayOptions) {}

  /** False, never a throw: without the relay, launches fall back to command hooks. */
  async start(): Promise<boolean> {
    try {
      await this.listen()
      return true
    } catch (error) {
      this.options.log('pod-hook-relay-unavailable', {
        error: error instanceof Error ? error.message : String(error)
      })
      await this.close()
      return false
    }
  }

  private async listen(): Promise<void> {
    const server = createServer((req, res) => this.accept(req, res))
    server.on('error', (error) =>
      this.options.log('pod-hook-relay-error', { error: error.message })
    )
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    // Why: shutdown is the daemon lifecycle's call; an idle listener must not hold the process.
    server.unref()
    this.server = server
    const address = server.address()
    const port = address && typeof address === 'object' ? address.port : 0
    const tmp = `${this.options.relayFilePath}.${process.pid}.tmp`
    await writeFile(tmp, `POD_HOOK_RELAY_PORT=${port}\nPOD_HOOK_RELAY_TOKEN=${this.token}\n`, {
      mode: 0o600
    })
    await chmod(tmp, 0o600)
    await rename(tmp, this.options.relayFilePath)
    this.options.log('pod-hook-relay-listening', { port })
  }

  async close(): Promise<void> {
    const server = this.server
    this.server = null
    await unlink(this.options.relayFilePath).catch(() => {})
    if (server) {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }

  private authorized(req: IncomingMessage): boolean {
    const given = req.headers[POD_HOOK_RELAY_TOKEN_HEADER]
    if (typeof given !== 'string' || given.length !== this.token.length) {
      return false
    }
    return timingSafeEqual(Buffer.from(given), Buffer.from(this.token))
  }

  private accept(req: IncomingMessage, res: ServerResponse): void {
    const agent = req.method === 'POST' ? HOOK_PATH.exec(req.url ?? '')?.[1] : undefined
    const paneHeader = req.headers[POD_HOOK_RELAY_PANE_HEADER]
    const pane = decodePodHookRelayPane(typeof paneHeader === 'string' ? paneHeader : undefined)
    if (!agent || !pane || !this.authorized(req)) {
      res.writeHead(agent ? 403 : 404).end()
      req.resume()
      return
    }
    const agentProcess = req.headers['x-orca-agent-process']
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size <= MAX_PAYLOAD_BYTES) {
        chunks.push(chunk)
      }
    })
    req.on('end', () => {
      // Claude waits on this answer: it goes before anything else happens.
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}\n')
      let payload = Buffer.concat(chunks)
      while (payload.length > 0 && payload.at(-1) === 0x0a) {
        payload = payload.subarray(0, -1)
      }
      if (payload.length === 0 || size > MAX_PAYLOAD_BYTES) {
        return
      }
      this.enqueue({
        agent,
        pane,
        agentProcess: typeof agentProcess === 'string' ? agentProcess : '',
        payload
      })
    })
  }

  /** One pane's events reach the runtime in the order Claude sent them. */
  private enqueue(event: PodHookRelayEvent): void {
    const key = event.pane.paneKey
    const deliver = this.options.deliver ?? deliverPodHookRelayEvent
    const previous = this.paneQueues.get(key) ?? Promise.resolve()
    const next = previous
      .then(() => deliver(event))
      .catch((error: unknown) =>
        this.options.log('pod-hook-relay-delivery-failed', {
          error: error instanceof Error ? error.message : String(error)
        })
      )
    this.paneQueues.set(key, next)
    void next.then(() => {
      if (this.paneQueues.get(key) === next) {
        this.paneQueues.delete(key)
      }
    })
  }
}
