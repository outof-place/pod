// Fork-only (Pod): a Mac-wide JSON file the app module shares between runtimes (builds, Metro
// ports), with the registry's discipline (sim-registry-file-store.ts): reads take no lock, every
// write is a compare-and-swap under the same flock, a temp file renamed over the old one. A file
// this runtime cannot read (damaged, or a newer Pod's) is never written.
import { createHash } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { lockWithin, SIM_REGISTRY_LOCK_WAIT_MS } from '../adapters/sim-registry-file-store'

export type SimJsonRead<T> =
  | Readonly<{ ok: true; value: T; token: string }>
  | Readonly<{ ok: false; message: string }>

export type SimJsonUpdate<T> =
  | Readonly<{ ok: true; value: T; changed: boolean }>
  | Readonly<{ ok: false; message: string }>

export type SimJsonFile<T> = {
  read(): Promise<SimJsonRead<T>>
  /**
   * Re-reads and re-applies `change` until its write lands on the file it read (another runtime
   * may write between). `change` gets a copy and returns the next value, or null to leave it.
   */
  update(change: (value: T) => T | null): Promise<SimJsonUpdate<T>>
}

export type SimJsonFileOptions<T> = Readonly<{
  path: string
  lock: string
  // The value of the file's JSON, or null when this runtime cannot use it.
  parse: (json: unknown) => T | null
  empty: () => T
  lockWaitMs?: number
}>

const ATTEMPTS = 8

function tokenOf(bytes: Buffer | null): string {
  return bytes ? createHash('sha256').update(bytes).digest('base64url') : 'absent'
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

export function createSimJsonFile<T>(options: SimJsonFileOptions<T>): SimJsonFile<T> {
  const { path } = options
  const waitMs = options.lockWaitMs ?? SIM_REGISTRY_LOCK_WAIT_MS

  const read = async (): Promise<SimJsonRead<T>> => {
    let bytes: Buffer | null
    try {
      bytes = await bytesAt(path)
    } catch (error) {
      return { ok: false, message: `${path} cannot be read: ${String(error)}` }
    }
    if (!bytes) {
      return { ok: true, value: options.empty(), token: tokenOf(null) }
    }
    let json: unknown
    try {
      json = JSON.parse(bytes.toString('utf8'))
    } catch {
      return { ok: false, message: `${path} is not JSON; Pod leaves it alone (move it aside)` }
    }
    const value = options.parse(json)
    return value === null
      ? {
          ok: false,
          message: `${path} is damaged or from a newer Pod; Pod leaves it alone (move it aside)`
        }
      : { ok: true, value, token: tokenOf(bytes) }
  }

  /** Writes `next` if the file is still the one `token` named; false on a lost race. */
  const swap = async (token: string, next: T): Promise<boolean | string> => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    let lock: Awaited<ReturnType<typeof open>>
    try {
      lock = await lockWithin(options.lock, waitMs)
    } catch (error) {
      const code = errnoOf(error)
      return code === 'EAGAIN' || code === 'EWOULDBLOCK' ? false : String(error)
    }
    const temp = `${path}.${process.pid}.tmp`
    try {
      if (tokenOf(await bytesAt(path)) !== token) {
        return false
      }
      const file = await open(temp, 'w', 0o600)
      try {
        await file.writeFile(JSON.stringify(next))
        await file.sync()
      } finally {
        await file.close()
      }
      await rename(temp, path)
      return true
    } catch (error) {
      await rm(temp, { force: true })
      return String(error)
    } finally {
      await lock.close()
    }
  }

  return {
    read,
    async update(change) {
      for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
        const current = await read()
        if (!current.ok) {
          return current
        }
        const next = change(structuredClone(current.value))
        if (next === null) {
          return { ok: true, value: current.value, changed: false }
        }
        const swapped = await swap(current.token, next)
        if (swapped === true) {
          return { ok: true, value: next, changed: true }
        }
        if (typeof swapped === 'string') {
          return { ok: false, message: `${path} cannot be written: ${swapped}` }
        }
      }
      return { ok: false, message: `${path} changed under ${ATTEMPTS} attempts in a row` }
    }
  }
}
