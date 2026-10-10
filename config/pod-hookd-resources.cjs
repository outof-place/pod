// Pod's extraResources and extraFiles for pod-hookd, the warm hook server
// (native/pod-hookd/build.mjs builds it into resources/pod-hookd). Upstream Orca's config never
// uses this; the product build does.
const { existsSync } = require('node:fs')
const { join } = require('node:path')

const HOOKD = join(__dirname, '..', 'resources', 'pod-hookd')
const AGENTS = 'LaunchAgents'

/**
 * The binary, when built. Missing: an error with POD_REQUIRE_HOOKD=1 (local release.sh), else a
 * warning and nothing, so CI and dev builds ship without hookd and without its agent.
 */
function podHookdMacExtraResources({
  dir = HOOKD,
  required = process.env.POD_REQUIRE_HOOKD === '1',
  warn = console.warn
} = {}) {
  const missing = ['pod-hookd', AGENTS].find((name) => !existsSync(join(dir, name)))
  if (missing) {
    const message = `${join(dir, missing)} is missing: run node native/pod-hookd/build.mjs`
    if (required) {
      throw new Error(`${message} (POD_REQUIRE_HOOKD=1)`)
    }
    warn(`[product] ${message}; this build ships without pod-hookd`)
    return []
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
