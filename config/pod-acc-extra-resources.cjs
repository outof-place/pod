// Pod's extraResources for claude-acc: the payload (config/scripts/fetch-claude-acc-payload.mjs puts it
// in resources/claude-acc) and the bundled distro plugins (resources/plugins/distro, read by the
// bundled bootstrap only when the product identity has a bundledPlugins policy). Upstream Orca's
// config never uses this; the product build does.
const { existsSync } = require('node:fs')
const { join } = require('node:path')

const PAYLOAD = join(__dirname, '..', 'resources', 'claude-acc')
const DISTRO_PLUGINS = join(__dirname, '..', 'resources', 'plugins', 'distro')

// Bytecode never ships: a cache Python wrote in a checkout would be sealed into the app as is,
// and the folder invites the next run to write there (src/main/pod/acc/acc-bundle-seal.test.ts).
const NO_BYTECODE = ['!**/__pycache__', '!**/__pycache__/**', '!**/*.pyc']

/** Throws when the payload is missing, so a Pod release cannot ship without claude-acc. */
function podAccMacExtraResources({ payloadDir = PAYLOAD, distroPlugins = DISTRO_PLUGINS } = {}) {
  // from 1.31 the menu helper ships as Pod Menu.app (src/main/pod/acc/acc-lifecycle.ts)
  const helper = existsSync(join(payloadDir, 'Pod Menu.app')) ? 'Pod Menu.app' : 'Claude Acc.app'
  for (const name of ['VERSION', 'setup.sh', helper]) {
    if (!existsSync(join(payloadDir, name))) {
      throw new Error(
        `claude-acc payload missing (${join(payloadDir, name)}): run node config/scripts/fetch-claude-acc-payload.mjs`
      )
    }
  }
  return [
    {
      from: payloadDir,
      to: 'claude-acc',
      filter: ['**/*', '!.payload-source.json', ...NO_BYTECODE]
    },
    { from: distroPlugins, to: 'plugins/distro' }
  ]
}

// Both ship as extraResources; without these the asar `files` glob would pack a second copy
// (and asarUnpack: ['resources/**'] would unpack it, Mach-Os included).
const podAccFileExclusions = [
  '!resources/plugins/distro/**',
  '!resources/claude-acc/**',
  '!resources/claude-acc.next/**'
]

module.exports = { podAccMacExtraResources, podAccFileExclusions, NO_BYTECODE }
