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
// payload v2 (claude-acc with pod-acc-run): launchd plists and the menu helper for SMAppService
const AGENTS = 'LaunchAgents'
const HELPER = 'Pod Menu.app'

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

/** What a payload must hold: v2 (with pod-acc-run) ships the menu helper as Pod Menu.app. */
function payloadFiles(payloadDir) {
  if (isV2(payloadDir)) {
    return ['VERSION', 'setup.sh', 'pod-acc-run', AGENTS, HELPER]
  }
  // a 1.31 payload without pod-acc-run ships its helper as Pod Menu.app too (acc-lifecycle.ts)
  return ['VERSION', 'setup.sh', existsSync(join(payloadDir, HELPER)) ? HELPER : 'Claude Acc.app']
}

function isV2(payloadDir) {
  return existsSync(join(payloadDir, 'pod-acc-run'))
}

/** Throws when the payload or its Python is missing, so a Pod release cannot ship without them. */
function podAccMacExtraResources({
  payloadDir = PAYLOAD,
  pythonDir = PYTHON,
  distroPlugins = DISTRO_PLUGINS
} = {}) {
  requireFetched(payloadDir, payloadFiles(payloadDir), 'fetch-claude-acc-payload.mjs')
  requireFetched(pythonDir, ['bin/python3', 'lib/python3.14/os.py'], 'fetch-pod-python.mjs')
  return [
    {
      from: payloadDir,
      to: 'claude-acc',
      // a v2 payload's agents and helper live in Contents/Library instead (podAccMacExtraFiles)
      filter: [
        '**/*',
        '!.payload-source.json',
        ...(isV2(payloadDir) ? [`!${AGENTS}/**`, `!${HELPER}/**`] : []),
        ...NO_BYTECODE
      ]
    },
    { from: pythonDir, to: 'python', filter: ['**/*', '!.payload-source.json'] },
    { from: distroPlugins, to: 'plugins/distro' }
  ]
}

/**
 * For mac extraFiles (relative to Contents): SMAppService only registers agents from
 * Contents/Library/LaunchAgents and login items from Contents/Library/LoginItems
 * (src/main/pod/acc/acc-services.ts). Empty for payloads that predate pod-acc-run.
 */
function podAccMacExtraFiles({ payloadDir = PAYLOAD } = {}) {
  if (!existsSync(join(payloadDir, 'pod-acc-run'))) {
    return []
  }
  return [
    { from: join(payloadDir, AGENTS), to: `Library/${AGENTS}`, filter: ['*.plist'] },
    { from: join(payloadDir, HELPER), to: `Library/LoginItems/${HELPER}` }
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
  podAccMacExtraFiles,
  podAccFileExclusions,
  podAccMacSignIgnore,
  podAccSealProbes
}
