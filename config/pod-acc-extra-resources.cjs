// Pod's extraResources for claude-acc: the payload (config/scripts/fetch-claude-acc-payload.mjs puts it
// in resources/claude-acc), the Python that runs it (config/scripts/fetch-pod-python.mjs, in
// resources/python) and the bundled distro plugins (resources/plugins/distro, read by the bundled
// bootstrap only when the product identity has a bundledPlugins policy). Upstream Orca's config never
// uses this; the product build does.
const { existsSync } = require('node:fs')
const { join } = require('node:path')

const PAYLOAD = join(__dirname, '..', 'resources', 'claude-acc')
const PYTHON = join(__dirname, '..', 'resources', 'python')
const DISTRO_PLUGINS = join(__dirname, '..', 'resources', 'plugins', 'distro')

function requireFetched(dir, names, script) {
  for (const name of names) {
    if (!existsSync(join(dir, name))) {
      throw new Error(`${join(dir, name)} is missing: run node config/scripts/${script}`)
    }
  }
}

/** Throws when the payload or its Python is missing, so a Pod release cannot ship without them. */
function podAccMacExtraResources({
  payloadDir = PAYLOAD,
  pythonDir = PYTHON,
  distroPlugins = DISTRO_PLUGINS
} = {}) {
  requireFetched(
    payloadDir,
    ['VERSION', 'setup.sh', 'Claude Acc.app'],
    'fetch-claude-acc-payload.mjs'
  )
  requireFetched(pythonDir, ['bin/python3', 'lib/python3.14/os.py'], 'fetch-pod-python.mjs')
  return [
    { from: payloadDir, to: 'claude-acc', filter: ['**/*', '!.payload-source.json'] },
    { from: pythonDir, to: 'python', filter: ['**/*', '!.payload-source.json'] },
    { from: distroPlugins, to: 'plugins/distro' }
  ]
}

// All ship as extraResources; without these the asar `files` glob would pack a second copy
// (and asarUnpack: ['resources/**'] would unpack it, Mach-Os included).
const podAccFileExclusions = [
  '!resources/plugins/distro/**',
  '!resources/claude-acc/**',
  '!resources/claude-acc.next/**',
  '!resources/python/**',
  '!resources/python.next/**'
]

// For mac signIgnore: the stdlib's .py/.pyc are data, and osx-sign would give each of its ~1000
// "binary-looking" files an xattr signature. Its Mach-Os (bin/python3.14, lib-dynload/*.so) are
// still signed, with the inherit entitlements, whose allow-unsigned-executable-memory CPython's
// JIT (PYTHON_JIT=1) needs under the hardened runtime.
const podAccMacSignIgnore = ['/Resources/python/lib/python3\\.14/(?!lib-dynload/)']

module.exports = { podAccMacExtraResources, podAccFileExclusions, podAccMacSignIgnore }
