import type { SystemResolverHealth } from './types'

export const RESOLVER_HEALTH_CACHE_TTL_MS = 30_000

/**
 * The resolver probe before each new PTY (a socket, a hello and a `scutil --dns` spawn in the
 * daemon), shared: parallel creates wait on one probe, and a 'healthy' answer from the same daemon
 * incarnation stands for 30 s. Anything else is asked again, so recovery still sees a resolver
 * that goes bad, and a different daemon (key) never inherits an answer.
 */
export class ResolverHealthProbeCache {
  private inFlight: { key: string | null; promise: Promise<SystemResolverHealth> } | null = null
  private healthy: { key: string; at: number } | null = null

  constructor(private readonly now: () => number = Date.now) {}

  read(
    key: string | null,
    probe: () => Promise<SystemResolverHealth>
  ): Promise<SystemResolverHealth> {
    if (
      key !== null &&
      this.healthy?.key === key &&
      this.now() - this.healthy.at < RESOLVER_HEALTH_CACHE_TTL_MS
    ) {
      return Promise.resolve('healthy')
    }
    if (this.inFlight && this.inFlight.key === key) {
      return this.inFlight.promise
    }
    const promise = probe()
      .then((health) => {
        if (key !== null && health === 'healthy') {
          this.healthy = { key, at: this.now() }
        }
        return health
      })
      .finally(() => {
        if (this.inFlight?.promise === promise) {
          this.inFlight = null
        }
      })
    this.inFlight = { key, promise }
    return promise
  }
}
