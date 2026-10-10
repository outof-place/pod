import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const gatePath = join(__dirname, '..', '..', '..', 'product', 'scripts', 'verify-bundle-seal.mjs')
const gate: {
  assertProbesCoverPayload(app: string, probes: unknown[]): void
  bytecodeWrittenAfter(dir: string, since: number): string[]
} = await import('../../../product/scripts/verify-bundle-seal.mjs')

let root: string | null = null

afterEach(() => {
  if (root) {
    rmSync(root, { recursive: true, force: true })
    root = null
  }
})

const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>codes.pod.seal-gate-test</string>
<key>CFBundlePackageType</key><string>BNDL</string>
</dict></plist>
`

/** A minimal Pod.app; `withPayload` adds Resources/claude-acc with one module. */
function fakeApp(withPayload: boolean): string {
  root = mkdtempSync(join(tmpdir(), 'pod-seal-gate-'))
  const app = join(root, 'Pod.app')
  mkdirSync(join(app, 'Contents/Resources'), { recursive: true })
  writeFileSync(join(app, 'Contents/Info.plist'), INFO_PLIST)
  if (withPayload) {
    mkdirSync(join(app, 'Contents/Resources/claude-acc'))
    writeFileSync(join(app, 'Contents/Resources/claude-acc/orcahost.py'), '')
  }
  return app
}

describe('bundle seal gate', () => {
  it('lists bytecode written after the probes started, not bytecode the bundle shipped', () => {
    root = mkdtempSync(join(tmpdir(), 'pod-seal-gate-'))
    const resources = join(root, 'Pod.app/Contents/Resources')
    mkdirSync(join(resources, 'claude-acc/__pycache__'), { recursive: true })
    mkdirSync(join(resources, 'python/lib'), { recursive: true })
    writeFileSync(join(resources, 'python/lib/shipped.pyc'), '')
    writeFileSync(join(resources, 'claude-acc/orcahost.py'), '')
    const since = Date.now() - 60_000
    const old = new Date(since - 60_000)
    utimesSync(join(resources, 'python/lib/shipped.pyc'), old, old)
    expect(gate.bytecodeWrittenAfter(root, since)).toEqual([
      join(resources, 'claude-acc/__pycache__')
    ])
  })

  it('refuses an app that ships claude-acc when no probe ran', () => {
    const withPayload = fakeApp(true)
    expect(() => gate.assertProbesCoverPayload(withPayload, [])).toThrow(/no probe ran/)
    expect(() => gate.assertProbesCoverPayload(withPayload, [{ name: 'root' }])).not.toThrow()
    rmSync(join(withPayload, 'Contents/Resources/claude-acc'), { recursive: true })
    expect(() => gate.assertProbesCoverPayload(withPayload, [])).not.toThrow()
  })

  it.skipIf(process.platform !== 'darwin')(
    'fails from the command line instead of passing a claude-acc app with no probes',
    () => {
      const app = fakeApp(true)
      // Why signed: an unsigned copy fails on codesign whether or not the probe check runs.
      const sign = spawnSync('/usr/bin/codesign', ['--sign', '-', '--force', app], {
        encoding: 'utf8'
      })
      expect(sign.status, sign.stderr).toBe(0)
      // Why a symlink too: the entry check once compared argv to the realpath and skipped main().
      const link = join(dirname(app), 'verify-bundle-seal.mjs')
      symlinkSync(gatePath, link)
      for (const script of [gatePath, link]) {
        const run = spawnSync(process.execPath, [script, app], { encoding: 'utf8' })
        expect(run.status, script).toBe(1)
        expect(run.stderr).toMatch(/^bundle seal: /)
        expect(run.stdout).not.toMatch(/intact/)
      }
    }
  )
})
