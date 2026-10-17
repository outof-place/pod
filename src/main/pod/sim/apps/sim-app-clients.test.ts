import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { simRunProcess } from '../adapters/sim-command-run'
import { createSimClientCache } from './sim-app-clients'
import { simAppHome } from './sim-app-paths'
import { BUNDLE, sandbox, type Sandbox } from './sim-app.test-support'

let box: Sandbox

beforeEach(async () => {
  box = await sandbox()
})

afterEach(async () => {
  await box.cleanup()
})

async function appAt(path: string, bundleId: string, bytes: number): Promise<string> {
  await mkdir(path, { recursive: true })
  await writeFile(
    join(path, 'Info.plist'),
    `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${bundleId}</string></dict></plist>`
  )
  await writeFile(join(path, 'binary'), Buffer.alloc(bytes))
  return path
}

describe.skipIf(process.platform !== 'darwin')('the Mac-wide dev-client cache', () => {
  it('lands a client once, keeps the first of two landings and refuses another app’s bundle', async () => {
    const home = simAppHome(box.home)
    const cache = createSimClientCache({ home, run: simRunProcess, userHome: box.dir })
    const built = await appAt(join(box.dir, 'out', 'Pod.app'), BUNDLE, 10)
    const [one, two] = await Promise.all([
      cache.land(built, BUNDLE, 'f00d', 'build:sb_a'),
      cache.land(built, BUNDLE, 'f00d', 'build:sb_b')
    ])
    expect(one).toMatchObject({ ok: true })
    expect(two).toMatchObject({ ok: true, path: one.ok ? one.path : '' })
    expect(await cache.find(BUNDLE, 'f00d')).toBe(join(home.clients, BUNDLE, 'f00d.app'))
    // No temp copies left beside it.
    expect((await readdir(join(home.clients, BUNDLE))).sort()).toEqual(['f00d.app', 'f00d.json'])
    const other = await appAt(join(box.dir, 'out', 'Other.app'), 'com.example.other', 10)
    expect(await cache.land(other, BUNDLE, 'beef', 'build:sb_c')).toMatchObject({ ok: false })
    expect(await cache.find(BUNDLE, 'beef')).toBeNull()
  })

  it('never names a path outside the cache from a fingerprint or bundle id', async () => {
    const cache = createSimClientCache({
      home: simAppHome(box.home),
      run: simRunProcess,
      userHome: box.dir
    })
    expect(await cache.find('../../etc', 'f00d')).toBeNull()
    expect(await cache.find(BUNDLE, '..')).toBeNull()
    expect(await cache.adoptExternal(box.external, BUNDLE, '../x')).toBeNull()
  })

  it('evicts least recently used clients past its budget, never a recent, protected or newest one', async () => {
    const home = simAppHome(box.home)
    let now = Date.UTC(2026, 9, 17)
    const cache = createSimClientCache({
      home,
      run: simRunProcess,
      userHome: box.dir,
      budgetBytes: 2_500,
      now: () => now
    })
    const day = 24 * 60 * 60_000
    const land = async (fingerprint: string, bundleId = BUNDLE) => {
      const built = await appAt(join(box.dir, 'out', `${fingerprint}.app`), bundleId, 1_000)
      const landed = await cache.land(built, bundleId, fingerprint, 'build:x')
      return landed.ok ? landed.path : ''
    }
    const oldest = await land('aaa1')
    now += day
    const protectedOne = await land('bbb2')
    now += day
    const older = await land('ccc3')
    now += day
    const recent = await land('ddd4')
    now += day / 2
    const gone = await cache.evict(new Set([protectedOne]))
    // About 4 KB in a 2.5 KB budget: the oldest unprotected go, until it fits or none may go.
    expect(gone).toEqual([oldest, older])
    expect(existsSync(protectedOne)).toBe(true)
    expect(existsSync(recent)).toBe(true)
    expect(JSON.parse(await readFile(recent.replace(/\.app$/, '.json'), 'utf8'))).toMatchObject({
      bundleId: BUNDLE,
      fingerprint: 'ddd4'
    })
  })
})
