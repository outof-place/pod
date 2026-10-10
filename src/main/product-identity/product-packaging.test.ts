import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const repoRoot = join(__dirname, '..', '..', '..')
const productConfig: unknown = require('../../../product/electron-builder.pod.cjs')
const identity: unknown = require('../../../product/identity.json')
const verifyScript = join(repoRoot, 'product', 'scripts', 'verify-claude-acc-host.mjs')
const orcahost =
  process.env.CLAUDE_ACC_ORCAHOST ??
  [join(repoRoot, 'resources', 'claude-acc', 'orcahost.py')].find((path) => existsSync(path))

function verify(app: string, ...args: string[]): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [verifyScript, app, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: '/Users/test' }
  })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

function extendInfo(): Record<string, unknown> {
  const mac: unknown = Reflect.get(Object(productConfig), 'mac')
  return { ...Object(Reflect.get(Object(mac), 'extendInfo')) }
}

let root: string | null = null

/** A bundle with only what claude-acc reads: Info.plist and Resources/bin. */
function fakeApp(info: Record<string, unknown>): string {
  root = mkdtempSync(join(tmpdir(), 'pod-packaging-'))
  const app = join(root, 'Pod.app')
  mkdirSync(join(app, 'Contents', 'Resources', 'bin'), { recursive: true })
  const plistJson = join(root, 'Info.json')
  writeFileSync(plistJson, JSON.stringify(info))
  execFileSync('plutil', ['-convert', 'xml1', '-o', join(app, 'Contents', 'Info.plist'), plistJson])
  for (const cli of ['orca', 'podx']) {
    writeFileSync(join(app, 'Contents', 'Resources', 'bin', cli), '#!/bin/sh\n')
    chmodSync(join(app, 'Contents', 'Resources', 'bin', cli), 0o755)
  }
  return app
}

afterEach(() => {
  if (root) {
    rmSync(root, { recursive: true, force: true })
    root = null
  }
})

describe('product packaging', () => {
  it('declares the product names claude-acc cannot read from the bundle', () => {
    expect(extendInfo().ClaudeAccHost).toEqual({
      userData: `~/Library/Application Support/${String(Reflect.get(Object(identity), 'userDataName'))}`,
      cli: Reflect.get(Object(identity), 'cliName'),
      hooksDir: `~/${String(Reflect.get(Object(identity), 'homeDirName'))}/agent-hooks`,
      envPrefix: Reflect.get(Object(identity), 'envPrefix')
    })
  })

  it("keeps upstream's Info.plist keys, with the product name in permission prompts", () => {
    const info = extendInfo()
    expect(info.NSBonjourServices).toEqual(['_http._tcp', '_https._tcp'])
    expect(String(info.NSAppleEventsUsageDescription)).toMatch(/^Pod allows /)
  })

  it.skipIf(process.platform !== 'darwin')('fails an app without the declaration', () => {
    const app = fakeApp({ CFBundleName: 'Pod', CFBundleIdentifier: 'codes.pod.app' })
    const { status, output } = verify(app)
    expect(status).toBe(1)
    expect(output).toMatch(/ClaudeAccHost\.userData/)
  })

  it.skipIf(process.platform !== 'darwin' || !orcahost)(
    "resolves as the product host in claude-acc's orcahost.py",
    () => {
      const app = fakeApp({
        CFBundleName: 'Pod',
        CFBundleExecutable: 'Pod',
        CFBundleIdentifier: 'codes.pod.app',
        ClaudeAccHost: extendInfo().ClaudeAccHost
      })
      const { status, output } = verify(app, String(orcahost))
      expect(output).toContain('/Users/test/Library/Application Support/Pod, cli podx')
      expect(status).toBe(0)
    }
  )
})
