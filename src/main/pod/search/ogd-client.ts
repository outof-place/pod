import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  OgdConnection,
  OgdRequestError,
  OgdUnavailableError,
  OgdVersionError,
  type OgdMessage,
  type OgdReply
} from './ogd-connection'

// Protocol client rule: never block a user-visible action on the daemon.
export const OGD_DEFAULT_TIMEOUT_MS = 2_000
const MAX_CONNECTIONS = 4
// Why back off: quick open asks per keystroke, and a missing daemon must cost one failed connect,
// not one per request.
const UNAVAILABLE_BACKOFF_MS = 5_000
const VERSION_BACKOFF_MS = 60_000

export function resolveOgdSocketPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir()
): string | null {
  if (env.POD_SEARCH_SOCKET) {
    return env.POD_SEARCH_SOCKET
  }
  if (platform === 'darwin') {
    return join(home, 'Library', 'Caches', 'pod-search', 'ogd.sock')
  }
  if (platform === 'linux' && env.XDG_RUNTIME_DIR) {
    return join(env.XDG_RUNTIME_DIR, 'pod-search', 'ogd.sock')
  }
  return null
}

export type OgdClientOptions = {
  socketPath: string
  client: string
  timeoutMs?: number
  now?: () => number
}

/** A small pool of handshaken connections; an aborted or timed-out request discards its own. */
export class OgdClient {
  private readonly idle: OgdConnection[] = []
  private openCount = 0
  private unavailableUntil = 0
  private features: readonly string[] = []

  constructor(private readonly options: OgdClientOptions) {}

  get socketPath(): string {
    return this.options.socketPath
  }

  /** Features from the last handshake; empty until a connection succeeded. */
  hasFeature(feature: string): boolean {
    return this.features.includes(feature)
  }

  async request(
    op: string,
    fields: OgdMessage = {},
    options: { signal?: AbortSignal; timeoutMs?: number } = {}
  ): Promise<OgdReply> {
    const connection = await this.acquire()
    try {
      const reply = await connection.request(op, fields, {
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? this.options.timeoutMs ?? OGD_DEFAULT_TIMEOUT_MS
      })
      this.release(connection)
      return reply
    } catch (error) {
      if (error instanceof OgdRequestError) {
        this.release(connection)
      } else {
        this.discard(connection)
      }
      if (error instanceof OgdUnavailableError) {
        this.backOff(UNAVAILABLE_BACKOFF_MS)
      }
      throw error
    }
  }

  close(): void {
    for (const connection of this.idle.splice(0)) {
      connection.close()
    }
  }

  private async acquire(): Promise<OgdConnection> {
    while (this.idle.length > 0) {
      const connection = this.idle.pop()
      if (connection?.usable) {
        return connection
      }
      this.openCount--
    }
    const now = this.options.now?.() ?? Date.now()
    if (now < this.unavailableUntil) {
      throw new OgdUnavailableError('ogd unavailable (backing off)')
    }
    if (this.openCount >= MAX_CONNECTIONS) {
      throw new OgdUnavailableError('ogd connection pool exhausted')
    }
    this.openCount++
    try {
      const connection = await OgdConnection.open(this.options.socketPath, {
        client: this.options.client,
        timeoutMs: this.options.timeoutMs ?? OGD_DEFAULT_TIMEOUT_MS
      })
      this.features = connection.features
      return connection
    } catch (error) {
      this.openCount--
      this.backOff(error instanceof OgdVersionError ? VERSION_BACKOFF_MS : UNAVAILABLE_BACKOFF_MS)
      throw error
    }
  }

  private release(connection: OgdConnection): void {
    if (connection.usable) {
      this.idle.push(connection)
    } else {
      this.openCount--
    }
  }

  private discard(connection: OgdConnection): void {
    connection.close()
    this.openCount--
  }

  private backOff(ms: number): void {
    this.unavailableUntil = (this.options.now?.() ?? Date.now()) + ms
  }
}
