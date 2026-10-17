// Fork-only (Pod): a Mac-wide JSON file the app module shares between runtimes (builds, Metro
// ports), with the registry's discipline and its swap (sim-registry-file-store.ts): reads take no
// lock, every write is a compare-and-swap under the same flock, a temp file renamed over the old
// one. A file this runtime cannot read (damaged, or a newer layout) is never written; a record in it
// this runtime cannot read is the parser's to keep (`serialize` writes it back as it was).
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  simBytesAt,
  simFileToken,
  simSwapFile,
  SIM_REGISTRY_LOCK_WAIT_MS
} from '../adapters/sim-registry-file-store'

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
  // The JSON written for a value; the value itself when absent.
  serialize?: (value: T) => unknown
  empty: () => T
  lockWaitMs?: number
}>

const ATTEMPTS = 8

/**
 * Records one by one: the ones `parse` takes, and the ones it does not (a newer Pod's state or
 * shape) kept as they are, for `serialize` to write back.
 */
export function simReadRecords<R>(
  raw: readonly unknown[],
  parse: (record: unknown) => R | null
): { known: R[]; unread: unknown[] } {
  const known: R[] = []
  const unread: unknown[] = []
  for (const record of raw) {
    const parsed = parse(record)
    if (parsed === null) {
      unread.push(record)
    } else {
      known.push(parsed)
    }
  }
  return { known, unread }
}

export function createSimJsonFile<T>(options: SimJsonFileOptions<T>): SimJsonFile<T> {
  const { path } = options
  const waitMs = options.lockWaitMs ?? SIM_REGISTRY_LOCK_WAIT_MS
  const serialize = options.serialize ?? ((value: T) => value)

  const read = async (): Promise<SimJsonRead<T>> => {
    let bytes: Buffer | null
    try {
      bytes = await simBytesAt(path)
    } catch (error) {
      return { ok: false, message: `${path} cannot be read: ${String(error)}` }
    }
    if (!bytes) {
      return { ok: true, value: options.empty(), token: simFileToken(null) }
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
      : { ok: true, value, token: simFileToken(bytes) }
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
        await mkdir(dirname(path), { recursive: true, mode: 0o700 })
        const swapped = await simSwapFile({
          path,
          lock: options.lock,
          waitMs,
          token: current.token,
          bytes: Buffer.from(JSON.stringify(serialize(next)))
        })
        if (swapped === 'swapped') {
          return { ok: true, value: next, changed: true }
        }
        if (swapped !== 'conflict') {
          return { ok: false, message: `${path} cannot be written: ${swapped.error}` }
        }
      }
      return { ok: false, message: `${path} changed under ${ATTEMPTS} attempts in a row` }
    }
  }
}
