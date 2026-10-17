// One runtime of the two-process registry race (sim-registry-race.test.ts), bundled by esbuild.
// argv: <mode cas|duel> <POD_SIM_HOME> <runtime index 0|1> <count> <start, epoch ms>
// cas: append <count> devices through read and compare-and-swap, retrying conflicts.
// duel: <count> rounds; in each both runtimes lease the same single free device at once.
import { simLeaseKey } from '../../../../../shared/pod-sim/sim-holder'
import type { SimRegistryFile } from '../../../../../shared/pod-sim/sim-registry'
import { SimPoolCoordinator } from '../../pool/sim-pool-coordinator'
import { fakePorts } from '../../pool/sim-pool-coordinator.test-support'
import { agent, IPHONE, PEER, ROOT, SELF } from '../../pool/sim-pool.test-support'
import { simPodHome } from '../sim-pod-home'
import { createSimRegistryFileStore } from '../sim-registry-file-store'

const [mode, homePath, index, count, startAt] = process.argv.slice(2)
const me = Number(index)
const home = simPodHome({ POD_SIM_HOME: homePath })
const store = createSimRegistryFileStore({ home, lockWaitMs: 10_000 })

function udidOf(runtime: number, n: number): string {
  return `${String(runtime).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`
}

function withDevice(registry: SimRegistryFile, n: number): SimRegistryFile {
  return {
    ...registry,
    updatedAt: registry.updatedAt + 1,
    devices: [
      ...registry.devices,
      {
        udid: udidOf(me, n),
        name: `Portivo-Pod-r${me}n${n}`,
        role: 'pool',
        deviceType: IPHONE,
        runtime: 'iOS 26.5',
        createdAt: 1_760_600_000_000,
        state: 'shutdown'
      }
    ]
  }
}

async function cas(): Promise<object> {
  let conflicts = 0
  for (let n = 0; n < Number(count); n += 1) {
    for (;;) {
      const read = await store.read()
      if (!read.ok) {
        throw new Error(read.message)
      }
      const swap = await store.swap(read.token, withDevice(read.registry, n))
      if (swap.ok) {
        break
      }
      if (swap.reason !== 'conflict') {
        throw new Error(swap.message)
      }
      conflicts += 1
    }
  }
  return { conflicts }
}

/** Round r: both runtimes lease the one device of model `iPhone Duel r` for a holder of their own. */
async function duel(): Promise<object> {
  const self = me === 0 ? SELF : PEER
  const seed = await store.read()
  if (!seed.ok) {
    throw new Error(seed.message)
  }
  const ports = { ...fakePorts(seed.registry).forRuntime(self), store }
  const coordinator = new SimPoolCoordinator(
    ports,
    {
      namePrefix: 'Portivo-',
      podCap: 2,
      idleMs: 30 * 60_000,
      warmMs: 10 * 60_000,
      claimMs: 180_000,
      maxDevicesPerClass: 4,
      deviceTypes: { iphone: { deviceType: IPHONE, runtime: 'iOS 26.5' } }
    },
    self
  )
  const answers: { round: number; status: string; udid?: string; holder: string }[] = []
  for (let round = 0; round < Number(count); round += 1) {
    // Each round starts in the same millisecond in both processes.
    const slot = Number(startAt) + round * 150
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, slot - Date.now())))
    const holder = agent(44_000 + me * 100 + round)
    const run = await coordinator.run({
      kind: 'lease',
      request: {
        key: simLeaseKey(holder.id, ROOT),
        holder,
        worktreeRoot: ROOT,
        wants: { deviceClass: 'iphone', deviceType: `iPhone Duel ${round}` }
      }
    })
    if (!run.ok || run.answer.kind !== 'lease') {
      throw new Error(run.ok ? 'not a lease answer' : run.message)
    }
    const answer = run.answer.answer
    answers.push({
      round,
      status: answer.status,
      holder: holder.id,
      ...(answer.status === 'ready' ? { udid: answer.device.udid } : {})
    })
  }
  return { answers }
}

// Both processes start their first read in the same millisecond, past both workers' startup.
const start = new Promise((resolve) =>
  setTimeout(resolve, Math.max(0, Number(startAt) - Date.now()))
)
const work = mode === 'cas' ? start.then(cas) : duel()
work.then(
  (result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`)
  },
  (error: unknown) => {
    process.stderr.write(`${String(error)}\n`)
    process.exitCode = 1
  }
)
