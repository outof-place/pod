import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { dropBytecode, fetchPayload } from './fetch-claude-acc-payload.mjs'

const require = createRequire(import.meta.url)
const { podAccMacExtraResources } = require('../pod-acc-extra-resources.cjs')

const roots = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function temp() {
  const root = mkdtempSync(join(tmpdir(), 'pod-acc-payload-'))
  roots.push(root)
  return root
}

/** A payload checkout that has run Python: caches next to the scripts and in a subfolder. */
function checkout() {
  const dir = join(temp(), 'claude-acc')
  mkdirSync(join(dir, 'Pod Menu.app'), { recursive: true })
  mkdirSync(join(dir, '__pycache__'))
  mkdirSync(join(dir, 'sdk/python/__pycache__'), { recursive: true })
  for (const name of ['VERSION', 'setup.sh', 'owner.py', 'claude-acc-hook', 'orcahost.py']) {
    writeFileSync(join(dir, name), name === 'VERSION' ? '1.31.4\n' : '')
  }
  writeFileSync(join(dir, '__pycache__/orcahost.cpython-314.pyc'), '')
  writeFileSync(join(dir, 'sdk/python/__pycache__/gate.cpython-314.pyc'), '')
  writeFileSync(join(dir, 'sdk/python/gate.py'), '')
  writeFileSync(join(dir, 'stray.pyc'), '')
  return dir
}

describe('claude-acc payload bytecode', () => {
  it('never installs a cache Python wrote, so none is sealed into Pod.app', async () => {
    const into = join(temp(), 'resources/claude-acc')
    await fetchPayload({
      from: checkout(),
      into,
      pin: { repository: 'r', tag: 't', asset: 'a', sha256: null }
    })
    expect(existsSync(join(into, '__pycache__'))).toBe(false)
    expect(existsSync(join(into, 'sdk/python/__pycache__'))).toBe(false)
    expect(existsSync(join(into, 'stray.pyc'))).toBe(false)
    expect(existsSync(join(into, 'sdk/python/gate.py'))).toBe(true)
    expect(existsSync(join(into, 'orcahost.py'))).toBe(true)
  })

  it('counts what it removed', () => {
    expect(dropBytecode(checkout())).toBe(3)
  })

  it('leaves bytecode out of the packaged payload as well', () => {
    const [payload] = podAccMacExtraResources({ payloadDir: checkout(), distroPlugins: temp() })
    expect(payload.filter).toEqual(
      expect.arrayContaining(['!**/__pycache__', '!**/__pycache__/**', '!**/*.pyc'])
    )
  })
})
