// Fork-only (Pod): how many machines Pod made since OrbStack last started. OrbStack 2.2.3 keeps
// the address of every machine it deleted (orbstack/orbstack#2688), so a few hundred creates run
// its machine network out of addresses; past `warnAt` the clients say so before it happens.
import { readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { PodOrbstackChurn } from '../../../shared/pod-orbstack-types'
import type { OrbstackToolRunner } from './pod-orbstack-tools'

export const POD_ORBSTACK_CHURN_WARN_AT = 180

type Saved = { boot: string | null; creates: number; since: number }

/**
 * OrbStack's start, as the birth time of its vmgr log, which it starts afresh each launch
 * (the last one becomes vmgr.1.log); null when there is none to read.
 */
export function orbstackBootMarker(home: string): string | null {
  try {
    return String(statSync(join(home, '.orbstack', 'log', 'vmgr.log')).birthtimeMs)
  } catch {
    return null
  }
}

export function createPodOrbstackChurn(deps: {
  file: string
  bootMarker: () => string | null
  now?: () => number
}) {
  const now = deps.now ?? Date.now
  const load = (): Saved => {
    try {
      const saved: unknown = JSON.parse(readFileSync(deps.file, 'utf8'))
      if (
        typeof saved === 'object' &&
        saved !== null &&
        'creates' in saved &&
        typeof saved.creates === 'number' &&
        'since' in saved &&
        typeof saved.since === 'number'
      ) {
        const boot = 'boot' in saved && typeof saved.boot === 'string' ? saved.boot : null
        return { boot, creates: saved.creates, since: saved.since }
      }
    } catch {
      // No file yet, or an unreadable one: start counting.
    }
    return { boot: null, creates: 0, since: now() }
  }
  // A new OrbStack start begins a new count.
  const current = (): Saved => {
    const saved = load()
    const boot = deps.bootMarker()
    return boot !== null && boot !== saved.boot ? { boot, creates: 0, since: now() } : saved
  }
  return {
    /** One machine Pod asked OrbStack for (a create, a clone, a template build), done or not. */
    count(): void {
      const next = current()
      next.creates += 1
      try {
        mkdirSync(dirname(deps.file), { recursive: true })
        writeFileSync(deps.file, JSON.stringify(next))
      } catch {
        // A count that can't be saved only makes the warning late.
      }
    },
    snapshot(): PodOrbstackChurn {
      const { creates, since } = current()
      return { creates, since, warnAt: POD_ORBSTACK_CHURN_WARN_AT }
    }
  }
}

export type PodOrbstackChurnCounter = ReturnType<typeof createPodOrbstackChurn>

/** The runner, counting every `orb create` and `orb clone` it runs. */
export function countMachineCreates(
  run: OrbstackToolRunner,
  churn: PodOrbstackChurnCounter
): OrbstackToolRunner {
  return (tool, args, options) => {
    if (tool === 'orb' && (args[0] === 'create' || args[0] === 'clone')) {
      churn.count()
    }
    return run(tool, args, options)
  }
}
