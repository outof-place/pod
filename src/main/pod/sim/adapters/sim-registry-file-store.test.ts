import { constants, existsSync } from 'node:fs'
import { mkdir, mkdtemp, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SimRegistryFile } from '../../../../shared/pod-sim/sim-registry'
import { SIM_FLOCK_EXCLUSIVE, createSimRegistryFileStore } from './sim-registry-file-store'
import { SIM_POD_HOME_MARKER, simPodHome } from './sim-pod-home'

const DEVICE = {
  udid: '0A0A0A0A-0000-4000-8000-00000000000A',
  name: 'Portivo-Pod-1',
  role: 'pool' as const,
  deviceType: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
  runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
  createdAt: 1_760_600_000_000,
  state: 'shutdown' as const
}

function withDevice(registry: SimRegistryFile, n: number): SimRegistryFile {
  return {
    ...registry,
    updatedAt: registry.updatedAt + 1,
    devices: [...registry.devices, { ...DEVICE, name: `Portivo-Pod-${n}` }]
  }
}

// O_EXLOCK is Darwin's flag; the store refuses everywhere else (the test below that).
describe.skipIf(process.platform !== 'darwin')('the Mac-wide registry file', () => {
  let root: string
  let home: ReturnType<typeof simPodHome>
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pod-sim-registry-'))
    home = simPodHome({ POD_SIM_HOME: join(root, 'sim') })
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('reads a missing file as an empty pool and creates it on the first swap', async () => {
    const store = createSimRegistryFileStore({ home })
    const first = await store.read()
    expect(first).toMatchObject({ ok: true, registry: { version: 1, devices: [], leases: [] } })
    if (!first.ok) {
      return
    }
    const swapped = await store.swap(first.token, withDevice(first.registry, 1))
    expect(swapped.ok).toBe(true)
    const again = await store.read()
    expect(again.ok && again.registry.devices.map((device) => device.name)).toEqual([
      'Portivo-Pod-1'
    ])
    expect(again.ok && swapped.ok && again.token).toBe(swapped.ok && swapped.token)
    expect((await stat(home.registry)).mode & 0o777).toBe(0o600)
    expect((await readdir(home.root)).sort()).toEqual([
      SIM_POD_HOME_MARKER,
      'registry.json',
      'registry.lock'
    ])
  })

  it('writes nothing over a file another runtime changed since the read', async () => {
    const mine = createSimRegistryFileStore({ home })
    const theirs = createSimRegistryFileStore({ home })
    const a = await mine.read()
    const b = await theirs.read()
    if (!a.ok || !b.ok) {
      throw new Error('unreadable')
    }
    expect((await theirs.swap(b.token, withDevice(b.registry, 2))).ok).toBe(true)
    expect(await mine.swap(a.token, withDevice(a.registry, 1))).toEqual({
      ok: false,
      reason: 'conflict'
    })
    const now = await mine.read()
    expect(now.ok && now.registry.devices.map((device) => device.name)).toEqual(['Portivo-Pod-2'])
  })

  it('keeps fields a newer Pod wrote, at every level', async () => {
    const store = createSimRegistryFileStore({ home })
    const seed = await store.read()
    if (!seed.ok) {
      throw new Error('unreadable')
    }
    await store.swap(seed.token, withDevice(seed.registry, 1))
    const text = JSON.parse(await readFile(home.registry, 'utf8'))
    text.queueHints = { iphone: 2 }
    text.devices[0].thermal = 'nominal'
    await writeFile(home.registry, JSON.stringify(text))
    const read = await store.read()
    if (!read.ok) {
      throw new Error('unreadable')
    }
    await store.swap(read.token, withDevice(read.registry, 2))
    const after = JSON.parse(await readFile(home.registry, 'utf8'))
    expect(after.queueHints).toEqual({ iphone: 2 })
    expect(after.devices[0].thermal).toBe('nominal')
  })

  it('waits for the flock another process holds, and past its wait answers a conflict to retry', async () => {
    const store = createSimRegistryFileStore({ home, lockWaitMs: 150 })
    const read = await store.read()
    if (!read.ok) {
      throw new Error('unreadable')
    }
    await store.swap(read.token, withDevice(read.registry, 1))
    const held = await open(
      home.lock,
      constants.O_RDWR | constants.O_CREAT | SIM_FLOCK_EXCLUSIVE | constants.O_NONBLOCK
    )
    const blocked = await store.read()
    if (!blocked.ok) {
      throw new Error('a held lock must not stop a read')
    }
    // A slow lock is not a broken registry: the coordinator retries, then answers contention.
    const late = await store.swap(blocked.token, withDevice(blocked.registry, 2))
    expect(late).toEqual({ ok: false, reason: 'conflict' })
    // Released while a swap waits: that swap goes through.
    const waiting = store.swap(blocked.token, withDevice(blocked.registry, 3))
    setTimeout(() => void held.close(), 40)
    expect((await waiting).ok).toBe(true)
  })

  it('leaves a damaged or newer file alone and says where it is', async () => {
    const store = createSimRegistryFileStore({ home })
    const read = await store.read()
    if (!read.ok) {
      throw new Error('unreadable')
    }
    await store.swap(read.token, withDevice(read.registry, 1))
    await writeFile(home.registry, '{"version": 1, "devices": "')
    const damaged = await store.read()
    expect(damaged).toMatchObject({ ok: false, reason: 'registryUnreadable' })
    expect(!damaged.ok && damaged.message).toContain(home.registry)
    expect(await store.swap(read.token, withDevice(read.registry, 2))).toMatchObject({
      ok: false,
      reason: 'conflict'
    })
    expect(await readFile(home.registry, 'utf8')).toBe('{"version": 1, "devices": "')
    await writeFile(home.registry, JSON.stringify({ version: 2, devices: [] }))
    const newer = await store.read()
    expect(!newer.ok && newer.message).toContain('newer Pod')
  })

  it('clears temp files a swap cut short left behind, under the lock', async () => {
    await mkdir(home.root, { recursive: true })
    await writeFile(join(home.root, SIM_POD_HOME_MARKER), '')
    await writeFile(`${home.registry}.4242.tmp`, '{"version":')
    const store = createSimRegistryFileStore({ home })
    const read = await store.read()
    if (!read.ok) {
      throw new Error('unreadable')
    }
    expect((await store.swap(read.token, withDevice(read.registry, 1))).ok).toBe(true)
    expect(existsSync(`${home.registry}.4242.tmp`)).toBe(false)
  })

  it('takes no home Pod did not make', async () => {
    await mkdir(home.root, { recursive: true })
    await writeFile(join(home.root, 'notes.txt'), 'mine')
    const store = createSimRegistryFileStore({ home })
    expect(await store.read()).toMatchObject({ ok: false, reason: 'registryUnreadable' })
    expect(await readdir(home.root)).toEqual(['notes.txt'])
  })

  it('times each swap’s hops for the budget report', async () => {
    const phases: string[] = []
    const store = createSimRegistryFileStore({
      home,
      onTiming: (phase, ms) => {
        expect(ms).toBeGreaterThanOrEqual(0)
        phases.push(phase)
      }
    })
    const read = await store.read()
    if (!read.ok) {
      throw new Error('unreadable')
    }
    await store.swap(read.token, withDevice(read.registry, 1))
    expect(phases).toEqual(['read', 'lock', 'check', 'write'])
  })
})

describe('the registry off macOS', () => {
  it('refuses to read or write and creates nothing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pod-sim-linux-'))
    try {
      const home = simPodHome({ POD_SIM_HOME: join(root, 'sim') })
      const store = createSimRegistryFileStore({ home, platform: 'linux' })
      expect(await store.read()).toMatchObject({ ok: false, reason: 'notMacOS' })
      const empty = { version: 1 as const, updatedAt: 1, devices: [], leases: [] }
      expect(await store.swap('absent', empty)).toMatchObject({ ok: false, reason: 'notMacOS' })
      expect(existsSync(home.root)).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
