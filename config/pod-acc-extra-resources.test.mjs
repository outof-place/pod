import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  podAccMacExtraResources,
  podAccMacExtraFiles,
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

  it("moves a v2 payload's launchd plists and menu helper into Contents/Library", () => {
    expect(podAccMacExtraFiles({ payloadDir: payloadDir() })).toEqual([])
    const v2 = tree([
      'VERSION',
      'setup.sh',
      'pod-acc-run',
      'LaunchAgents/codes.pod.app.acc.tick.plist',
      'Pod Menu.app/Contents/Info.plist'
    ])
    expect(podAccMacExtraFiles({ payloadDir: v2 }).map((entry) => entry.to)).toEqual([
      'Library/LaunchAgents',
      'Library/LoginItems/Pod Menu.app'
    ])
    const [resources] = podAccMacExtraResources({
      payloadDir: v2,
      pythonDir: pythonDir(),
      distroPlugins: '/distro'
    })
    expect(resources.filter).toEqual(
      expect.arrayContaining(['!LaunchAgents/**', '!Pod Menu.app/**'])
    )
  })

  it('keeps pod-rootd and its package in Resources/claude-acc, out of Contents/Library', () => {
    const withRootd = tree([
      'VERSION',
      'setup.sh',
      'pod-acc-run',
      'pod-rootd',
      'pod-rootctl',
      'pod-rootd.pkg',
      'LaunchAgents/codes.pod.app.acc.tick.plist',
      'Pod Menu.app/Contents/Info.plist'
    ])
    expect(podAccMacExtraFiles({ payloadDir: withRootd }).map((entry) => entry.to)).toEqual([
      'Library/LaunchAgents',
      'Library/LoginItems/Pod Menu.app'
    ])
    const [resources] = podAccMacExtraResources({
      payloadDir: withRootd,
      pythonDir: pythonDir(),
      distroPlugins: '/distro'
    })
    expect(resources).toMatchObject({ from: withRootd, to: 'claude-acc' })
    expect(resources.filter.filter((glob) => glob.startsWith('!'))).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/rootd|rootctl/)])
    )
  })

  it('keeps the entitlement the embedded Python needs for PYTHON_JIT=1', () => {
    // CPython's JIT maps W+X memory without MAP_JIT: under the hardened runtime, allow-jit alone
    // gets bin/python3.14 SIGKILLed. osx-sign gives it the inherit entitlements, so they must
    // keep allow-unsigned-executable-memory for as long as Contents/Resources/python ships.
    const root = resolve(import.meta.dirname, '..')
    const base = require('./electron-builder.config.cjs')
    const inherit = readFileSync(resolve(root, base.mac.entitlementsInherit), 'utf8')
    expect(inherit).toMatch(
      /<key>com\.apple\.security\.cs\.allow-unsigned-executable-memory<\/key>\s*<true\/>/
    )
    const product = readFileSync(join(root, 'product', 'electron-builder.pod.cjs'), 'utf8')
    expect(
      product,
      'a product override of entitlementsInherit must keep the Python JIT entitlement'
    ).not.toMatch(/entitlementsInherit\s*:/)
  })

  it('names signIgnore and files once each in the product config', () => {
    // a second key in the same object literal silently replaces the first: product/ and
    // claude-acc each add entries, so both must live in one array
    const product = readFileSync(
      resolve(import.meta.dirname, '..', 'product', 'electron-builder.pod.cjs'),
      'utf8'
    )
    expect(product.match(/^\s*signIgnore\s*:/gm)).toHaveLength(1)
    expect(product.match(/^\s*files\s*:/gm)).toHaveLength(1)
    const array = (key) =>
      product.match(new RegExp(`^\\s*${key}: \\[([\\s\\S]*?)^\\s*\\],?$`, 'm'))?.[1]
    expect(array('signIgnore')).toMatch(/PRODUCT_SIGN_IGNORE[\s\S]*podAccMacSignIgnore/)
    expect(array('files')).toMatch(/PRODUCT_FILE_EXCLUSIONS[\s\S]*podAccFileExclusions/)
  })

  // the product config builds its extraResources at require time, which needs both fetched
  const fetched = ['resources/claude-acc/pod-acc-run', 'resources/python/bin/python3'].every(
    (file) => existsSync(resolve(import.meta.dirname, '..', file))
  )

  it.skipIf(!fetched)("puts claude-acc into Pod's packaged config next to upstream's", () => {
    const base = require('./electron-builder.config.cjs')
    const product = require('../product/electron-builder.pod.cjs')
    expect(product.mac.extraFiles).toEqual([...base.mac.extraFiles, ...podAccMacExtraFiles()])
    expect(product.mac.extraFiles.map((entry) => entry.to)).toEqual(
      expect.arrayContaining(['Library/LaunchAgents', 'Library/LoginItems/Pod Menu.app'])
    )
    const {
      PRODUCT_FILE_EXCLUSIONS,
      PRODUCT_SIGN_IGNORE
    } = require('../product/release-bundle-gate.cjs')
    expect(product.mac.signIgnore).toEqual([
      ...base.mac.signIgnore,
      ...PRODUCT_SIGN_IGNORE,
      ...podAccMacSignIgnore
    ])
    expect(product.files).toEqual([
      ...base.files,
      ...PRODUCT_FILE_EXCLUSIONS,
      ...podAccFileExclusions
    ])
    expect(product.mac.extraResources.map((entry) => entry.to)).toEqual(
      expect.arrayContaining(['claude-acc', 'python', 'plugins/distro'])
    )
  })

  it('fetches the Python for a release next to the payload', () => {
    const release = readFileSync(
      resolve(import.meta.dirname, '..', 'product', 'release.sh'),
      'utf8'
    )
    const payload = release.indexOf('node config/scripts/fetch-claude-acc-payload.mjs')
    const python = release.indexOf('node config/scripts/fetch-pod-python.mjs')
    const builder = release.indexOf('pnpm exec electron-builder')
    expect(payload).toBeGreaterThan(-1)
    expect(python).toBeGreaterThan(payload)
    expect(builder).toBeGreaterThan(python)
  })

  it('leaves only the Python Mach-Os to osx-sign', () => {
    const ignored = (path) => podAccMacSignIgnore.some((pattern) => new RegExp(pattern).test(path))
    const app = '/dist/mac-arm64/Pod.app/Contents/Resources/python'
    expect(ignored(`${app}/lib/python3.14/__pycache__/os.cpython-314.pyc`)).toBe(true)
    expect(ignored(`${app}/lib/python3.14/json/decoder.py`)).toBe(true)
    expect(ignored(`${app}/lib/python3.14/lib-dynload/_dbm.cpython-314-darwin.so`)).toBe(false)
    // a compiled package outside lib-dynload is a Mach-O too: notarization wants it signed
    expect(ignored(`${app}/lib/python3.14/site-packages/pkg/_speedups.cpython-314-darwin.so`)).toBe(
      false
    )
    expect(ignored(`${app}/lib/python3.14/site-packages/pkg/libpkg.dylib`)).toBe(false)
    expect(ignored(`${app}/lib/python3.14/ensurepip/_bundled/pip-25.0-py3-none-any.whl`)).toBe(true)
    expect(ignored(`${app}/bin/python3.14`)).toBe(false)
    expect(ignored('/dist/mac-arm64/Pod.app/Contents/Resources/claude-acc/fanctl')).toBe(false)
  })
})
