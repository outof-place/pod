// Fork-only (Pod): the pool's registry as one Mac-wide file that every runtime on the account
// shares (sim-registry.ts has the protocol). A read takes no lock: every write is a whole new file
// renamed over the old one, so a reader sees one or the other. A swap takes the flock, checks the
// file is still the one its read saw (its token is a hash of the bytes), writes a temp file beside
// it and renames it over. The lock is held for that check and write only, about a millisecond.
//
// The flock is open(2)'s O_EXLOCK with O_NONBLOCK, polled with a short backoff: the same lock as
// flock(2), Python's fcntl.flock and lockf(1), without parking a libuv thread on a blocking call.
// O_EXLOCK is Darwin's (0x20 is nothing on Linux and another flag on Windows), and the pool is
// macOS only: off macOS the store refuses before touching the disk, through the home's claim.
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, readdir, readFile, rename, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { readSimRegistry, type SimRegistryFile } from '../../../../shared/pod-sim/sim-registry'
import type {
  SimRegistryStore,
  SimRegistryStoreRead,
  SimRegistrySwap
} from '../pool/sim-pool-ports'
import { simPodHomeClaimer, type SimPodHome, type SimPodHomeClaim } from './sim-pod-home'

/** O_EXLOCK from macOS's sys/fcntl.h; Node does not export it. */
export const SIM_FLOCK_EXCLUSIVE = 0x20
const LOCK_FLAGS = constants.O_RDWR | constants.O_CREAT | SIM_FLOCK_EXCLUSIVE | constants.O_NONBLOCK

/** A swap holds the lock for about a millisecond; seconds of waiting is a stuck holder. */
export const SIM_REGISTRY_LOCK_WAIT_MS = 2_000
const ABSENT = 'absent'

export type SimRegistryTimingPhase = 'read' | 'lock' | 'check' | 'write'

export type SimRegistryFileStoreOptions = Readonly<{
  home: SimPodHome
  // The home's claim, shared with the device driver (sim-pod-home.ts); made here when absent.
  claim?: () => Promise<SimPodHomeClaim>
  platform?: NodeJS.Platform
  lockWaitMs?: number
  onTiming?: (phase: SimRegistryTimingPhase, ms: number) => void
}>

function tokenOf(bytes: Buffer | null): string {
  return bytes ? createHash('sha256').update(bytes).digest('base64url') : ABSENT
}

function errnoOf(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
}

async function bytesAt(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path)
  } catch (error) {
    if (errnoOf(error) === 'ENOENT') {
      return null
    }
    throw error
  }
}

function isBusy(error: unknown): boolean {
  const code = errnoOf(error)
  return code === 'EAGAIN' || code === 'EWOULDBLOCK'
}

async function lockWithin(path: string, waitMs: number) {
  const deadline = performance.now() + waitMs
  let pause = 1
  for (;;) {
    try {
      return await open(path, LOCK_FLAGS, 0o600)
    } catch (error) {
      if (!isBusy(error) || performance.now() + pause > deadline) {
        throw error
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pause))
    pause = Math.min(pause * 2, 16)
  }
}

function unreadable(message: string): { ok: false; reason: 'registryUnreadable'; message: string } {
  return { ok: false, reason: 'registryUnreadable', message }
}

const TEMP_FILE = /^registry\.json\.\d+\.tmp$/

/** Temp files of swaps cut short (a crash between write and rename). Only under the lock. */
async function pruneTemps(home: SimPodHome): Promise<void> {
  const prefix = `${basename(home.registry)}.`
  for (const entry of await readdir(home.root).catch(() => [])) {
    if (entry.startsWith(prefix) && TEMP_FILE.test(entry)) {
      await rm(join(home.root, entry), { force: true }).catch(() => undefined)
    }
  }
}

export function createSimRegistryFileStore(options: SimRegistryFileStoreOptions): SimRegistryStore {
  const { home } = options
  const claim =
    options.claim ?? simPodHomeClaimer(home, options.platform ? { platform: options.platform } : {})
  const waitMs = options.lockWaitMs ?? SIM_REGISTRY_LOCK_WAIT_MS
  let pruned = false
  const timed = (phase: SimRegistryTimingPhase, since: number): number => {
    const now = performance.now()
    options.onTiming?.(phase, now - since)
    return now
  }

  return {
    async read(): Promise<SimRegistryStoreRead> {
      const start = performance.now()
      const claimed = await claim()
      if (!claimed.ok) {
        return claimed
      }
      let bytes: Buffer | null
      try {
        bytes = await bytesAt(home.registry)
      } catch (error) {
        return unreadable(`${home.registry} cannot be read: ${String(error)}`)
      }
      const read = readSimRegistry(bytes ? bytes.toString('utf8') : null, home.registry)
      timed('read', start)
      return read.ok ? { ok: true, registry: read.registry, token: tokenOf(bytes) } : read
    },

    async swap(token: string, next: SimRegistryFile): Promise<SimRegistrySwap> {
      let at = performance.now()
      const claimed = await claim()
      if (!claimed.ok) {
        return claimed
      }
      let lock: Awaited<ReturnType<typeof open>>
      try {
        lock = await lockWithin(home.lock, waitMs)
      } catch (error) {
        if (isBusy(error)) {
          // Slow, not broken: the caller re-reads and tries again, and gives up as contention.
          return { ok: false, reason: 'conflict' }
        }
        return unreadable(`the simulator registry lock ${home.lock}: ${String(error)}`)
      }
      const temp = `${home.registry}.${process.pid}.tmp`
      try {
        at = timed('lock', at)
        if (!pruned) {
          pruned = true
          await pruneTemps(home)
        }
        if (tokenOf(await bytesAt(home.registry)) !== token) {
          return { ok: false, reason: 'conflict' }
        }
        at = timed('check', at)
        const bytes = Buffer.from(JSON.stringify(next))
        const file = await open(temp, 'w', 0o600)
        try {
          await file.writeFile(bytes)
          await file.sync()
        } finally {
          await file.close()
        }
        await rename(temp, home.registry)
        timed('write', at)
        return { ok: true, token: tokenOf(bytes) }
      } catch (error) {
        await rm(temp, { force: true })
        return unreadable(`${home.registry} cannot be written: ${String(error)}`)
      } finally {
        await lock.close()
      }
    }
  }
}
