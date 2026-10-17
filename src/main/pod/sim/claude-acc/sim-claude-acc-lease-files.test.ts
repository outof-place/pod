import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClaudeAccLeaseFiles, psLstartOf } from './sim-claude-acc-lease-files'

const UDID = '0A0A0A0A-0000-4000-8000-00000000000A'

describe('claude-acc’s lease file for each Pod device', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pod-sim-leases-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('writes owner pid, start as ps prints it, session and app, as claude-acc reads them', async () => {
    const leases = join(dir, 'portivo-mobile', 'leases')
    await mkdir(join(dir, 'portivo-mobile'))
    const port = createClaudeAccLeaseFiles({ directory: leases, platform: 'darwin' })
    await port.write(UDID, {
      owner: { pid: 41233, startedAt: 1_760_600_000 },
      holder: 'agent:claude:41233:1760600000',
      session: '5f0c1d2e-claude-session',
      app: 'mobile'
    })
    const file = JSON.parse(await readFile(join(leases, `${UDID}.json`), 'utf8'))
    expect(file).toMatchObject({
      owner: { pid: 41233, start: psLstartOf(1_760_600_000), session: '5f0c1d2e-claude-session' },
      app: 'mobile',
      holder: 'agent:claude:41233:1760600000',
      by: 'pod'
    })
    // Nothing half written stays beside it.
    expect(await readdir(leases)).toEqual([`${UDID}.json`])
  })

  it('formats the start like `ps -o lstart=` in local time, which claude-acc parses back', () => {
    const start = psLstartOf(1_760_600_000)
    expect(start).toMatch(/^[A-Z][a-z]{2} [A-Z][a-z]{2} [ 123]\d \d\d:\d\d:\d\d \d{4}$/)
    expect(Date.parse(start)).toBe(1_760_600_000_000)
    // A single-digit day is padded with a space, as ps pads it.
    const early = new Date(2026, 9, 7, 3, 4, 5).getTime() / 1000
    expect(psLstartOf(early)).toBe('Wed Oct  7 03:04:05 2026')
  })

  it('leaves the session out when the holder has none, and names the pool for unheld devices', async () => {
    const port = createClaudeAccLeaseFiles({ directory: dir, platform: 'darwin' })
    await port.write(UDID, { owner: { pid: 70110, startedAt: 1_760_599_900 }, holder: 'pod:pool' })
    const file = JSON.parse(await readFile(join(dir, `${UDID}.json`), 'utf8'))
    expect(file.owner).toEqual({ pid: 70110, start: psLstartOf(1_760_599_900) })
    expect(file.holder).toBe('pod:pool')
    expect(file).not.toHaveProperty('app')
  })

  it('never makes the lease directory’s parent, which tells claude-acc portivo-mobile is here', async () => {
    // devguard_core.py portivo_lock: no ~/.cache/portivo-mobile means no portivo-mobile.
    const port = createClaudeAccLeaseFiles({
      directory: join(dir, 'portivo-mobile', 'leases'),
      platform: 'darwin'
    })
    await port.write(UDID, { owner: { pid: 1, startedAt: 1 }, holder: 'pod:pool' })
    expect(existsSync(join(dir, 'portivo-mobile'))).toBe(false)
  })

  it('clears temp files a write cut short left behind, not one being written now', async () => {
    const stale = join(dir, `${UDID}.json.4242.tmp`)
    const fresh = join(dir, `0B0B0B0B-0000-4000-8000-00000000000B.json.4343.tmp`)
    await writeFile(stale, '{')
    await writeFile(fresh, '{')
    const old = new Date(Date.now() - 10 * 60_000)
    await utimes(stale, old, old)
    const port = createClaudeAccLeaseFiles({ directory: dir, platform: 'darwin' })
    await port.write(UDID, { owner: { pid: 1, startedAt: 1 }, holder: 'pod:pool' })
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
  })

  it('writes nothing off macOS', async () => {
    const port = createClaudeAccLeaseFiles({ directory: dir, platform: 'linux' })
    await port.write(UDID, { owner: { pid: 1, startedAt: 1 }, holder: 'pod:pool' })
    expect(await readdir(dir)).toEqual([])
  })

  it('removes the file, and a missing one or an unwritable directory never throws', async () => {
    const port = createClaudeAccLeaseFiles({ directory: dir, platform: 'darwin' })
    await port.write(UDID, { owner: { pid: 1, startedAt: 1 }, holder: 'pod:pool' })
    await port.remove(UDID)
    await port.remove(UDID)
    expect(await readdir(dir)).toEqual([])
    const blocked = join(dir, 'a-file')
    await writeFile(blocked, '')
    const broken = createClaudeAccLeaseFiles({
      directory: join(blocked, 'leases'),
      platform: 'darwin'
    })
    await expect(
      broken.write(UDID, { owner: { pid: 1, startedAt: 1 }, holder: 'pod:pool' })
    ).resolves.toBeUndefined()
  })
})
