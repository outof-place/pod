// Fork-only (Pod): claude-acc's lease file for every Pod device, golden and idle ones included,
// so its guard counts them and portivo-mobile never picks them. The owner is the agent holding the
// device when it has a process to check (pid plus start); otherwise the runtime serving the lease:
// during a takeover (the agent may be gone while Filip drives), for a reservation, and for holders
// without a pid. A device nobody holds names this runtime. The holder's agent session and the
// lease's app ride along for claude-acc's status (`lease_session`, `lease_app`). Only changes are
// written, and a fresh runtime writes all of them first, before any other effect.
import { leaseOn } from '../leases/sim-lease-records'
import type { SimPoolDraft, SimPoolEffect } from './sim-pool-draft'
import type { SimLeaseFile } from './sim-pool-ports'

const PROVISIONAL_OPS = new Set(['clone', 'create'])

function fileOf(d: SimPoolDraft, udid: string): SimLeaseFile {
  const lease = leaseOn(d, udid)
  if (!lease) {
    return { owner: { pid: d.self.pid, startedAt: d.self.startedAt }, holder: 'pod:pool' }
  }
  const { holder } = lease
  const byProcess = holder.kind === 'agent' || holder.kind === 'process'
  const owner =
    lease.state === 'active' && byProcess && holder.pid && holder.startedAt !== undefined
      ? { pid: holder.pid, startedAt: holder.startedAt }
      : lease.servedBy
  return {
    owner: { pid: owner.pid, startedAt: owner.startedAt },
    holder: holder.id,
    ...(holder.sessionId ? { session: holder.sessionId } : {}),
    ...(lease.app ? { app: lease.app.id } : {})
  }
}

export function leaseFileEffects(d: SimPoolDraft): SimPoolEffect[] {
  const effects: SimPoolEffect[] = []
  const written = d.memory.leaseFiles
  const present = new Set<string>()
  for (const device of d.registry.devices) {
    if (device.op && PROVISIONAL_OPS.has(device.op.kind)) {
      continue
    }
    present.add(device.udid)
    const file = fileOf(d, device.udid)
    const { owner } = file
    const signature = `${owner.pid}:${owner.startedAt}:${file.holder}:${file.session ?? ''}:${file.app ?? ''}`
    if (written[device.udid] !== signature) {
      written[device.udid] = signature
      effects.push({ kind: 'writeLeaseFile', udid: device.udid, file })
    }
  }
  for (const udid of Object.keys(written)) {
    if (!present.has(udid)) {
      delete written[udid]
      effects.push({ kind: 'removeLeaseFile', udid })
    }
  }
  return effects
}
