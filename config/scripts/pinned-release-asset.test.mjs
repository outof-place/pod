import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installPinnedAsset, sha256File, STAMP } from './pinned-release-asset.mjs'

const roots = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

/** A release tarball whose top directory `pkg` holds `marker`. */
function release() {
  const root = mkdtempSync(join(tmpdir(), 'pinned-asset-'))
  roots.push(root)
  mkdirSync(join(root, 'src', 'pkg'), { recursive: true })
  writeFileSync(join(root, 'src', 'pkg', 'marker'), 'v1\n')
  const tarball = join(root, 'pkg.tar.gz')
  spawnSync('/usr/bin/tar', ['-czf', tarball, '-C', join(root, 'src'), 'pkg'])
  const pin = { repository: 'o/r', tag: 't1', asset: 'pkg.tar.gz', sha256: sha256File(tarball) }
  const download = vi.fn(async () => new Response(readFileSync(tarball)))
  return { root, into: join(root, 'resources', 'pkg'), pin, download }
}

function options(r, extra = {}) {
  return {
    pin: r.pin,
    label: 'test asset',
    pinPath: 'config/test.json',
    into: r.into,
    topDir: 'pkg',
    assert: (dir) => {
      if (!existsSync(join(dir, 'marker'))) {
        throw new Error('no marker')
      }
    },
    download: r.download,
    ...extra
  }
}

describe('pinned release asset', () => {
  it('installs the verified tarball once and serves later calls from its stamp', async () => {
    const r = release()
    await expect(installPinnedAsset(options(r))).resolves.toBe(
      'https://github.com/o/r/releases/download/t1/pkg.tar.gz'
    )
    expect(readFileSync(join(r.into, 'marker'), 'utf8')).toBe('v1\n')
    expect(JSON.parse(readFileSync(join(r.into, STAMP), 'utf8'))).toEqual({
      tag: 't1',
      sha256: r.pin.sha256
    })
    await expect(installPinnedAsset(options(r))).resolves.toBe('cached')
    expect(r.download).toHaveBeenCalledTimes(1)
  })

  it('refuses a download that does not match the pin, and installs nothing', async () => {
    const r = release()
    const pin = { ...r.pin, sha256: '0'.repeat(64) }
    await expect(installPinnedAsset(options(r, { pin }))).rejects.toThrow(
      /sha256 [0-9a-f]{64}, pinned 0{64}/
    )
    expect(existsSync(r.into)).toBe(false)
  })

  it('refuses to download at all without a pinned sha256', async () => {
    const r = release()
    await expect(
      installPinnedAsset(options(r, { pin: { ...r.pin, sha256: null } }))
    ).rejects.toThrow('config/test.json has no sha256 yet')
    expect(r.download).not.toHaveBeenCalled()
  })

  it('prepares the unpacked tree before checking and installing it', async () => {
    const r = release()
    const prepare = vi.fn((dir) => {
      writeFileSync(join(dir, 'prepared'), '')
      rmSync(join(dir, 'marker'))
      writeFileSync(join(dir, 'marker'), 'trimmed\n')
    })
    await installPinnedAsset(options(r, { prepare }))
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(existsSync(join(r.into, 'prepared'))).toBe(true)
    expect(readFileSync(join(r.into, 'marker'), 'utf8')).toBe('trimmed\n')
  })
})
