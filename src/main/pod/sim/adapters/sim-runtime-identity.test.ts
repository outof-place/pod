// The skeptic's finding A, rebuilt: a peer runtime judges this one by the start it reads from the
// process table. This runtime must name itself by that same start, or a cold start (seconds
// between the kernel's start and Node's time origin) makes it read as dead, and the peer fails its
// boot and takes over its leases.
import { describe, expect, it } from 'vitest'
import { simLeaseKey } from '../../../../shared/pod-sim/sim-holder'
import { runtimeKey } from '../pool/sim-pool-draft'
import { agent, IPHONE, PEER, PoolWorld, ROOT, T0, udid } from '../pool/sim-pool.test-support'
import { createSimLiveness } from './sim-liveness'
import type { SimProcessFacts } from './sim-process-facts'
import { simRuntimeOf } from './sim-pool-real-ports'

describe('a live runtime as its peer sees it', () => {
  it('keeps its boot and its leases when it started seconds before Node’s time origin', async () => {
    // Filip's Pod is this process; the kernel started it 3 s before Node's own time origin.
    const kernelStart = Math.floor(performance.timeOrigin / 1000) - 3
    const table: SimProcessFacts = {
      startOf: async (pid) =>
        pid === process.pid ? { found: true, startedAt: kernelStart } : { found: false },
      table: async () => []
    }
    const filip = await simRuntimeOf('/Users/f/Library/Application Support/Pod', table)
    if (!filip) {
      throw new Error('no start')
    }
    // The probe's runtime, stepping the shared registry.
    const probe = new PoolWorld()
    probe.self = PEER
    const holder = agent(42001)
    const booting = probe.device(1, { state: 'booting' })
    probe.found(booting).op = { kind: 'boot', by: filip, since: T0 - 5_000 }
    probe.addLease(holder, { state: 'reserved', udid: booting, servedBy: filip })
    probe.registry.devices.push({
      udid: udid(2),
      name: 'Portivo-Pod-2',
      role: 'pool',
      deviceType: IPHONE,
      runtime: 'iOS 26.5',
      createdAt: T0 - 86_400_000,
      state: 'leased'
    })
    probe.observed.set(udid(2), { udid: udid(2), name: 'Portivo-Pod-2', state: 'booted' })
    probe.addLease(agent(42002), { state: 'active', udid: udid(2), servedBy: filip })
    const peer = createSimLiveness({
      deviceSet: '/x',
      processes: table,
      panes: null,
      podDevices: async () => new Set()
    })
    probe.runtimes[runtimeKey(filip)] = await peer.runtime(filip)
    probe.poll()
    expect(probe.found(booting)).toMatchObject({ state: 'booting', op: { kind: 'boot' } })
    expect(probe.found(booting).failure).toBeUndefined()
    expect(probe.registry.leases.map((lease) => lease.servedBy.pid)).toEqual([
      process.pid,
      process.pid
    ])
    expect(probe.leaseOf(holder)?.key).toBe(simLeaseKey(holder.id, ROOT))
  })
})
