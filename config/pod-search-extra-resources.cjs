// Pod's extraResources for pod-search: the payload config/scripts/fetch-pod-search-payload.mjs puts in
// resources/pod-search (og, ogd, ogctl, a plain rg 15.2.0, the rg and ugrep shims, licences). It ships
// in the runtime's Contents/Resources/pod-search; signing gives each binary none.plist (the default
// rule of product/entitlements-policy.cjs). Upstream Orca's config never uses this; the product build
// does.
const { existsSync, lstatSync } = require('node:fs')
const { join } = require('node:path')

const PAYLOAD = join(__dirname, '..', 'resources', 'pod-search')

/** Throws when the payload is missing, so a Pod release cannot ship without indexed search. */
function podSearchMacExtraResources({ payloadDir = PAYLOAD } = {}) {
  for (const name of ['bin/og', 'bin/ogd', 'bin/ogctl', 'bin/rg', 'BUILD.json']) {
    if (!existsSync(join(payloadDir, name))) {
      throw new Error(
        `pod-search payload missing (${join(payloadDir, name)}): run node config/scripts/fetch-pod-search-payload.mjs`
      )
    }
  }
  for (const link of ['rg-shim/rg', 'ugrep-shim/ugrep']) {
    if (!lstatSync(join(payloadDir, link), { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error(`pod-search payload ${payloadDir}: ${link} is not a link`)
    }
  }
  return [{ from: payloadDir, to: 'pod-search', filter: ['**/*', '!.payload-source.json'] }]
}

// It ships as extraResources; without this the asar `files` glob would pack a second copy.
const podSearchFileExclusions = ['!resources/pod-search/**', '!resources/pod-search.next/**']

module.exports = { podSearchMacExtraResources, podSearchFileExclusions }
