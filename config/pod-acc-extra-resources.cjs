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
// pod-rootd's daemonService plist, in payloads that ship the root helper
const DAEMONS = 'LaunchDaemons'

function requireFetched(dir, names, script) {
  for (const name of names) {
    if (!existsSync(join(dir, name))) {
      throw new Error(`${join(dir, name)} is missing: run node config/scripts/${script}`)
    }
  }
}

/** What a payload must hold: v2 (with pod-acc-run) ships the menu helper as Pod Menu.app. */
function payloadFiles(payloadDir) {
  return existsSync(join(payloadDir, 'pod-acc-run'))
    ? ['VERSION', 'setup.sh', 'pod-acc-run', AGENTS, HELPER]
    : ['VERSION', 'setup.sh', 'Claude Acc.app']
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
      // a v2 payload's launchd plists and helper live in Contents/Library (podAccMacExtraFiles)
      filter: ['**/*', '!.payload-source.json', `!${AGENTS}/**`, `!${DAEMONS}/**`, `!${HELPER}/**`]
    },
    { from: pythonDir, to: 'python', filter: ['**/*', '!.payload-source.json'] },
    { from: distroPlugins, to: 'plugins/distro' }
  ]
}

/**
 * For mac extraFiles (relative to Contents): SMAppService only registers agents from
 * Contents/Library/LaunchAgents, daemons from Contents/Library/LaunchDaemons and login items
 * from Contents/Library/LoginItems (src/main/pod/acc/acc-services.ts). Empty for payloads that
 * predate pod-acc-run.
 */
function podAccMacExtraFiles({ payloadDir = PAYLOAD } = {}) {
  if (!existsSync(join(payloadDir, 'pod-acc-run'))) {
    return []
  }
  const daemons = existsSync(join(payloadDir, DAEMONS))
    ? [{ from: join(payloadDir, DAEMONS), to: `Library/${DAEMONS}`, filter: ['*.plist'] }]
    : []
  return [
    { from: join(payloadDir, AGENTS), to: `Library/${AGENTS}`, filter: ['*.plist'] },
    ...daemons,
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
// "binary-looking" files an xattr signature. Its Mach-Os (bin/python3.14, every .so and .dylib,
// lib-dynload's or a package's) are still signed, with the inherit entitlements, whose
// allow-unsigned-executable-memory CPython's JIT (PYTHON_JIT=1) needs under the hardened runtime;
// notarization rejects an unsigned one.
const podAccMacSignIgnore = ['/Resources/python/lib/python3\\.14/(?!.*\\.(?:so|dylib)$)']

module.exports = {
  podAccMacExtraResources,
  podAccMacExtraFiles,
  podAccFileExclusions,
  podAccMacSignIgnore
}
