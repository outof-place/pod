import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertPayload, fetchPayload, sha256File } from './fetch-pod-search-payload.mjs'

const require = createRequire(import.meta.url)
const { podSearchMacExtraResources } = require('../pod-search-extra-resources.cjs')
// electron-builder's own copy for extraResources, filter included
const { FileMatcher, copyFiles } = require('app-builder-lib/out/fileMatcher')

const COMMIT = 'a'.repeat(40)
const roots = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function temp() {
  const root = mkdtempSync(join(tmpdir(), 'pod-search-payload-'))
  roots.push(root)
  return root
}

/** The layout scripts/payload.sh writes, with stand-in binaries. */
function payload({ commit = COMMIT } = {}) {
  const dir = join(temp(), 'pod-search')
  for (const sub of ['bin', 'rg-shim', 'ugrep-shim', 'licenses']) {
    mkdirSync(join(dir, sub), { recursive: true })
  }
  for (const name of ['og', 'ogd', 'ogctl', 'rg']) {
    writeFileSync(join(dir, 'bin', name), `#!/bin/sh\n# ${name}\n`)
    chmodSync(join(dir, 'bin', name), 0o755)
  }
  symlinkSync('../bin/og', join(dir, 'rg-shim/rg'))
  symlinkSync('../bin/og', join(dir, 'ugrep-shim/ugrep'))
  writeFileSync(join(dir, 'licenses/ripgrep-LICENSE-MIT'), 'MIT\n')
  writeFileSync(join(dir, 'BUILD.json'), JSON.stringify({ commit, arch: 'arm64' }))
  return dir
}

function tarball(dir) {
  const out = join(temp(), 'pod-search-payload-test-arm64.tar.gz')
  const done = spawnSync('/usr/bin/tar', ['-czf', out, '-C', join(dir, '..'), 'pod-search'])
  expect(done.status).toBe(0)
  return out
}

const pin = (extra = {}) => ({
  repository: 'outof-place/pod',
  tag: 'payload-pod-search-test',
  asset: 'pod-search-payload-test-arm64.tar.gz',
  sha256: null,
  commit: COMMIT,
  ...extra
})

describe('pod-search payload', () => {
  it('installs a payload with its shims still links to og', async () => {
    const into = join(temp(), 'resources/pod-search')
    const { commit } = await fetchPayload({ from: payload(), into, pin: pin() })
    expect(commit).toBe(COMMIT)
    expect(lstatSync(join(into, 'rg-shim/rg')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(into, 'ugrep-shim/ugrep'))).toBe('../bin/og')
  })

  it('refuses a payload without a binary, with a copied shim, or without a commit', () => {
    const noOgd = payload()
    rmSync(join(noOgd, 'bin/ogd'))
    expect(() => assertPayload(noOgd)).toThrow(/bin\/ogd/)

    const copied = payload()
    rmSync(join(copied, 'rg-shim/rg'))
    writeFileSync(join(copied, 'rg-shim/rg'), '')
    expect(() => assertPayload(copied)).toThrow(/rg-shim\/rg/)

    expect(() => assertPayload(payload({ commit: 'main' }))).toThrow(/commit/)
  })

  it('downloads the pinned asset, checks its sha256 and its commit', async () => {
    const tar = tarball(payload())
    const bytes = readFileSync(tar)
    const download = async () => new Response(bytes)
    const into = join(temp(), 'resources/pod-search')
    const good = pin({ sha256: sha256File(tar) })
    const { source } = await fetchPayload({ into, pin: good, download })
    expect(source).toBe(
      'https://github.com/outof-place/pod/releases/download/payload-pod-search-test/pod-search-payload-test-arm64.tar.gz'
    )
    expect((await fetchPayload({ into, pin: good, download })).source).toBe('cached')

    await expect(
      fetchPayload({ into: join(temp(), 'x'), pin: pin({ sha256: 'b'.repeat(64) }), download })
    ).rejects.toThrow(/sha256/)
    await expect(
      fetchPayload({
        into: join(temp(), 'y'),
        pin: pin({ sha256: sha256File(tar), commit: 'c'.repeat(40) }),
        download
      })
    ).rejects.toThrow(/built from/)
  })

  it('refuses to download while the pin has no sha256', async () => {
    await expect(fetchPayload({ into: join(temp(), 'z'), pin: pin() })).rejects.toThrow(
      /no sha256 yet/
    )
  })

  it('ships through the electron-builder copy with the shims as links', async () => {
    const dir = payload()
    const [entry] = podSearchMacExtraResources({ payloadDir: dir })
    expect(entry.to).toBe('pod-search')
    const out = join(temp(), 'Resources', entry.to)
    await copyFiles([new FileMatcher(entry.from, out, (s) => s, entry.filter)], null, false)
    expect(lstatSync(join(out, 'bin/og')).isFile()).toBe(true)
    expect(lstatSync(join(out, 'rg-shim/rg')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(out, 'rg-shim/rg'))).toBe('../bin/og')
  })

  it('makes a release config throw without the payload', () => {
    expect(() => podSearchMacExtraResources({ payloadDir: join(temp(), 'none') })).toThrow(
      /fetch-pod-search-payload/
    )
  })
})
