// Fork-only (Pod): the endpoint of Claude's http hooks in Pod sessions. The daemon lives as long as
// every claude it hosts, so a hook never meets a closed port, and it never waits: 200 at once, then
// the event goes on to the runtime in its pane's order (pod-hook-relay-delivery.ts). A pane whose
// runtime stops answering keeps a bounded backlog; the rest goes to the spool as the C client's would.
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, rename, unlink, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import {
  decodePodHookRelayPane,
  deliverPodHookRelayEvent,
  type PodHookRelayEvent
} from './pod-hook-relay-delivery'
import { spoolPodHookRelayEvent, spoolPodHookRelayEventAsync } from './pod-hook-relay-spool'
import { podHookRelayEndpointAllowed } from './pod-hook-relay-endpoints'

const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024
/** A pane's backlog while its runtime hangs (1.5 s per event); beyond it events spool or drop. */
const PANE_QUEUE_MAX_EVENTS = 64
const PANE_QUEUE_MAX_BYTES = 8 * 1024 * 1024
/** How long a closing relay spends spooling its backlog. */
const CLOSE_SPOOL_BUDGET_MS = 200
const HOOK_PATH = /^\/hook\/([a-z0-9-]+)$/

export const POD_HOOK_RELAY_TOKEN_HEADER = 'x-pod-hook-relay-token'
export const POD_HOOK_RELAY_PANE_HEADER = 'x-pod-hook-relay-pane'
/** Claude's $CLAUDE_JOB_DIR: a background job's worker inherits a pane's settings but doesn't run in it. */
export const POD_HOOK_RELAY_JOB_DIR_HEADER = 'x-pod-hook-relay-job-dir'

export type PodHookRelayOptions = {
  /** KEY=value file the launcher reads: POD_HOOK_RELAY_PORT, POD_HOOK_RELAY_TOKEN. */
  relayFilePath: string
  log: (event: string, details?: Record<string, unknown>) => void
  deliver?: (event: PodHookRelayEvent) => Promise<unknown>
  endpointAllowed?: (endpoint: string) => boolean
  now?: () => number
}

type PaneQueue = {
  events: PodHookRelayEvent[]
  bytes: number
  /** Events past the cap; spooled and dropped count their outcome as each write settles. */
  overflowed: number
  spooled: number
  dropped: number
  drained?: Promise<void>
  /** The pane's last spool write; its file's chain keeps the earlier ones before it. */
  lastSpool?: Promise<unknown>
}

export class PodHookRelay {
  private server: Server | null = null
  private readonly token = randomBytes(24).toString('hex')
  private readonly paneQueues = new Map<string, PaneQueue>()
  private readonly pendingSpools = new Set<Promise<unknown>>()
  private refusedEndpoints = 0

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
    this.spoolBacklog()
    await unlink(this.options.relayFilePath).catch(() => {})
    if (server) {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }

  /** Settles once every queued event has been delivered or spooled. */
  async idle(): Promise<void> {
    while (this.paneQueues.size > 0 || this.pendingSpools.size > 0) {
      await Promise.all([
        ...[...this.paneQueues.values()].map((queue) => queue.drained ?? Promise.resolve()),
        ...this.pendingSpools
      ])
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
    if (!(this.options.endpointAllowed ?? podHookRelayEndpointAllowed)(pane.endpoint)) {
      // Why: the relay reads this file and spools beside it; only a path the daemon spawned with.
      this.refusedEndpoints += 1
      if (this.refusedEndpoints === 1 || this.refusedEndpoints % 100 === 0) {
        this.options.log('pod-hook-relay-endpoint-refused', {
          endpoint: pane.endpoint,
          refused: this.refusedEndpoints
        })
      }
      req.resume()
      req.on('end', () => res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}\n'))
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
      if (size > MAX_PAYLOAD_BYTES) {
        this.options.log('pod-hook-relay-payload-too-large', { paneKey: pane.paneKey, bytes: size })
        return
      }
      // As the C client: an empty payload, or a background job's, reports nothing.
      if (payload.length === 0 || req.headers[POD_HOOK_RELAY_JOB_DIR_HEADER]) {
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
    const queue = this.paneQueues.get(key)
    if (!queue) {
      const fresh: PaneQueue = {
        events: [event],
        bytes: event.payload.length,
        overflowed: 0,
        spooled: 0,
        dropped: 0
      }
      this.paneQueues.set(key, fresh)
      fresh.drained = this.drain(key, fresh)
      return
    }
    if (
      queue.events.length >= PANE_QUEUE_MAX_EVENTS ||
      queue.bytes + event.payload.length > PANE_QUEUE_MAX_BYTES
    ) {
      if (queue.overflowed++ === 0) {
        this.options.log('pod-hook-relay-pane-backlog-full', {
          paneKey: key,
          events: queue.events.length,
          bytes: queue.bytes
        })
      }
      this.overflow(queue, event)
      return
    }
    queue.events.push(event)
    queue.bytes += event.payload.length
  }

  private async drain(key: string, queue: PaneQueue): Promise<void> {
    const deliver = this.options.deliver ?? deliverPodHookRelayEvent
    for (let event = queue.events[0]; event; event = queue.events[0]) {
      try {
        await deliver(event)
      } catch (error) {
        this.options.log('pod-hook-relay-delivery-failed', {
          error: error instanceof Error ? error.message : String(error)
        })
      }
      // Why after: the event in flight still counts against the pane's backlog.
      queue.events.shift()
      queue.bytes -= event.payload.length
    }
    if (this.paneQueues.get(key) === queue) {
      this.paneQueues.delete(key)
    }
    if (queue.overflowed > 0) {
      await queue.lastSpool
      this.options.log('pod-hook-relay-pane-backlog-drained', {
        paneKey: key,
        spooled: queue.spooled,
        dropped: queue.dropped
      })
    }
  }

  /** Lifecycle events to the spool, tool events dropped: the C client's choice when nothing answers. */
  private overflow(queue: PaneQueue, event: PodHookRelayEvent): void {
    const spool = spoolPodHookRelayEventAsync(event, (this.options.now ?? Date.now)()).then(
      (outcome) => this.count(queue, outcome)
    )
    queue.lastSpool = spool
    this.pendingSpools.add(spool)
    void spool.then(() => this.pendingSpools.delete(spool))
  }

  private count(queue: PaneQueue, outcome: 'spooled' | 'skipped'): void {
    if (outcome === 'spooled') {
      queue.spooled += 1
    } else {
      queue.dropped += 1
    }
  }

  /** On close: every queued event behind the one in flight, within a budget. */
  private spoolBacklog(): void {
    const now = this.options.now ?? Date.now
    const deadline = now() + CLOSE_SPOOL_BUDGET_MS
    for (const [key, queue] of this.paneQueues) {
      const backlog = queue.events.splice(1)
      for (const event of backlog) {
        if (now() > deadline) {
          queue.dropped += 1
        } else {
          // Why sync: the daemon may exit before an async write lands.
          this.count(queue, spoolPodHookRelayEvent(event, now()))
        }
      }
      if (backlog.length > 0) {
        this.options.log('pod-hook-relay-closed-with-backlog', {
          paneKey: key,
          spooled: queue.spooled,
          dropped: queue.dropped
        })
      }
    }
  }
}
