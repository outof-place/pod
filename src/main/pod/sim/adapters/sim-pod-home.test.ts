import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readSimRegistry } from '../../../../shared/pod-sim/sim-registry'
import { claimSimPodHome, SIM_POD_HOME_MARKER, simDevicesOnDisk, simPodHome } from './sim-pod-home'

const UDID = '0A0A0A0A-0000-4000-8000-00000000000A'

describe('where the pool lives', () => {
  it('is ~/.pod/sim, the one place the registry’s own messages name too', () => {
    const home = simPodHome({}, '/Users/f')
    expect(home).toEqual({
      root: '/Users/f/.pod/sim',
      deviceSet: '/Users/f/.pod/sim/CoreSimulator/Devices',
      registry: '/Users/f/.pod/sim/registry.json',
      lock: '/Users/f/.pod/sim/registry.lock'
    })
    const damaged = readSimRegistry('{')
    expect(!damaged.ok && damaged.message).toContain('~/.pod/sim/registry.json')
  })

  it('expands a leading ~ in POD_SIM_HOME, which launchd leaves as it is', () => {
    expect(simPodHome({ POD_SIM_HOME: '~/probe-sim' }, '/Users/f').root).toBe('/Users/f/probe-sim')
    expect(simPodHome({ POD_SIM_HOME: '~' }, '/Users/f').root).toBe('/Users/f')
  })
})

describe('claiming the pool’s home', () => {
  let dir: string
  let user: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pod-sim-home-'))
    user = join(dir, 'user')
    await mkdir(join(user, 'Library', 'Developer', 'CoreSimulator', 'Devices'), { recursive: true })
    await mkdir(join(user, 'Library', 'Developer', 'XCTestDevices'), { recursive: true })
  })
  afterEach(async () => {
    await chmod(dir, 0o700).catch(() => undefined)
    await rm(dir, { recursive: true, force: true })
  })

  const claim = (root: string, platform: NodeJS.Platform = 'darwin') =>
    claimSimPodHome(simPodHome({ POD_SIM_HOME: root }, user), { platform, userHome: user })

  it('creates and marks a home that is not there yet, and takes it again after', async () => {
    const root = join(dir, 'fresh', 'sim')
    expect(await claim(root)).toEqual({ ok: true })
    expect(await readdir(root)).toEqual([SIM_POD_HOME_MARKER])
    expect(await claim(root)).toEqual({ ok: true })
  })

  it('marks an empty directory, and refuses one holding files Pod did not make', async () => {
    const empty = join(dir, 'empty')
    await mkdir(empty)
    expect(await claim(empty)).toEqual({ ok: true })
    const full = join(dir, 'full')
    await mkdir(full)
    await writeFile(join(full, 'notes.txt'), 'mine')
    const refused = await claim(full)
    expect(refused).toMatchObject({ ok: false, reason: 'registryUnreadable' })
    expect(!refused.ok && refused.message).toContain(full)
    expect(await readdir(full)).toEqual(['notes.txt'])
  })

  it('refuses a home whose device set is the default set or Xcode’s testing set', async () => {
    // POD_SIM_HOME=~/Library/Developer puts the device set on the default set's path.
    const developer = join(user, 'Library', 'Developer')
    expect(await claim(developer)).toMatchObject({ ok: false, reason: 'registryUnreadable' })
    const testing = join(user, 'Library', 'Developer', 'XCTestDevices', 'pod')
    expect(await claim(testing)).toMatchObject({ ok: false, reason: 'registryUnreadable' })
    expect(existsSync(join(testing))).toBe(false)
    // A link to the default set is the default set.
    const linked = join(dir, 'linked')
    await mkdir(linked)
    await symlink(
      join(user, 'Library', 'Developer', 'CoreSimulator'),
      join(linked, 'CoreSimulator')
    )
    expect(await claim(linked)).toMatchObject({ ok: false, reason: 'registryUnreadable' })
  })

  it('refuses off macOS and creates nothing', async () => {
    const root = join(dir, 'linux', 'sim')
    expect(await claim(root, 'linux')).toMatchObject({ ok: false, reason: 'notMacOS' })
    expect(existsSync(join(dir, 'linux'))).toBe(false)
  })
})

describe('the device set on disk', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pod-sim-set-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('counts UDID directories only; a set not made yet is empty', async () => {
    await mkdir(join(root, UDID))
    await mkdir(join(root, 'device_set.plist.d'))
    expect(await simDevicesOnDisk(root)).toEqual(new Set([UDID]))
    expect(await simDevicesOnDisk(join(root, 'missing'))).toEqual(new Set())
  })

  it('answers null, not an empty set, when the set cannot be read', async () => {
    const file = join(root, 'a-file')
    await writeFile(file, '')
    expect(await simDevicesOnDisk(file)).toBeNull()
  })
})
