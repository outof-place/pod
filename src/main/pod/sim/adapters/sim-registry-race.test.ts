// Two runtimes, two processes, one registry file: no write is lost and no device is handed out
// twice, whatever the interleaving. The worker is bundled with esbuild and run by plain node.
import { runProcess } from '@orca/process-host'
import { build } from 'esbuild'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SimRegistryFile } from '../../../../shared/pod-sim/sim-registry'
import { T0, udid } from '../pool/sim-pool.test-support'
import { claimSimPodHome, simPodHome } from './sim-pod-home'

let dir: string
let worker: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pod-sim-race-'))
  worker = join(dir, 'registry-race-worker.cjs')
  await build({
    entryPoints: [join(__dirname, '__fixtures__', 'registry-race-worker.ts')],
    outfile: worker,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent'
  })
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function race(mode: 'cas' | 'duel', home: string, count: number) {
  const startAt = String(Date.now() + 1_000)
  const runs = await Promise.all(
    [0, 1].map((index) =>
      runProcess({
        program: process.execPath,
        args: [worker, mode, home, String(index), String(count), startAt],
        timeoutMs: 60_000
      })
    )
  )
  for (const run of runs) {
    expect(run.stderr).toBe('')
    expect(run.code).toBe(0)
  }
  return runs.map((run) => JSON.parse(run.stdout))
}

async function registryAt(home: string): Promise<SimRegistryFile> {
  return JSON.parse(await readFile(simPodHome({ POD_SIM_HOME: home }).registry, 'utf8'))
}

// The store's flock is Darwin's O_EXLOCK; elsewhere the store refuses (sim-registry-file-store.test.ts).
describe.skipIf(process.platform !== 'darwin')(
  'the registry file shared by two runtime processes',
  () => {
    it('loses no write when both append at once', async () => {
      const home = join(dir, 'cas')
      const results = await race('cas', home, 150)
      const names = (await registryAt(home)).devices.map((device) => device.name)
      expect(names).toHaveLength(300)
      expect(new Set(names).size).toBe(300)
      // They really raced: at least one swap lost to the other process and went again.
      expect(results[0].conflicts + results[1].conflicts).toBeGreaterThan(0)
    }, 60_000)

    it('hands one free device to one of two leases made at once, never to both', async () => {
      const home = join(dir, 'duel')
      const rounds = 12
      const devices = Array.from({ length: rounds }, (_, n) => ({
        udid: udid(n + 1),
        name: `Portivo-Pod-${n + 1}`,
        role: 'pool' as const,
        deviceType: `iPhone Duel ${n}`,
        runtime: 'iOS 26.5',
        createdAt: T0 - 86_400_000,
        state: 'ready' as const
      }))
      await mkdir(home, { recursive: true })
      expect(await claimSimPodHome(simPodHome({ POD_SIM_HOME: home }))).toEqual({ ok: true })
      await writeFile(
        simPodHome({ POD_SIM_HOME: home }).registry,
        JSON.stringify({ version: 1, updatedAt: T0 - 60_000, devices, leases: [] })
      )
      const [mine, theirs] = await race('duel', home, rounds)
      const after = await registryAt(home)
      for (let round = 0; round < rounds; round += 1) {
        const answers = [mine.answers[round], theirs.answers[round]]
        const ready = answers.filter((answer: { status: string }) => answer.status === 'ready')
        expect(ready, `round ${round}`).toHaveLength(1)
        const holders = after.leases.filter((lease) => lease.udid === udid(round + 1))
        expect(holders.map((lease) => [lease.holder.id, lease.state])).toEqual([
          [ready[0].holder, 'active']
        ])
      }
    }, 60_000)
  }
)
