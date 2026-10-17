// Fork-only (Pod): which worktrees need their Metro, and stopping the ones that idle. A Metro holds
// 1 to 3 GB (pre-mortem item 10), so only a lease that will use it soon keeps one: a lease that holds
// a device, or a waiter the pool is readying a device for (`waitingFor: device`, which it sets only
// within free capacity). A waiter for a slot, the brake or its build keeps none: ten queued
// worktrees are not ten Metros. A Metro Pod started with no such lease for the grace is stopped, one
// that exited is forgotten, and the record of a worktree that is gone is dropped. While `ps` cannot
// say (a busy Mac), nothing is stopped or forgotten. A Metro Pod did not start is never touched.
import { stat } from 'node:fs/promises'
import type { SimRegistryFile } from '../../../../shared/pod-sim/sim-registry'
import type { SimJsonFile } from './sim-app-json-file'
import {
  simMetroKey,
  simMetroProcess,
  type SimMetroFile,
  type SimMetroRecord
} from './sim-app-metro-ports'
import type { SimProcessControl } from './sim-app-spawn'

export type SimMetroLease = Readonly<{ worktreeRoot: string; appId: string }>

/** The worktree and app of each lease that uses its Metro now or next, by Metro key. */
export function simMetroLeases(registry: SimRegistryFile): Map<string, SimMetroLease> {
  const wanted = new Map<string, SimMetroLease>()
  for (const lease of registry.leases) {
    const soon =
      lease.state === 'reserved' ||
      lease.state === 'active' ||
      lease.state === 'takeover' ||
      (lease.state === 'waiting' && lease.queue?.waitingFor === 'device')
    if (soon && lease.app) {
      const entry = { worktreeRoot: lease.worktreeRoot, appId: lease.app.id }
      wanted.set(simMetroKey(entry), entry)
    }
  }
  return wanted
}

/** Stops each idle Metro past the grace; answers the worktree and app keys it stopped. */
export async function stopIdleSimMetros(
  options: Readonly<{
    file: SimJsonFile<SimMetroFile>
    control: SimProcessControl
    now: () => number
    graceMs: number
  }>,
  inUse: ReadonlySet<string>
): Promise<string[]> {
  const read = await options.file.read()
  if (!read.ok) {
    return []
  }
  const at = options.now()
  const stop: SimMetroRecord[] = []
  // Key to the pid seen exited or stopped: a Metro started since under the key is not this one.
  const ended = new Map<string, number>()
  const gone = new Set<string>()
  for (const record of read.value.servers) {
    const server = simMetroProcess(record)
    if (!server) {
      if (!(await stat(record.worktreeRoot).catch(() => null))) {
        gone.add(simMetroKey(record))
      }
    } else if ((await options.control.state(server)) === 'exited') {
      ended.set(simMetroKey(record), server.pid)
    } else if (
      !inUse.has(simMetroKey(record)) &&
      record.idleSince !== undefined &&
      at - record.idleSince >= options.graceMs
    ) {
      stop.push(record)
    }
  }
  const stopped = new Set<string>()
  for (const record of stop) {
    const server = simMetroProcess(record)
    // Unknown: `ps` did not answer; it stays recorded for the next pass.
    if (server && (await options.control.stop(server)) !== 'unknown') {
      stopped.add(simMetroKey(record))
      ended.set(simMetroKey(record), server.pid)
    }
  }
  await options.file.update((value) => {
    let changed = false
    const servers = value.servers.filter((record) => {
      const drop = gone.has(simMetroKey(record)) && !record.process
      changed ||= drop
      return !drop
    })
    for (const record of servers) {
      const key = simMetroKey(record)
      if (record.process && ended.get(key) === record.process.pid) {
        delete record.process
        delete record.idleSince
        changed = true
      } else if (record.process && inUse.has(key) && record.idleSince !== undefined) {
        delete record.idleSince
        changed = true
      } else if (record.process && !inUse.has(key) && record.idleSince === undefined) {
        record.idleSince = at
        changed = true
      }
    }
    return changed ? { ...value, servers } : null
  })
  return [...stopped]
}
