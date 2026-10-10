import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import podNative from '../pod-native-extra-files.cjs'
import { assertPodNativeApp } from './fetch-pod-native.mjs'

const {
  readPodNativePin,
  pinnedPodNativeApp,
  podNativeAppSource,
  podNativeMacExtraFiles,
  podNativeMacSignIgnore
} = podNative

const PIN = {
  repository: 'outof-place/pod-native',
  tag: 'build-36',
  asset: 'PodNative-0.0.1-36.zip',
  sha256: 'a'.repeat(64),
  revision: 'b'.repeat(40),
  teamId: 'TEAM123456'
}

const dirs = []
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'pod-native-test-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('PodNative pin', () => {
  it('reads a complete pin and refuses short digests', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'pin.json'), JSON.stringify(PIN))
    expect(readPodNativePin(join(dir, 'pin.json'))).toEqual(PIN)
    writeFileSync(join(dir, 'short.json'), JSON.stringify({ ...PIN, revision: 'bbbbbbb' }))
    expect(() => readPodNativePin(join(dir, 'short.json'))).toThrow(/full hex digests/)
  })

  it('reads the checked-in pin', () => {
    expect(readPodNativePin().repository).toBe('outof-place/pod-native')
  })

  it('unpacks per asset digest outside the worktree', () => {
    expect(pinnedPodNativeApp(PIN, '/caches')).toBe(
      `/caches/codes.pod.release/pod-native/${PIN.sha256}/PodNative.app`
    )
    expect(
      podNativeAppSource({ env: { POD_NATIVE_APP_SOURCE: '/b/PodNative.app' }, pin: PIN })
    ).toBe('/b/PodNative.app')
  })
})

describe('extraFiles and signIgnore', () => {
  it('nests the app in Contents/Helpers and throws without it', () => {
    const source = join(tempDir(), 'PodNative.app')
    expect(() => podNativeMacExtraFiles({ source })).toThrow(/PodNative.app missing/)
    mkdirSync(join(source, 'Contents'), { recursive: true })
    writeFileSync(join(source, 'Contents', 'Info.plist'), '')
    expect(podNativeMacExtraFiles({ source })).toEqual([
      { from: source, to: 'Helpers/PodNative.app' }
    ])
  })

  it('keeps osx-sign off the nested app and everything in it, nothing else', () => {
    const ignored = (path) => podNativeMacSignIgnore.some((it) => new RegExp(it).test(path))
    const helpers = '/dist/Pod.app/Contents/Helpers'
    expect(ignored(`${helpers}/PodNative.app`)).toBe(true)
    expect(ignored(`${helpers}/PodNative.app/Contents/MacOS/PodNative`)).toBe(true)
    expect(ignored(`${helpers}/PodNative.appx`)).toBe(false)
    expect(ignored('/dist/Pod.app/Contents/Frameworks/Pod Helper.app')).toBe(false)
  })
})

describe('assertPodNativeApp', () => {
  const signed = [
    'Authority=Developer ID Application: Example (TEAM123456)',
    'CodeDirectory v=20500 size=1 flags=0x10000(runtime) hashes=1+3 location=embedded',
    'Timestamp=10 Oct 2026 at 21:23:05',
    'TeamIdentifier=TEAM123456'
  ].join('\n')
  const plist = (values) => (_app, key) => values[key] ?? null
  const good = { CFBundleIdentifier: 'codes.pod.native', PodNativeRevision: PIN.revision }
  const exec =
    (details = signed, entitlements = '') =>
    (_program, args) =>
      args[0] === '--verify'
        ? { status: 0, out: '' }
        : { status: 0, out: args.includes('--entitlements') ? entitlements : details }

  it('accepts the pinned, Developer ID signed, hardened app', () => {
    expect(assertPodNativeApp('/x/PodNative.app', PIN, exec(), plist(good))).toBe(
      '/x/PodNative.app'
    )
  })

  it('refuses another revision or bundle id', () => {
    expect(() =>
      assertPodNativeApp('/x', PIN, exec(), plist({ ...good, PodNativeRevision: 'c'.repeat(40) }))
    ).toThrow(/the pin says/)
    expect(() =>
      assertPodNativeApp('/x', PIN, exec(), plist({ ...good, CFBundleIdentifier: 'x' }))
    ).toThrow(/is not codes.pod.native/)
  })

  it('refuses a development signature, no timestamp, or get-task-allow', () => {
    const dev = signed.replace('Developer ID Application', 'Apple Development')
    expect(() => assertPodNativeApp('/x', PIN, exec(dev), plist(good))).toThrow(/Developer ID/)
    const untimed = signed.replace('Timestamp=', 'Signed Time=')
    expect(() => assertPodNativeApp('/x', PIN, exec(untimed), plist(good))).toThrow(/Timestamp/)
    const debuggable = '<key>com.apple.security.get-task-allow</key><true/>'
    expect(() => assertPodNativeApp('/x', PIN, exec(signed, debuggable), plist(good))).toThrow(
      /get-task-allow/
    )
  })

  it('refuses a broken seal', () => {
    const broken = () => ({ status: 1, out: 'a sealed resource is missing or invalid' })
    expect(() => assertPodNativeApp('/x', PIN, broken, plist(good))).toThrow(/sealed resource/)
  })
})
