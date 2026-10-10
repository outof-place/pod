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

// Bytecode never ships: a cache Python wrote in a checkout would be sealed into the app as is
// (src/main/pod/acc/acc-bundle-seal.test.ts). What is inside a __pycache__ folder stays out, never
// the name itself: from 1.31.5 the payload has a plain FILE called __pycache__ next to its .py,
// so no Python can make the folder there.
const NO_BYTECODE = ['!**/__pycache__/**', '!**/*.pyc']

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
  // from 1.31 the menu helper ships as Pod Menu.app (src/main/pod/acc/acc-lifecycle.ts)
  const helper = existsSync(join(payloadDir, 'Pod Menu.app')) ? 'Pod Menu.app' : 'Claude Acc.app'
  requireFetched(payloadDir, ['VERSION', 'setup.sh', helper], 'fetch-claude-acc-payload.mjs')
  requireFetched(pythonDir, ['bin/python3', 'lib/python3.14/os.py'], 'fetch-pod-python.mjs')
  return [
    {
      from: payloadDir,
      to: 'claude-acc',
      filter: ['**/*', '!.payload-source.json', ...NO_BYTECODE]
    },
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

// product/scripts/verify-bundle-seal.mjs runs these against a copy of the signed app
const { podAccSealProbes } = require('./pod-acc-seal-probes.cjs')

module.exports = {
  NO_BYTECODE,
  podAccMacExtraResources,
  podAccFileExclusions,
  podAccMacSignIgnore,
  podAccSealProbes
}
