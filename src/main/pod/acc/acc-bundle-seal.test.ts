import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { accSetupSpec } from './acc-lifecycle'

// The payload's Python runs from Pod.app/Contents/Resources/claude-acc. A __pycache__ it writes
// there is a file added to the app's sealed resources: `codesign --verify` fails and Gatekeeper
// calls Pod.app damaged (test1, 2026-10-10: __pycache__/orcahost.cpython-314.pyc).

/** A Python that never asks to install the command line tools (/usr/bin/python3 can). */
function findPython(): string | null {
  const candidates = [
    process.env.POD_TEST_PYTHON,
    '/opt/homebrew/bin/python3',
    '/usr/local/bin/python3',
    join(homedir(), '.local/bin/python3')
  ]
  if (spawnSync('/usr/bin/xcode-select', ['-p']).status === 0) {
    candidates.push('/usr/bin/python3')
  }
  return candidates.find((path): path is string => !!path && existsSync(path)) ?? null
}

const python = process.platform === 'darwin' ? findPython() : null

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

/** An ad-hoc signed app whose Resources/claude-acc has a script that imports a sibling module. */
function signedBundle(): { app: string; payload: string } {
  const root = mkdtempSync(join(tmpdir(), 'pod-acc-seal-'))
  roots.push(root)
  const app = join(root, 'Seal.app')
  const payload = join(app, 'Contents/Resources/claude-acc')
  mkdirSync(join(app, 'Contents/MacOS'), { recursive: true })
  mkdirSync(payload, { recursive: true })
  writeFileSync(
    join(app, 'Contents/Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Seal</string>
<key>CFBundleIdentifier</key><string>codes.pod.test.seal</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`
  )
  copyFileSync('/usr/bin/true', join(app, 'Contents/MacOS/Seal'))
  // like perf.py and orcahost.py: the import is what Python caches, not the script it runs
  writeFileSync(join(payload, 'orcahost.py'), 'HOST = "Pod"\n')
  writeFileSync(
    join(payload, 'perf.py'),
    'import os, sys\nsys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))\nimport orcahost\n'
  )
  const signed = spawnSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app], {
    encoding: 'utf8'
  })
  expect(signed.status, signed.stderr).toBe(0)
  return { app, payload }
}

function verify(app: string): { ok: boolean; output: string } {
  const done = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], {
    encoding: 'utf8'
  })
  return { ok: done.status === 0, output: `${done.stdout}${done.stderr}` }
}

describe.skipIf(!python)('the payload runs without breaking the seal', () => {
  it('breaks it when Python may cache next to the payload (what this guards against)', () => {
    const { app, payload } = signedBundle()
    expect(verify(app).ok).toBe(true)
    const ran = spawnSync(python!, [join(payload, 'perf.py')], {
      env: { HOME: homedir(), PATH: '/usr/bin:/bin' },
      encoding: 'utf8'
    })
    expect(ran.status, ran.stderr).toBe(0)
    const after = verify(app)
    expect(after.ok).toBe(false)
    expect(after.output).toMatch(/file added|sealed resource/)
  })

  it('keeps it with the environment Pod runs setup.sh in', () => {
    const { app, payload } = signedBundle()
    const spec = accSetupSpec({
      platform: 'darwin',
      home: homedir(),
      accountHome: homedir(),
      userDataPath: '/nonexistent',
      defaultUserDataPath: '/nonexistent',
      payloadDir: payload,
      appPath: app
    })
    const ran = spawnSync(python!, [join(payload, 'perf.py')], {
      env: { ...spec.env, PATH: '/usr/bin:/bin' },
      encoding: 'utf8'
    })
    expect(ran.status, ran.stderr).toBe(0)
    expect(existsSync(join(payload, '__pycache__'))).toBe(false)
    expect(verify(app)).toMatchObject({ ok: true })
  })
})
