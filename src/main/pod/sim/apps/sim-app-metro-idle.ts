// Fork-only (Pod): a worktree's Metro stopped once it idles. The registry's leases say which
// worktree and app still need theirs; a Metro Pod started with none for the grace is stopped (it
// holds a GB or more, pre-mortem item 10), one that exited is forgotten, and the record of a
// worktree that is gone is dropped. A Metro Pod did not start is never touched.
import { stat } from 'node:fs/promises'
import type { SimRegistryFile } from '../../../../shared/pod-sim/sim-registry'
import type { SimJsonFile } from './sim-app-json-file'
import { simMetroKey, type SimMetroFile, type SimMetroRecord } from './sim-app-metro-ports'
import type { SimProcessControl } from './sim-app-spawn'

/** Stops each idle Metro past the grace; answers the worktree and app keys it stopped. */
export async function stopIdleSimMetros(
  options: Readonly<{
    file: SimJsonFile<SimMetroFile>
    control: SimProcessControl
    now: () => number
    graceMs: number
  }>,
  registry: SimRegistryFile
): Promise<string[]> {
  const read = await options.file.read()
  if (!read.ok) {
    return []
  }
  const at = options.now()
  const inUse = new Set(
    registry.leases.flatMap((lease) =>
      lease.app ? [simMetroKey({ worktreeRoot: lease.worktreeRoot, appId: lease.app.id })] : []
    )
  )
  const stop: SimMetroRecord[] = []
  const exited = new Set<string>()
  const gone = new Set<string>()
  for (const record of read.value.servers) {
    if (!record.process) {
      if (!(await stat(record.worktreeRoot).catch(() => null))) {
        gone.add(simMetroKey(record))
      }
    } else if ((await options.control.state(record.process)) === 'exited') {
      exited.add(simMetroKey(record))
    } else if (
      !inUse.has(simMetroKey(record)) &&
      record.idleSince !== undefined &&
      at - record.idleSince >= options.graceMs
    ) {
      stop.push(record)
    }
  }
  for (const record of stop) {
    if (record.process) {
      await options.control.stop(record.process)
    }
  }
  const stopped = new Set(stop.map(simMetroKey))
  await options.file.update((value) => {
    let changed = false
    const servers = value.servers.filter((record) => {
      const drop = gone.has(simMetroKey(record)) && !record.process
      changed ||= drop
      return !drop
    })
    for (const record of servers) {
      const key = simMetroKey(record)
      if (record.process && (stopped.has(key) || exited.has(key))) {
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
