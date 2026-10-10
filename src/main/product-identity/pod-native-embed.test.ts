import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const embed: {
  POD_NATIVE_FILE_EXCLUSIONS: string[]
  POD_NATIVE_SIGN_IGNORE: string[]
  assertPodNativeBundle(app: string, options?: { maxBytes?: number }): void
  embedPodNative(
    contentsDir: string,
    options: { source?: string; release: boolean; env?: Record<string, string> }
  ): string | null
  nestedCode(bundle: string): string[]
  podNativeSignIdentity(release: boolean, env?: Record<string, string>): string
  podNativeSignatureProblems(app: string, options: { teamId: string; notarized: boolean }): string[]
} = require('../../../product/pod-native-embed.cjs')
const productConfig: {
  files: string[]
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

function fakePodNative(dir: string, bundleId = 'codes.pod.native'): string {
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

  it('signs nested bundles and loose Mach-O files before the app, never the main executable', () => {
    const app = fakePodNative(scratch())
    const xpc = join(app, 'Contents/XPCServices/PodIntelligence.xpc')
    mkdirSync(join(xpc, 'Contents/MacOS'), { recursive: true })
    writeFileSync(
      join(xpc, 'Contents/Info.plist'),
      '<plist version="1.0"><dict><key>CFBundleExecutable</key><string>Service</string></dict></plist>\n'
    )
    arm64Binary(join(xpc, 'Contents/MacOS/Service'))
    arm64Binary(join(app, 'Contents/MacOS/helper-tool'))
    expect(embed.nestedCode(app)).toEqual([join(app, 'Contents/MacOS/helper-tool'), xpc])
    expect(embed.nestedCode(xpc)).toEqual([])
  })

  it('embeds an ad-hoc signed copy with empty entitlements in a local build', () => {
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
    expect(embed.embedPodNative(contents, { source, release: false, env: {} })).toBe(target)
    const xattrs = spawnSync('xattr', [join(target, 'Contents/Info.plist')], { encoding: 'utf8' })
    expect(xattrs.stdout).not.toMatch(/quarantine/)
    expect(spawnSync('codesign', ['--verify', '--deep', '--strict', target]).status).toBe(0)
    // Ad hoc: only what a Developer ID release adds is missing; the entitlements already match.
    expect(
      embed.podNativeSignatureProblems(target, { teamId: '75Y2KR6P5W', notarized: false })
    ).toEqual([
      'not signed by team 75Y2KR6P5W',
      'not signed with a Developer ID Application certificate',
      'no hardened runtime',
      'no secure timestamp'
    ])
  })

  it('fails a release without PodNative and lets a local build go on without it', () => {
    const dir = scratch()
    const contents = join(dir, 'Pod.app/Contents')
    const source = join(dir, 'missing/PodNative.app')
    expect(() => embed.embedPodNative(contents, { source, release: true, env: {} })).toThrow(
      /fetch-pod-native\.mjs/
    )
    expect(embed.embedPodNative(contents, { source, release: false, env: {} })).toBeNull()
    expect(existsSync(join(contents, 'Helpers'))).toBe(false)
  })
})

describe('PodNative packaging config', () => {
  it('signs with the Developer ID from CSC_NAME, ad hoc only outside a release', () => {
    const name = 'OUTOFPLACE POLAND SP. Z O.O (75Y2KR6P5W)'
    expect(embed.podNativeSignIdentity(true, { CSC_NAME: name })).toBe(
      `Developer ID Application: ${name}`
    )
    expect(
      embed.podNativeSignIdentity(true, { CSC_NAME: `Developer ID Application: ${name}` })
    ).toBe(`Developer ID Application: ${name}`)
    expect(embed.podNativeSignIdentity(false, {})).toBe('-')
    expect(() => embed.podNativeSignIdentity(true, {})).toThrow(/no CSC_NAME/)
  })

  it('keeps osx-sign off PodNative and its copy out of the asar', () => {
    expect(productConfig.mac.signIgnore).toEqual(
      expect.arrayContaining(embed.POD_NATIVE_SIGN_IGNORE)
    )
    expect(productConfig.files).toEqual(expect.arrayContaining(embed.POD_NATIVE_FILE_EXCLUSIONS))
    const skip = new RegExp(embed.POD_NATIVE_SIGN_IGNORE[0])
    const helpers = '/dist/mac-arm64/Pod.app/Contents/Helpers'
    expect(skip.test(`${helpers}/PodNative.app`)).toBe(true)
    expect(skip.test(`${helpers}/PodNative.app/Contents/MacOS/PodNative`)).toBe(true)
    expect(skip.test(`${helpers}/PodNative.application`)).toBe(false)
    expect(skip.test('/dist/mac-arm64/Pod.app/Contents/Frameworks/Pod Helper.app')).toBe(false)
  })
})
