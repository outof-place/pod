import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const embed: {
  podNativeCacheDir(key: string, home?: string): string
  podNativeSource(env: Record<string, string>, pin: { sha256?: string }): string
  assertPodNativeBundle(app: string, options?: { maxBytes?: number }): void
  embedPodNative(
    contentsDir: string,
    options: {
      source?: string
      release: boolean
      env?: Record<string, string>
      pin?: { revision?: string | null }
    }
  ): string | null
  podNativeSignatureProblems(
    app: string,
    options: { teamId: string; notarized: boolean; revision?: string | null }
  ): string[]
} = require('../../../product/pod-native-embed.cjs')
const productConfig: {
  mac: { signIgnore: string[] }
} = require('../../../product/electron-builder.pod.cjs')

const onMac = process.platform === 'darwin'
let root: string | null = null

afterEach(() => {
  if (root) {
    rmSync(root, { recursive: true, force: true })
    root = null
  }
})

function scratch(): string {
  root = mkdtempSync(join(tmpdir(), 'pod-native-embed-'))
  return root
}

/** An arm64-only Mach-O, like a SwiftPM release build of PodNative. */
function arm64Binary(path: string): void {
  execFileSync('xcrun', ['clang', '-arch', 'arm64', '-x', 'c', '-', '-o', path], {
    input: 'int main(void) { return 0; }\n'
  })
}

function fakePodNative(dir: string, bundleId = 'codes.pod.native', revision = 'r37'): string {
  const app = join(dir, 'PodNative.app')
  mkdirSync(join(app, 'Contents/MacOS'), { recursive: true })
  mkdirSync(join(app, 'Contents/Resources/GhosttyKit_GhosttyTerminal.bundle'), { recursive: true })
  writeFileSync(
    join(app, 'Contents/Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${bundleId}</string>
<key>CFBundleExecutable</key><string>PodNative</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>PodNativeRevision</key><string>${revision}</string>
</dict></plist>
`
  )
  arm64Binary(join(app, 'Contents/MacOS/PodNative'))
  return app
}

describe.skipIf(!onMac)('PodNative embedding', () => {
  it('accepts the pinned arm64 app and names what a dist bundle must not carry', () => {
    const app = fakePodNative(scratch())
    expect(() => embed.assertPodNativeBundle(app)).not.toThrow()
    mkdirSync(join(app, 'Contents/Resources/.build'))
    writeFileSync(join(app, 'Contents/Resources/.unsigned-app.sha256'), '')
    execFileSync('lipo', [
      '-thin',
      'arm64e',
      '/usr/bin/true',
      '-output',
      join(app, 'Contents/MacOS/tool')
    ])
    expect(() => embed.assertPodNativeBundle(app)).toThrow(
      /MacOS\/tool: arm64e, not arm64 only\n {2}.*\.build: build leftover\n {2}.*\.unsigned-app\.sha256: build leftover/
    )
  })

  it('refuses another bundle id and an oversized app', () => {
    expect(() =>
      embed.assertPodNativeBundle(fakePodNative(scratch(), 'codes.pod.native.dev'))
    ).toThrow(/is codes\.pod\.native\.dev, not codes\.pod\.native/)
    const app = fakePodNative(join(root ?? '', 'big'))
    writeFileSync(join(app, 'Contents/Resources/Assets.car'), '')
    truncateSync(join(app, 'Contents/Resources/Assets.car'), 3 * 1024 * 1024)
    expect(() => embed.assertPodNativeBundle(app, { maxBytes: 2 * 1024 * 1024 })).toThrow(
      /3 MB, over 2 MB/
    )
  })

  it('copies the app in without its quarantine flag and checks what signed it', () => {
    const dir = scratch()
    const source = fakePodNative(join(dir, 'fetched'))
    const contents = join(dir, 'Pod.app/Contents')
    mkdirSync(contents, { recursive: true })
    execFileSync('xattr', [
      '-w',
      'com.apple.quarantine',
      '0081;0;test;',
      join(source, 'Contents/Info.plist')
    ])
    const target = join(contents, 'Helpers/PodNative.app')
    expect(
      embed.embedPodNative(contents, { source, release: false, env: {}, pin: { revision: 'r37' } })
    ).toBe(target)
    const xattrs = spawnSync('xattr', [join(target, 'Contents/Info.plist')], { encoding: 'utf8' })
    expect(xattrs.stdout).not.toMatch(/quarantine/)
    const jit = join(dir, 'jit.plist')
    writeFileSync(
      jit,
      '<plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>\n'
    )
    execFileSync('codesign', ['--force', '--sign', '-', '--entitlements', jit, target])
    // Ad hoc and with an entitlement: everything a Developer ID release adds is missing.
    expect(
      embed.podNativeSignatureProblems(target, {
        teamId: '75Y2KR6P5W',
        notarized: false,
        revision: 'r38'
      })
    ).toEqual([
      'revision r37, the pin says r38',
      'not signed by team 75Y2KR6P5W',
      'not signed with a Developer ID Application certificate',
      'no hardened runtime',
      'no secure timestamp',
      'entitlements com.apple.security.cs.allow-jit, expected none'
    ])
  })
  it('ships only the pinned revision in a release', () => {
    const dir = scratch()
    const source = fakePodNative(join(dir, 'fetched'), 'codes.pod.native', 'r36')
    const contents = join(dir, 'Pod.app/Contents')
    mkdirSync(contents, { recursive: true })
    expect(() =>
      embed.embedPodNative(contents, { source, release: true, env: {}, pin: { revision: 'r37' } })
    ).toThrow(/revision r36, the pin says r37/)
    expect(existsSync(join(contents, 'Helpers'))).toBe(false)
  })

  it('fails a release without PodNative and lets a local build go on without it', () => {
    const dir = scratch()
    const contents = join(dir, 'Pod.app/Contents')
    const source = join(dir, 'missing/PodNative.app')
    expect(() =>
      embed.embedPodNative(contents, { source, release: true, env: {}, pin: { revision: 'r37' } })
    ).toThrow(/fetch-pod-native\.mjs/)
    expect(
      embed.embedPodNative(contents, { source, release: false, env: {}, pin: { revision: 'r37' } })
    ).toBeNull()
    expect(existsSync(join(contents, 'Helpers'))).toBe(false)
  })
})

describe('PodNative packaging config', () => {
  it('leaves PodNative to electron-builder signing and its fetched copy outside the worktree', () => {
    // Why: osx-sign signs it with product/entitlements-policy.cjs's rule (none), never skipped.
    const nested = '/dist/mac-arm64/Pod.app/Contents/Helpers/PodNative.app/Contents/MacOS/PodNative'
    expect(
      productConfig.mac.signIgnore.filter((pattern) => new RegExp(pattern).test(nested))
    ).toEqual([])
    expect(embed.podNativeCacheDir('abc', '/Users/u')).toBe(
      '/Users/u/Library/Caches/codes.pod.release/pod-native/abc'
    )
    expect(
      embed.podNativeSource({ POD_NATIVE_APP_SOURCE: '/b/PodNative.app' }, { sha256: 'abc' })
    ).toBe('/b/PodNative.app')
    expect(embed.podNativeSource({}, { sha256: 'abc' })).toMatch(
      /\/pod-native\/abc\/PodNative\.app$/
    )
  })
})
