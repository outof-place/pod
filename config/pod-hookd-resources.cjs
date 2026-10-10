// Pod's extraResources and extraFiles for pod-hookd, the warm hook server
// (native/pod-hookd/build.mjs builds it into resources/pod-hookd). Upstream Orca's config never
// uses this; the product build does.
const { existsSync } = require('node:fs')
const { join } = require('node:path')

const HOOKD = join(__dirname, '..', 'resources', 'pod-hookd')
const AGENTS = 'LaunchAgents'

/** Throws when pod-hookd was never built, so a release cannot ship without it. */
function podHookdMacExtraResources({ dir = HOOKD } = {}) {
  for (const name of ['pod-hookd', AGENTS]) {
    if (!existsSync(join(dir, name))) {
      throw new Error(`${join(dir, name)} is missing: run node native/pod-hookd/build.mjs`)
    }
  }
  return [{ from: dir, to: 'pod-hookd', filter: ['pod-hookd'] }]
}

/**
 * For mac extraFiles (relative to Contents): the agent's plist goes where SMAppService registers it
 * from, Contents/Library/LaunchAgents (src/main/pod/acc/acc-services.ts), and only together with
 * the binary its BundleProgram names.
 */
function podHookdMacExtraFiles({ dir = HOOKD } = {}) {
  if (!existsSync(join(dir, 'pod-hookd')) || !existsSync(join(dir, AGENTS))) {
    return []
  }
  return [{ from: join(dir, AGENTS), to: `Library/${AGENTS}`, filter: ['*.acc.hookd.plist'] }]
}

// Shipped as extraResources only: without these the asar `files` glob would pack a second copy.
const podHookdFileExclusions = ['!resources/pod-hookd/**', '!resources/pod-hookd.next/**']

module.exports = { podHookdMacExtraResources, podHookdMacExtraFiles, podHookdFileExclusions }
