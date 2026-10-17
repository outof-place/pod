// The pool on real devices, through every real adapter (stage 4b's outer loop). Opt in, under the
// shared e2e lock, never in a plain run:
//   lockf -t 3000 /private/tmp/pn-e2e.lock env POD_SIM_REAL=1 pnpm test src/main/pod/sim/adapters/sim-pool-real
// Devices live only in a throwaway POD_SIM_HOME under /private/tmp; claude-acc's lease files go to
// a directory beside it, never to claude-acc's own. One device at most, deleted at the end. The
// hop timings and the trace go to POD_SIM_EVIDENCE (default /private/tmp/pod-sim-evidence).
import { runProcess } from '@orca/process-host'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { simLeaseKey, type SimHolder } from '../../../../shared/pod-sim/sim-holder'
import { SimPoolCoordinator, simPoolPollMs } from '../pool/sim-pool-coordinator'
import type { SimPoolConfig } from '../pool/sim-pool-config'
import type { SimLeaseRequest } from '../pool/sim-pool-commands'
import type { SimRuntime } from '../pool/sim-pool-ports'
import { claudeAccPaths } from '../claude-acc/sim-claude-acc-paths'
import { simPodHome, type SimPodHome } from './sim-pod-home'
import { simRunProcess } from './sim-command-run'
import { createSimProcessFacts } from './sim-process-facts'
import { createSimRealPorts, simRuntimeOf, type SimRealPorts } from './sim-pool-real-ports'
import { parseSimctlList } from './sim-simctl-output'
import { resolveSimTools } from './sim-tools'
import { timeHops, type HopTimes } from './sim-pool-real.test-support'

const REAL = process.env.POD_SIM_REAL === '1'
const EVIDENCE = process.env.POD_SIM_EVIDENCE || '/private/tmp/pod-sim-evidence'
const CLAUDE_ACC_REPO = join(homedir(), 'Desktop', 'projekty', 'claude-acc-oop')
const CONFIG: SimPoolConfig = {
  namePrefix: 'Portivo-',
  podCap: 2,
  idleMs: 30 * 60_000,
  warmMs: 10 * 60_000,
  claimMs: 180_000,
  // One device of this test's, ever.
  maxDevicesPerClass: 1,
  deviceTypes: {
    iphone: {
      deviceType: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
      runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5'
    }
  }
}

/** Devices of a set as simctl lists them (the default set without `--set`). */
async function listed(set?: string): Promise<string[]> {
  const result = await runProcess({
    program: '/usr/bin/xcrun',
    args: ['simctl', ...(set ? ['--set', set] : []), 'list', 'devices', '-j'],
    timeoutMs: 60_000
  })
  const devices = parseSimctlList(result.stdout)
  if (!devices) {
    throw new Error(`simctl list printed no JSON: ${result.stderr}`)
  }
  return devices
    .map((device) => `${device.runtime} ${device.name} ${device.udid} ${device.state}`)
    .sort()
}

