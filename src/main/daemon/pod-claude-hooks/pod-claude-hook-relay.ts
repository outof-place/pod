// Fork-only (Pod): Claude's measured hook events as http hooks into the daemon (`--settings` from
// pod-agent-launcher) instead of one pod-agent-hook process each. The relay answers at once with
// the client's "{}" and forwards afterwards, one event at a time per pane, so order holds.
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { forwardPodClaudeHook, type PodClaudePaneEnv } from './pod-claude-hook-forward'

/** pod-agent-hook's MAX_PAYLOAD; a bigger event is answered and dropped. */
const MAX_BODY = 16 * 1024 * 1024
export const POD_CLAUDE_RELAY_PATH = '/hook/claude'

function header(req: IncomingMessage, name: string): string {
  const value = req.headers[name]
  return typeof value === 'string' ? value : ''
}

export class PodClaudeHookRelay {
  readonly token = randomBytes(32).toString('hex')
  private readonly server: Server
  private readonly queues = new Map<string, Promise<void>>()

  constructor(
    private readonly paneEnv: (sessionId: string) => PodClaudePaneEnv | null,
    private readonly forward: typeof forwardPodClaudeHook = forwardPodClaudeHook
  ) {
    this.server = createServer((req, res) => this.handle(req, res))
  }

  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', reject)
        // Why: an idle relay must not keep the daemon's event loop alive.
        this.server.unref()
        const address = this.server.address()
        resolve(typeof address === 'object' && address !== null ? address.port : 0)
      })
    })
  }

  close(): void {
    this.server.close()
    this.server.closeAllConnections()
  }

  /** Settles once every queued event has been forwarded. */
  async idle(): Promise<void> {
    while (this.queues.size > 0) {
      await Promise.all(this.queues.values())
    }
  }

  private authorized(req: IncomingMessage): boolean {
    const given = Buffer.from(header(req, 'x-pod-token'))
    const expected = Buffer.from(this.token)
    return given.length === expected.length && timingSafeEqual(given, expected)
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    req.on('error', () => {})
    if (req.method !== 'POST' || req.url !== POD_CLAUDE_RELAY_PATH || !this.authorized(req)) {
      req.resume()
      res.writeHead(403).end()
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size <= MAX_BODY) {
        chunks.push(chunk)
      }
    })
    req.on('end', () => {
      // Why first: Claude waits on this answer (http hooks are never async), not on the runtime.
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}')
      const session = header(req, 'x-pod-session')
      // Why: a background job's worker inherits a pane's env but doesn't run in it.
      if (size > MAX_BODY || !session || header(req, 'x-pod-job-dir')) {
        return
      }
      const env = this.paneEnv(session)
      if (env) {
        const body = Buffer.concat(chunks)
        this.enqueue(session, () => this.forward(env, body, header(req, 'x-pod-agent-process')))
      }
    })
  }

  private enqueue(session: string, job: () => Promise<void>): void {
    const previous = this.queues.get(session) ?? Promise.resolve()
    const next = previous.then(job).catch(() => {})
    this.queues.set(session, next)
    void next.then(() => {
      if (this.queues.get(session) === next) {
        this.queues.delete(session)
      }
    })
  }
}
