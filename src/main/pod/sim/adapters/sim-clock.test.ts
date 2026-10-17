import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { createSimClock, simIds } from './sim-clock'

describe('the pool’s clock', () => {
  it('counts each suspend and is suspended until the next resume', () => {
    const power = new EventEmitter()
    const clock = createSimClock(power)
    expect(clock.now()).toMatchObject({ suspends: 0, suspended: false })
    power.emit('suspend')
    expect(clock.now()).toMatchObject({ suspends: 1, suspended: true })
    power.emit('resume')
    expect(clock.now()).toMatchObject({ suspends: 1, suspended: false })
    // A resume without a suspend first (the loop delivered them out of order) changes no count.
    power.emit('resume')
    power.emit('suspend')
    expect(clock.now()).toMatchObject({ suspends: 2, suspended: true })
    clock.dispose()
    expect(power.listenerCount('suspend') + power.listenerCount('resume')).toBe(0)
  })

  it('reads a monotonic clock that never goes back, beside the wall clock', () => {
    const clock = createSimClock(null)
    const a = clock.now()
    const b = clock.now()
    expect(b.mono).toBeGreaterThanOrEqual(a.mono)
    expect(Math.abs(a.wall - Date.now())).toBeLessThan(1000)
    expect(a).toMatchObject({ suspends: 0, suspended: false })
  })
})

describe('the pool’s ids', () => {
  it('makes lease ids the contract accepts and uppercase UUIDs for devices, never twice', () => {
    const leases = new Set(Array.from({ length: 500 }, () => simIds.leaseId()))
    expect(leases.size).toBe(500)
    for (const id of leases) {
      expect(id).toMatch(/^sl_[0-9a-z]{4,32}$/)
    }
    expect(simIds.deviceId()).toMatch(
      /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/
    )
  })
})