describe.skipIf(!REAL)('the pool on real simulators', () => {
  let root: string
  let home: SimPodHome
  let ports: SimRealPorts
  let coordinator: SimPoolCoordinator
  let holder: SimHolder
  let self: SimRuntime
  let before: string[]
  let hops: HopTimes
  const notified: string[] = []
  const steps: object[] = []

  beforeAll(async () => {
    mkdirSync(EVIDENCE, { recursive: true })
    hops = timeHops(join(EVIDENCE, 'real-hops.json'))
    before = await listed()
    root = await mkdtemp('/private/tmp/pod-sim-real.')
    home = simPodHome({ POD_SIM_HOME: root })
    const runtime = await simRuntimeOf(join(root, 'profile'), createSimProcessFacts())
    if (!runtime) {
      throw new Error('cannot read this process’s start')
    }
    self = { ...runtime, profile: 'pod-sim-real' }
    holder = {
      kind: 'process',
      id: `process:${process.pid}:${self.startedAt}`,
      pid: process.pid,
      startedAt: self.startedAt
    }
    // The guard's lease directory beside the home: its parent exists, as claude-acc's does.
    const made = createSimRealPorts({
      home,
      leaseDirectory: join(root, 'claude-acc-leases'),
      claudeAcc: claudeAccPaths(),
      self,
      waiters: { notify: (leaseId) => notified.push(leaseId) },
      power: new EventEmitter(),
      panes: null,
      onRegistryTiming: hops.registry
    })
    if (!made.ok) {
      throw new Error(made.message)
    }
    ports = made.ports
    coordinator = new SimPoolCoordinator(hops.wrap(ports), CONFIG, self)
  })

  afterAll(async () => {
    // Whatever happened above, nothing of this test stays booted or on disk.
    if (home && ports) {
      const left = await listed(home.deviceSet).catch(() => [])
      for (const line of left) {
        const udid = line.split(' ')[2]
        await ports.devices.shutDown(udid)
        await ports.devices.delete(udid)
      }
      ports.dispose()
    }
    hops?.report()
    writeFileSync(join(EVIDENCE, 'real-trace.json'), JSON.stringify(steps, null, 1))
    if (root) {
      await rm(root, { recursive: true, force: true })
    }
    expect(await listed()).toEqual(before)
  }, 300_000)

  const request = (): SimLeaseRequest => ({
    key: simLeaseKey(holder.id, root),
    holder,
    worktreeRoot: root,
    app: { id: 'sim-real', bundleId: 'dev.pod.simreal' }
  })

  /** What the runtime's loop does: poll, run the effects, wait for the ops, until `done`. */
  async function driveUntil(done: () => Promise<boolean>, timeoutMs: number): Promise<void> {
    const deadline = performance.now() + timeoutMs
    while (!(await done())) {
      if (performance.now() > deadline) {
        throw new Error('the pool did not get there in time')
      }
      const poll = await coordinator.poll({ relist: true })
      expect(poll.ok).toBe(true)
      if (poll.ok) {
        await trace(
          poll.effects.map(
            (effect) => `${effect.kind} ${'udid' in effect ? effect.udid.slice(0, 8) : ''}`
          )
        )
        await coordinator.dispatch(poll.effects)
      }
      await coordinator.settled()
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }

  /** Each poll's registry and effects, written beside the evidence for a run that went wrong. */
  async function trace(effects: string[]): Promise<void> {
    const now = await registry()
    steps.push({
      at: Math.round(performance.now()),
      devices: now.devices.map((device) => [
        device.name,
        device.state,
        device.op?.kind ?? '',
        device.failure?.message ?? ''
      ]),
      leases: now.leases.map((lease) => [lease.state, lease.queue?.waitingFor ?? '']),
      makeFailures: now.makeFailures ?? [],
      effects
    })
  }

  async function registry() {
    const read = await ports.store.read()
    if (!read.ok) {
      throw new Error(read.message)
    }
    return read.registry
  }

  it(
    'makes a fresh slim device, boots it and hands it to a lease',
    async () => {
      // The runtime's first poll: simctl's list of the empty set and claude-acc's reading.
      const poll = await coordinator.poll({ relist: true })
      expect(poll.ok).toBe(true)
      const started = performance.now()
      const first = await coordinator.run({ kind: 'lease', request: request() })
      expect(first.ok && first.answer.kind === 'lease' && first.answer.answer.status).toBe(
        'waiting'
      )
      if (!first.ok || first.answer.kind !== 'lease') {
        return
      }
      // An open `lease --wait`: the device is claimed the moment it is ready.
      const answer = first.answer.answer
      if (answer.status === 'refused') {
        throw new Error(`refused: ${answer.refusal.code}`)
      }
      coordinator.openCalls.add(answer.lease.leaseId)
      steps.push({
        firstAnswer: answer.status,
        waitingFor: 'waitingFor' in answer ? answer.waitingFor : null
      })
      await coordinator.dispatch(first.effects)
      await driveUntil(
        async () => (await registry()).leases.some((lease) => lease.state === 'active'),
        12 * 60_000
      )
      hops.note('cold lease to active, ms', performance.now() - started)
      const now = await registry()
      expect(now.devices).toHaveLength(1)
      expect(now.devices[0]).toMatchObject({ state: 'leased', name: 'Portivo-Pod-1' })
      const simslim = (await resolveSimTools(simRunProcess)).simslim
      if (!simslim) {
        throw new Error('simslim is not on PATH')
      }
      const verify = await runProcess({
        program: simslim,
        args: ['--set', home.deviceSet, 'verify', now.devices[0].udid],
        timeoutMs: 60_000
      })
      expect(verify.stdout).toContain('matches the profile')
    },
    15 * 60_000
  )

  it('writes the lease file claude-acc reads, and claude-acc counts the device', async () => {
    const device = (await registry()).devices[0]
    const file = join(root, 'claude-acc-leases', `${device.udid}.json`)
    const written = JSON.parse(await readFile(file, 'utf8'))
    expect(written).toMatchObject({
      owner: { pid: process.pid },
      app: 'sim-real',
      holder: holder.id
    })
    if (existsSync(join(CLAUDE_ACC_REPO, 'devguard_core.py'))) {
      // claude-acc's own reader: the guard would read this holder as alive.
      const check = await runProcess({
        program: '/usr/bin/python3',
        args: [
          '-I',
          '-B',
          '-c',
          [
            'import json, sys',
            `sys.path.insert(0, ${JSON.stringify(CLAUDE_ACC_REPO)})`,
            'import devguard_core as d',
            `lease = d.read_lease({"simulator_leases": ${JSON.stringify(join(root, 'claude-acc-leases'))}}, ${JSON.stringify(device.udid)})`,
            'print(json.dumps({"alive": d.lease_alive(lease), "app": lease.get("app")}))'
          ].join('\n')
        ],
        timeoutMs: 30_000
      })
      expect(JSON.parse(check.stdout)).toEqual({ alive: true, app: 'sim-real' })
    }
    hops.note('claude-acc guard sees the device', await hops.guardSees(device.udid))
  }, 120_000)

  it(
    'keeps the released device warm and hands it to the next lease in milliseconds',
    async () => {
      for (let cycle = 0; cycle < 30; cycle += 1) {
        const released = await coordinator.run({
          kind: 'release',
          caller: { key: simLeaseKey(holder.id, root), holder, worktreeRoot: root }
        })
        expect(released.ok).toBe(true)
        if (released.ok) {
          await coordinator.dispatch(released.effects)
        }
        await coordinator.settled()
        const warm = await registry()
        expect(warm.devices[0]).toMatchObject({ state: 'ready' })
        // The warm window holds it: nothing shuts it down on the next poll.
        const poll = await coordinator.poll()
        expect(poll.ok && poll.effects.filter((effect) => effect.kind === 'shutDown')).toEqual([])
        expect(coordinator.wakeAt).not.toBeNull()
        hops.startCycle()
        const lease = await coordinator.run({ kind: 'lease', request: request() })
        if (lease.ok) {
          await coordinator.dispatch(lease.effects)
        }
        hops.endCycle()
        expect(lease.ok && lease.answer.kind === 'lease' && lease.answer.answer.status).toBe(
          'ready'
        )
      }
    },
    10 * 60_000
  )

  it('shuts the free device down after its warm window, then forgets it once it is deleted', async () => {
    const device = (await registry()).devices[0]
    const released = await coordinator.run({
      kind: 'release',
      caller: { key: simLeaseKey(holder.id, root), holder, worktreeRoot: root }
    })
    if (released.ok) {
      await coordinator.dispatch(released.effects)
    }
    await coordinator.settled()
    // This runtime again, restarted with a one-second warm window: the pool shuts it down itself.
    coordinator = new SimPoolCoordinator(hops.wrap(ports), { ...CONFIG, warmMs: 1_000 }, self)
    const cooling = performance.now()
    await driveUntil(async () => (await registry()).devices[0]?.state === 'shutdown', 120_000)
    hops.note('free device to shut down by the pool, ms', performance.now() - cooling)
    // Idle: nothing leased or booted, so no poll timer and no wake-up.
    expect(simPoolPollMs(await registry())).toBeNull()
    // Deleted outside Pod: the set is empty on disk too, so the pool forgets the device.
    expect((await ports.devices.delete(device.udid)).ok).toBe(true)
    expect(await ports.devices.observe()).toEqual({ verdict: 'ok', devices: [], onDisk: [] })
    await driveUntil(async () => (await registry()).devices.length === 0, 120_000)
    const after = await registry()
    expect(after.leases).toEqual([])
    expect(simPoolPollMs(after)).toBeNull()
    expect(existsSync(join(root, 'claude-acc-leases', `${device.udid}.json`))).toBe(false)
  }, 300_000)
})
