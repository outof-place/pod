import { describe, expect, it, vi } from 'vitest'

import {
  RESOLVER_HEALTH_CACHE_TTL_MS,
  ResolverHealthProbeCache
} from './daemon-resolver-health-cache'
import type { SystemResolverHealth } from './types'

function deferred(): {
  promise: Promise<SystemResolverHealth>
  resolve: (value: SystemResolverHealth) => void
} {
  let resolve!: (value: SystemResolverHealth) => void
  const promise = new Promise<SystemResolverHealth>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('ResolverHealthProbeCache', () => {
  it('runs one probe for ten parallel creates', async () => {
    const cache = new ResolverHealthProbeCache()
    const answer = deferred()
    const probe = vi.fn(() => answer.promise)
    const reads = Array.from({ length: 10 }, () => cache.read('daemon-1', probe))
    answer.resolve('healthy')
    await expect(Promise.all(reads)).resolves.toEqual(Array(10).fill('healthy'))
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('reuses a healthy answer from the same daemon until the TTL ends', async () => {
    let now = 1_000
    const cache = new ResolverHealthProbeCache(() => now)
    const probe = vi.fn(async (): Promise<SystemResolverHealth> => 'healthy')
    await cache.read('daemon-1', probe)
    now += RESOLVER_HEALTH_CACHE_TTL_MS - 1
    await expect(cache.read('daemon-1', probe)).resolves.toBe('healthy')
    expect(probe).toHaveBeenCalledTimes(1)
    now += 1
    await cache.read('daemon-1', probe)
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('asks again for another daemon incarnation or before one is known', async () => {
    const cache = new ResolverHealthProbeCache()
    const probe = vi.fn(async (): Promise<SystemResolverHealth> => 'healthy')
    await cache.read('daemon-1', probe)
    await cache.read('daemon-2', probe)
    await cache.read(null, probe)
    await cache.read(null, probe)
    expect(probe).toHaveBeenCalledTimes(4)
  })

  it('never keeps an unhealthy or unknown answer', async () => {
    const cache = new ResolverHealthProbeCache()
    const probe = vi
      .fn<() => Promise<SystemResolverHealth>>()
      .mockResolvedValueOnce('unhealthy')
      .mockResolvedValueOnce('unknown')
      .mockResolvedValueOnce('healthy')
    await expect(cache.read('daemon-1', probe)).resolves.toBe('unhealthy')
    await expect(cache.read('daemon-1', probe)).resolves.toBe('unknown')
    await expect(cache.read('daemon-1', probe)).resolves.toBe('healthy')
    expect(probe).toHaveBeenCalledTimes(3)
  })

  it('lets the next create probe again after a probe fails', async () => {
    const cache = new ResolverHealthProbeCache()
    const probe = vi
      .fn<() => Promise<SystemResolverHealth>>()
      .mockRejectedValueOnce(new Error('socket gone'))
      .mockResolvedValueOnce('healthy')
    await expect(cache.read('daemon-1', probe)).rejects.toThrow('socket gone')
    await expect(cache.read('daemon-1', probe)).resolves.toBe('healthy')
  })
})
