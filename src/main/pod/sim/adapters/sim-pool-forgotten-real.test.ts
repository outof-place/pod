// Pod's set on real simctl, no device booted (stage 4b's fix round): a device of Pod's name the
// registry forgot is deleted through the pool, and anything else in the set stays. Opt in, under
// the shared e2e lock, never in a plain run:
//   lockf -t 3000 /private/tmp/pn-e2e.lock env POD_SIM_REAL=1 pnpm test src/main/pod/sim/adapters/sim-pool-forgotten-real
// Everything lives in a throwaway POD_SIM_HOME under /private/tmp and is deleted at the end.
import { runProcess } from '@orca/process-host'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { claudeAccPaths } from '../claude-acc/sim-claude-acc-paths'
import { SimPoolCoordinator } from '../pool/sim-pool-coordinator'
import type { SimPoolConfig } from '../pool/sim-pool-config'
import { simPodHome, type SimPodHome } from './sim-pod-home'
import { createSimProcessFacts } from './sim-process-facts'
import { createSimRealPorts, simRuntimeOf, type SimRealPorts } from './sim-pool-real-ports'
import { parseSimctlList } from './sim-simctl-output'

const REAL = process.env.POD_SIM_REAL === '1'
const EVIDENCE = process.env.POD_SIM_EVIDENCE || '/private/tmp/pod-sim-evidence'
const TYPE = 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro'
const RUNTIME = 'com.apple.CoreSimulator.SimRuntime.iOS-26-5'
const CONFIG: SimPoolConfig = {
  namePrefix: 'Portivo-',
  podCap: 2,
  idleMs: 30 * 60_000,
  warmMs: 10 * 60_000,
  claimMs: 180_000,
  maxDevicesPerClass: 1,
  deviceTypes: { iphone: { deviceType: TYPE, runtime: RUNTIME } }
}

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
  return devices.map((device) => `${device.name} ${device.udid} ${device.state}`).sort()
}

describe.skipIf(!REAL)('Pod’s set on real simctl, nothing booted', () => {
  let root: string
  let home: SimPodHome
  let ports: SimRealPorts
  let before: string[]

  beforeAll(async () => {
    mkdirSync(EVIDENCE, { recursive: true })
    before = await listed()
    root = await mkdtemp('/private/tmp/pod-sim-forgotten.')
    home = simPodHome({ POD_SIM_HOME: root })
    const self = await simRuntimeOf(join(root, 'profile'), createSimProcessFacts())
    if (!self) {
      throw new Error('cannot read this process’s start')
    }
    const made = createSimRealPorts({
      home,
      leaseDirectory: join(root, 'leases'),
      claudeAcc: claudeAccPaths(),
      self,
      waiters: { notify: () => undefined },
      power: null,
      panes: null
    })
    if (!made.ok) {
      throw new Error(made.message)
    }
    ports = made.ports
  })

  afterAll(async () => {
    if (ports) {
      for (const line of await listed(home.deviceSet).catch(() => [])) {
        await ports.devices.delete(line.split(' ')[1])
      }
      ports.dispose()
    }
    writeFileSync(join(EVIDENCE, 'forgotten-real-default-set.txt'), (await listed()).join('\n'))
    if (root) {
      await rm(root, { recursive: true, force: true })
    }
    expect(await listed()).toEqual(before)
  }, 300_000)

  it('deletes the forgotten Portivo-Pod-9 and leaves Portivo-Other-1', async () => {
    const pod = await ports.devices.create('Portivo-Pod-9', TYPE, RUNTIME)
    const other = await ports.devices.create('Portivo-Other-1', TYPE, RUNTIME)
    expect(pod.ok && other.ok).toBe(true)
    const coordinator = new SimPoolCoordinator(ports, CONFIG, {
      pid: process.pid,
      startedAt: 1,
      profile: 'pod-sim-forgotten'
    })
    const poll = await coordinator.poll({ relist: true })
    expect(poll.ok && poll.effects.map((effect) => effect.kind)).toContain('delete')
    await coordinator.dispatch(poll.ok ? poll.effects : [])
    await coordinator.settled()
    const left = await listed(home.deviceSet)
    expect(left.map((line) => line.split(' ')[0])).toEqual(['Portivo-Other-1'])
    const read = await ports.store.read()
    expect(read.ok && read.registry.devices).toEqual([])
  }, 120_000)
})
