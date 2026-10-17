// Fork-only (Pod): the pool's clock and ids. `mono` is performance.now (on macOS it runs on while
// the Mac sleeps), `wall` the epoch, and the sleep signal is Electron's powerMonitor (`suspend`
// and `resume`, both in the pinned Electron 45's electron.d.ts): each suspend counts, and the pool
// is suspended from one until the next resume (SimClockReading). Listeners, no timer.
import { randomBytes, randomUUID } from 'node:crypto'
import type { SimClock, SimIdSource } from '../pool/sim-pool-ports'

/** Electron's powerMonitor, or anything with its `suspend` and `resume` events. */
export type SimPowerEvents = Readonly<{
  on(event: 'suspend', listener: () => void): unknown
  on(event: 'resume', listener: () => void): unknown
  off(event: 'suspend', listener: () => void): unknown
  off(event: 'resume', listener: () => void): unknown
}>

export function createSimClock(power: SimPowerEvents | null): SimClock & { dispose(): void } {
  let suspends = 0
  let suspended = false
  const onSuspend = () => {
    suspends += 1
    suspended = true
  }
  const onResume = () => {
    suspended = false
  }
  power?.on('suspend', onSuspend)
  power?.on('resume', onResume)
  return {
    now: () => ({ mono: performance.now(), wall: Date.now(), suspends, suspended }),
    dispose: () => {
      power?.off('suspend', onSuspend)
      power?.off('resume', onResume)
    }
  }
}

const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz'

export const simIds: SimIdSource = {
  // 16 base-36 characters from 16 random bytes: about 82 bits.
  leaseId: () => `sl_${[...randomBytes(16)].map((byte) => BASE36[byte % 36]).join('')}`,
  deviceId: () => randomUUID().toUpperCase()
}
