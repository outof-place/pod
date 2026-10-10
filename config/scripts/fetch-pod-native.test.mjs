import { execFileSync, spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fetchPodNative, sha256File } from './fetch-pod-native.mjs'

const roots = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function temp() {
  const root = mkdtempSync(join(tmpdir(), 'pod-native-fetch-'))
  roots.push(root)
  return root
}

function app(dir, revision = 'r37') {
  const bundle = join(dir, 'PodNative.app')
  mkdirSync(join(bundle, 'Contents/MacOS'), { recursive: true })
  writeFileSync(
    join(bundle, 'Contents/Info.plist'),
    `<plist version="1.0"><dict><key>PodNativeRevision</key><string>${revision}</string></dict></plist>\n`
  )
  writeFileSync(join(bundle, 'Contents/MacOS/PodNative'), 'binary')
  return bundle
}

function zipOf(bundle, zip) {
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', bundle, zip])
  return zip
}

const pin = (zip, sha256 = sha256File(zip)) => ({
  repository: 'outof-place/pod-native',
  tag: 'v0.1.0',
  asset: 'PodNative-0.1.0-arm64.zip',
  sha256,
  revision: 'r37'
})

describe.skipIf(process.platform !== 'darwin')('fetch-pod-native', () => {
  it('installs a local app without its quarantine flag', () => {
    const root = temp()
    const source = app(join(root, 'build'))
    execFileSync('xattr', [
      '-w',
      'com.apple.quarantine',
      '0081;0;test;',
      join(source, 'Contents/MacOS/PodNative')
    ])
    const into = join(root, 'resources/pod-native')
    const { app: installed } = fetchPodNative({ from: source, into, pin: { sha256: null } })
    expect(readFileSync(join(installed, 'Contents/MacOS/PodNative'), 'utf8')).toBe('binary')
    const xattrs = spawnSync('xattr', [join(installed, 'Contents/MacOS/PodNative')], {
      encoding: 'utf8'
    })
    expect(xattrs.stdout).not.toMatch(/quarantine/)
    expect(JSON.parse(readFileSync(join(into, '.source.json'), 'utf8'))).toEqual({ from: source })
    expect(existsSync(`${into}.next`)).toBe(false)
  })

  it('downloads the pinned zip once, and refuses one whose sha256 differs', () => {
    const root = temp()
    const zip = zipOf(app(join(root, 'build')), join(root, 'PodNative-0.1.0-arm64.zip'))
    const into = join(root, 'resources/pod-native')
    let downloads = 0
    const download = (asset, dir) => {
      downloads++
      copyFileSync(zip, join(dir, asset.asset))
      return join(dir, asset.asset)
    }
    expect(() => fetchPodNative({ into, pin: pin(zip, 'f'.repeat(64)), download })).toThrow(
      /sha256 [0-9a-f]{64}, pinned f{64}/
    )
    expect(existsSync(into)).toBe(false)
    expect(fetchPodNative({ into, pin: pin(zip), download }).source).toBe(
      'outof-place/pod-native v0.1.0'
    )
    expect(fetchPodNative({ into, pin: pin(zip), download }).source).toBe('cached')
    expect(downloads).toBe(2)
    expect(readFileSync(join(into, 'PodNative.app/Contents/MacOS/PodNative'), 'utf8')).toBe(
      'binary'
    )
  })

  it('refuses to download before a PodNative release is pinned', () => {
    const into = join(temp(), 'resources/pod-native')
    const unpinned = { repository: 'outof-place/pod-native', tag: null, asset: null, sha256: null }
    expect(() => fetchPodNative({ into, pin: unpinned, download: () => '' })).toThrow(/no tag yet/)
    expect(() =>
      fetchPodNative({
        into,
        pin: { ...unpinned, tag: 'v0.1.0', asset: 'a.zip', revision: 'r37' },
        download: () => ''
      })
    ).toThrow(/no sha256 yet/)
  })

  it('refuses a pinned zip built from another revision', () => {
    const root = temp()
    const zip = zipOf(app(join(root, 'build'), 'r36'), join(root, 'PodNative-0.1.0-arm64.zip'))
    const into = join(root, 'cache/abc')
    const download = (asset, dir) => {
      copyFileSync(zip, join(dir, asset.asset))
      return join(dir, asset.asset)
    }
    expect(() => fetchPodNative({ into, pin: pin(zip), download })).toThrow(
      /revision r36, the pin says r37/
    )
    expect(existsSync(into)).toBe(false)
  })

  it('checks a local copy of the pinned asset against the pin', () => {
    const root = temp()
    const zip = zipOf(app(join(root, 'build')), join(root, 'PodNative-0.1.0-arm64.zip'))
    const into = join(root, 'resources/pod-native')
    expect(() => fetchPodNative({ from: zip, into, pin: pin(zip, '0'.repeat(64)) })).toThrow(
      /does not match the pinned sha256/
    )
    expect(fetchPodNative({ from: zip, into, pin: pin(zip) }).app).toBe(join(into, 'PodNative.app'))
  })
})
