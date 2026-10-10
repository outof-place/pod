import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

type SealProbe = { name: string; command: string; args: string[] }
const require = createRequire(import.meta.url)
// what product/scripts/verify-bundle-seal.mjs loads, by the same path
const resources: {
  podAccSealProbes: (app: string, options?: { python?: string | null }) => SealProbe[]
} = require('../../../../config/pod-acc-extra-resources.cjs')
const probing: {
  sealProbePython: () => string | null
} = require('../../../../config/pod-acc-seal-probes.cjs')
const python = process.platform === 'darwin' ? probing.sealProbePython() : null
const PAYLOAD = join(__dirname, '../../../../resources/claude-acc')

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

/** Pod.app/Contents/Resources/claude-acc with `files`. */
function app(files: Record<string, string>): { app: string; payload: string } {
  const root = mkdtempSync(join(tmpdir(), 'pod-acc-probes-'))
  roots.push(root)
  const appPath = join(root, 'Pod.app')
  const payload = join(appPath, 'Contents/Resources/claude-acc')
  for (const [name, body] of Object.entries({ VERSION: '1.31.5\n', ...files })) {
    mkdirSync(dirname(join(payload, name)), { recursive: true })
    writeFileSync(join(payload, name), body)
  }
  return { app: appPath, payload }
}

const LAYOUT = {
  'perf.py': 'import os, sys\nimport orcahost\n',
  'orcahost.py': 'HOST = "Pod"\n',
  'sdk/python/run.py': 'from browserlib import Browser\n',
  // a package the build machine may lack, as sdk/python's anthropic
  'sdk/python/browserlib.py': 'import not_installed_anywhere\nclass Browser: ...\n',
  'Pod Menu.app/Contents/Resources/ignored.py': 'import orcahost\n'
}

function bytecodeIn(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name === '__pycache__')
    .map((entry) => join(entry.parentPath, entry.name))
}

function runAll(probes: SealProbe[], home: string): void {
  for (const probe of probes) {
    const ran = spawnSync(probe.command, probe.args, {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', HOME: home }
    })
    expect(ran.status, `${probe.name}: ${ran.stderr}`).toBe(0)
  }
}

describe('claude-acc seal probes', () => {
  it('gives the seal gate a probe per folder whose modules import each other', () => {
    // v5.3.1 exported none, and the gate passed test3 "intact after 0 probe(s)"
    const { app: appPath, payload } = app(LAYOUT)
    const probes = resources.podAccSealProbes(appPath, { python: '/usr/bin/false' })
    expect(probes.length).toBeGreaterThan(0)
    expect(probes.map((probe) => probe.args.slice(4))).toEqual([['orcahost'], ['browserlib']])
    expect(probes.map((probe) => probe.args[3])).toEqual([payload, join(payload, 'sdk/python')])
    // -I: no environment variable may stand in for what the payload ships
    expect(probes.every((probe) => probe.args[0] === '-I')).toBe(true)
  })

  it('throws rather than hand the gate zero probes', () => {
    const empty = app({ 'perf.py': 'import os\n' })
    expect(() => resources.podAccSealProbes(empty.app, { python: '/usr/bin/false' })).toThrow(
      /no claude-acc module imports another/
    )
    const noPayload = join(mkdtempSync(join(tmpdir(), 'pod-acc-probes-')), 'Pod.app')
    roots.push(dirname(noPayload))
    expect(() => resources.podAccSealProbes(noPayload, { python: '/usr/bin/false' })).toThrow(
      /no claude-acc payload/
    )
    const layout = app(LAYOUT)
    expect(() => resources.podAccSealProbes(layout.app, { python: null })).toThrow(
      /POD_SEAL_PYTHON/
    )
  })

  describe.skipIf(!python)('with Python', () => {
    it('write the bytecode that breaks the seal when the payload lacks its __pycache__ files', () => {
      const { app: appPath, payload } = app(LAYOUT)
      runAll(resources.podAccSealProbes(appPath, { python }), dirname(appPath))
      expect(bytecodeIn(payload).sort()).toEqual(
        [join(payload, '__pycache__'), join(payload, 'sdk/python/__pycache__')].sort()
      )
    })

    it("leave a payload with claude-acc 1.31.5's __pycache__ files as it was", () => {
      const { app: appPath, payload } = app({
        ...LAYOUT,
        __pycache__: '',
        'sdk/python/__pycache__': ''
      })
      runAll(resources.podAccSealProbes(appPath, { python }), dirname(appPath))
      expect(bytecodeIn(payload)).toEqual([])
    })
  })

  it.skipIf(!existsSync(join(PAYLOAD, 'VERSION')))('probes the fetched payload', () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-acc-probes-'))
    roots.push(root)
    const resourcesDir = join(root, 'Pod.app/Contents/Resources')
    mkdirSync(resourcesDir, { recursive: true })
    spawnSync('/bin/ln', ['-s', PAYLOAD, join(resourcesDir, 'claude-acc')])
    const modules = resources
      .podAccSealProbes(join(root, 'Pod.app'), { python: '/usr/bin/false' })
      .flatMap((probe) => probe.args.slice(4))
    // perf.py's import that wrote test1's __pycache__/orcahost.cpython-314.pyc
    expect(modules).toContain('orcahost')
  })
})
