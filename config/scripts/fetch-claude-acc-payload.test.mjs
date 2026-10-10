import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { dropBytecode, fetchPayload, PAYLOAD_DIR } from './fetch-claude-acc-payload.mjs'

const require = createRequire(import.meta.url)
const { podAccMacExtraResources } = require('../pod-acc-extra-resources.cjs')
// electron-builder's own copy for extraResources, filter included
const { FileMatcher, copyFiles } = require('app-builder-lib/out/fileMatcher')

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

  it('leaves bytecode out of the packaged payload as well', async () => {
    const out = await packaged(checkout())
    expect(walk(out).filter(({ path }) => /__pycache__|\.pyc$/.test(path))).toEqual([])
    expect(existsSync(join(out, 'sdk/python/gate.py'))).toBe(true)
  })
})

/** What electron-builder copies of `payloadDir` into Contents/Resources/claude-acc. */
async function packaged(payloadDir) {
  const [entry] = podAccMacExtraResources({ payloadDir, distroPlugins: temp() })
  const out = join(temp(), 'Resources', entry.to)
  await copyFiles([new FileMatcher(entry.from, out, (s) => s, entry.filter)], null, false)
  return out
}

/** Every entry under `dir` (not inside an .app), as { path, dir: isDirectory }. */
function walk(dir, root = dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    const isDir = lstatSync(path).isDirectory()
    const entry = { path: relative(root, path), dir: isDir }
    return isDir && !name.endsWith('.app') ? [entry, ...walk(path, root)] : [entry]
  })
}

/** Every folder with a .py file has a plain file __pycache__, and no bytecode is anywhere. */
function expectGuarded(dir) {
  const entries = walk(dir)
  const folders = [
    ...new Set(entries.filter((e) => e.path.endsWith('.py')).map((e) => dirname(e.path)))
  ]
  expect(folders.length).toBeGreaterThan(0)
  for (const folder of folders) {
    const sentinel = entries.find((e) => e.path === join(folder, '__pycache__'))
    expect(sentinel, `${folder}/__pycache__`).toEqual({
      path: join(folder, '__pycache__'),
      dir: false
    })
  }
  expect(
    entries.filter((e) => e.path.endsWith('.pyc') || (e.dir && e.path.endsWith('__pycache__')))
  ).toEqual([])
}

describe("claude-acc's __pycache__ sentinels (1.31.5 on)", () => {
  /** 1.31.5's layout: a plain file __pycache__ beside the .py, and a stray .pyc. */
  function guarded() {
    const dir = join(temp(), 'claude-acc')
    mkdirSync(join(dir, 'Pod Menu.app'), { recursive: true })
    mkdirSync(join(dir, 'hooks'))
    mkdirSync(join(dir, 'sdk/python'), { recursive: true })
    for (const name of ['VERSION', 'setup.sh', 'owner.py', 'claude-acc-hook', 'orcahost.py']) {
      writeFileSync(join(dir, name), name === 'VERSION' ? '1.31.5\n' : '')
    }
    writeFileSync(join(dir, '__pycache__'), '')
    writeFileSync(join(dir, 'hooks/hook.py'), '')
    writeFileSync(join(dir, 'hooks/__pycache__'), '')
    writeFileSync(join(dir, 'hooks/old.cpython-314.pyc'), '')
    writeFileSync(join(dir, 'sdk/python/gate.py'), '')
    writeFileSync(join(dir, 'sdk/python/__pycache__'), '')
    return dir
  }

  it('keeps them through the fetch and the electron-builder copy, and drops the bytecode', async () => {
    const into = join(temp(), 'resources/claude-acc')
    await fetchPayload({
      from: guarded(),
      into,
      pin: { repository: 'r', tag: 't', asset: 'a', sha256: null }
    })
    expectGuarded(into)
    expectGuarded(await packaged(into))
  })

  it('removes a cache left in a cached download', async () => {
    const into = join(temp(), 'resources/claude-acc')
    const pin = { repository: 'r', tag: 't', asset: 'a', sha256: 'f'.repeat(64) }
    await fetchPayload({ from: guarded(), into, pin })
    writeFileSync(join(into, '.payload-source.json'), JSON.stringify({ sha256: pin.sha256 }))
    // a payload script run by hand from resources/claude-acc, in a folder without a sentinel
    mkdirSync(join(into, 'tools/__pycache__'), { recursive: true })
    writeFileSync(join(into, 'tools/__pycache__/x.cpython-314.pyc'), '')
    await expect(fetchPayload({ into, pin })).resolves.toMatchObject({ source: 'cached' })
    expect(existsSync(join(into, 'tools/__pycache__'))).toBe(false)
    expectGuarded(into)
  })

  const fetched = existsSync(join(PAYLOAD_DIR, 'VERSION'))
    ? readFileSync(join(PAYLOAD_DIR, 'VERSION'), 'utf8').trim()
    : null
  const atLeast1315 =
    !!fetched && fetched.localeCompare('1.31.5', undefined, { numeric: true }) >= 0
  it.skipIf(!atLeast1315)(`holds for the fetched payload ${fetched} as packaged`, async () => {
    expectGuarded(await packaged(PAYLOAD_DIR))
  })
})
