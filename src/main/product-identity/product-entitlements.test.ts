import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
type Rule = { name: string; entitlements: string }
type SignOptions = { entitlements?: string; hardenedRuntime?: boolean }
const policy: {
  entitlementRule(relativePath: string, mainExecutable: string): Rule
  productOptionsForFile(
    appPath: string,
    optionsForFile: (filePath: string) => SignOptions,
    mainExecutable: string
  ): (filePath: string) => SignOptions
  signWithProductEntitlements: unknown
} = require('../../../product/entitlements-policy.cjs')
const productConfig: {
  mac: { sign: unknown }
} = require('../../../product/electron-builder.pod.cjs')
const gate: {
  entitlementViolations(
    app: string,
    options?: { read?: (path: string) => Record<string, unknown> }
  ): { checked: number; violations: string[] }
} = await import('../../../product/scripts/verify-entitlements.mjs')

let root: string | null = null

afterEach(() => {
  if (root) {
    rmSync(root, { recursive: true, force: true })
    root = null
  }
})

const ruleOf = (path: string): string => {
  const rule = policy.entitlementRule(path, 'Pod')
  return rule.entitlements === 'electron' ? 'electron' : basename(rule.entitlements, '.plist')
}

describe('product entitlements', () => {
  it('keeps Electron set only for the app and its helpers and narrows everything else', () => {
    expect(ruleOf('')).toBe('electron')
    expect(ruleOf('Contents/MacOS/Pod')).toBe('electron')
    expect(ruleOf('Contents/Frameworks/Pod Helper.app')).toBe('electron')
    expect(
      ruleOf('Contents/Frameworks/Pod Helper (Renderer).app/Contents/MacOS/Pod Helper (Renderer)')
    ).toBe('electron')
    expect(ruleOf('Contents/Resources/claude-acc/Pod Menu.app/Contents/MacOS/ClaudeAcc')).toBe(
      'microphone'
    )
    expect(ruleOf('Contents/Library/LoginItems/Pod Menu.app')).toBe('microphone')
    expect(
      ruleOf('Contents/Resources/node_modules/serve-sim/dist/simcam/serve-sim-camera-helper')
    ).toBe('camera')
    expect(ruleOf('Contents/Resources/python/bin/python3.14')).toBe('python-jit')
    expect(ruleOf('Contents/Resources/bin/pod-agent-launcher')).toBe('exec-shim')
    expect(
      ruleOf('Contents/Resources/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper')
    ).toBe('exec-shim')
    for (const path of [
      'Contents/MacOS/pod-notification-status',
      'Contents/Resources/Pod Computer Use.app/Contents/MacOS/pod-computer-use-macos',
      'Contents/Resources/ripgrep/darwin-arm64/rg',
      'Contents/Resources/claude-acc/fanctl',
      'Contents/Frameworks/Squirrel.framework/Versions/A/Resources/ShipIt',
      'Contents/Helpers/PodNative.app'
    ]) {
      expect(ruleOf(path), path).toBe('none')
    }
  })

  it('swaps only the entitlements in the options electron-builder hands osx-sign', () => {
    const app = '/out/mac-arm64/Pod.app'
    const options = policy.productOptionsForFile(
      app,
      () => ({ entitlements: '/resources/build/entitlements.mac.plist', hardenedRuntime: true }),
      'Pod'
    )
    expect(options(app)).toEqual({
      entitlements: '/resources/build/entitlements.mac.plist',
      hardenedRuntime: true
    })
    const rg = options(`${app}/Contents/Resources/ripgrep/darwin-arm64/rg`)
    expect(rg.hardenedRuntime).toBe(true)
    expect(basename(rg.entitlements ?? '')).toBe('none.plist')
    expect(productConfig.mac.sign).toBe(policy.signWithProductEntitlements)
  })
})

/** Tiny arm64 executables at each path, inside a minimal app. */
function fakeApp(paths: string[]): string {
  root = mkdtempSync(join(tmpdir(), 'pod-entitlements-'))
  const app = join(root, 'Pod.app')
  mkdirSync(join(app, 'Contents/MacOS'), { recursive: true })
  writeFileSync(
    join(app, 'Contents/Info.plist'),
    '<plist version="1.0"><dict><key>CFBundleExecutable</key><string>Pod</string></dict></plist>\n'
  )
  const binary = join(root, 'tool')
  execFileSync('xcrun', ['clang', '-arch', 'arm64', '-x', 'c', '-', '-o', binary], {
    input: 'int main(void) { return 0; }\n'
  })
  for (const path of paths) {
    mkdirSync(dirname(join(app, path)), { recursive: true })
    execFileSync('cp', [binary, join(app, path)])
  }
  return app
}

describe.skipIf(process.platform !== 'darwin')('entitlements release gate', () => {
  it('names each executable whose entitlements step outside its rule', () => {
    const app = fakeApp([
      'Contents/MacOS/Pod',
      'Contents/MacOS/pod-notification-status',
      'Contents/Resources/claude-acc/Pod Menu.app/Contents/MacOS/ClaudeAcc'
    ])
    const granted: Record<string, Record<string, unknown>> = {
      'Pod.app': { 'com.apple.security.cs.allow-jit': true },
      'pod-notification-status': { 'com.apple.security.device.camera': true },
      'Pod Menu.app': { 'com.apple.security.device.audio-input': true },
      ClaudeAcc: {
        'com.apple.security.device.audio-input': true,
        'com.apple.security.cs.allow-jit': true
      }
    }
    const result = gate.entitlementViolations(app, {
      read: (path) => granted[basename(path)] ?? {}
    })
    expect(result.checked).toBe(5)
    expect(result.violations).toEqual([
      'Contents/MacOS/pod-notification-status (everything else): device.camera',
      'Contents/Resources/claude-acc/Pod Menu.app/Contents/MacOS/ClaudeAcc (Pod Menu): cs.allow-jit'
    ])
  })

  it('reads what codesign embedded', () => {
    const app = fakeApp(['Contents/MacOS/Pod', 'Contents/Resources/ripgrep/darwin-arm64/rg'])
    const entitlements = join(root ?? '', 'jit.plist')
    writeFileSync(
      entitlements,
      '<plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>\n'
    )
    const rg = join(app, 'Contents/Resources/ripgrep/darwin-arm64/rg')
    execFileSync('codesign', ['--force', '--sign', '-', '--entitlements', entitlements, rg])
    expect(gate.entitlementViolations(app).violations).toEqual([
      'Contents/Resources/ripgrep/darwin-arm64/rg (everything else): cs.allow-jit'
    ])
  })
})
