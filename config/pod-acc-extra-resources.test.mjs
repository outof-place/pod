import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  podAccMacExtraResources,
  podAccFileExclusions,
  podAccMacSignIgnore
} = require('./pod-acc-extra-resources.cjs')

const roots = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), 'pod-acc-resources-'))
  roots.push(root)
  for (const file of files) {
    mkdirSync(join(root, file, '..'), { recursive: true })
    writeFileSync(join(root, file), '')
  }
  return root
}

describe('Pod claude-acc extraResources', () => {
  const payloadDir = () => tree(['VERSION', 'setup.sh', 'Claude Acc.app/Contents/Info.plist'])
  const pythonDir = () => tree(['bin/python3', 'lib/python3.14/os.py'])

  it('ships the payload, its Python and the distro plugins', () => {
    const entries = podAccMacExtraResources({
      payloadDir: payloadDir(),
      pythonDir: pythonDir(),
      distroPlugins: '/distro'
    })
    expect(entries.map((entry) => entry.to)).toEqual(['claude-acc', 'python', 'plugins/distro'])
    for (const dir of ['claude-acc', 'python']) {
      expect(podAccFileExclusions).toContain(`!resources/${dir}/**`)
    }
  })

  it('fails the build when the Python was never fetched', () => {
    expect(() =>
      podAccMacExtraResources({
        payloadDir: payloadDir(),
        pythonDir: tree([]),
        distroPlugins: '/distro'
      })
    ).toThrow('fetch-pod-python.mjs')
  })

  it('leaves only the Python Mach-Os to osx-sign', () => {
    const ignored = (path) => podAccMacSignIgnore.some((pattern) => new RegExp(pattern).test(path))
    const app = '/dist/mac-arm64/Pod.app/Contents/Resources/python'
    expect(ignored(`${app}/lib/python3.14/__pycache__/os.cpython-314.pyc`)).toBe(true)
    expect(ignored(`${app}/lib/python3.14/json/decoder.py`)).toBe(true)
    expect(ignored(`${app}/lib/python3.14/lib-dynload/_dbm.cpython-314-darwin.so`)).toBe(false)
    expect(ignored(`${app}/bin/python3.14`)).toBe(false)
    expect(ignored('/dist/mac-arm64/Pod.app/Contents/Resources/claude-acc/fanctl')).toBe(false)
  })
})
