// Fork-only (Pod): removes what the Pod feature profile (src/shared/product/features.ts) cuts
// from the packaged macOS app, layered over an electron-builder config so upstream hooks and
// guards still run. POD_BUILD_PROFILE=orca keeps every upstream resource.
const {
  POD_FEATURES,
  POD_FEATURE_IDS,
  podFeatureFlags
} = require('../src/shared/product/features.ts')

function readPodBuildProfile(env = process.env) {
  return env.POD_BUILD_PROFILE === 'orca' ? 'orca' : 'pod'
}

function podPackagingCuts(profile) {
  const flags = podFeatureFlags(profile)
  return POD_FEATURE_IDS.filter((id) => !flags[id])
    .map((id) => POD_FEATURES[id].packaging)
    .filter(Boolean)
}

function applyPodSlimPackaging(base, profile = readPodBuildProfile()) {
  const cuts = podPackagingCuts(profile)
  const dropped = new Set(cuts.flatMap((cut) => cut.dropExtraResources ?? []))
  const filters = Object.assign({}, ...cuts.map((cut) => cut.filterExtraResources ?? {}))
  const slimResource = (entry) => {
    const resource = typeof entry === 'string' ? { from: entry, to: entry } : entry
    if (dropped.has(resource.from)) {
      return []
    }
    const exclusions = filters[resource.from]
    return exclusions
      ? [{ ...resource, filter: [...(resource.filter ?? ['**/*']), ...exclusions] }]
      : [entry]
  }
  return {
    ...base,
    files: [...base.files, ...cuts.flatMap((cut) => cut.excludeFiles ?? [])],
    mac: { ...base.mac, extraResources: base.mac.extraResources.flatMap(slimResource) }
  }
}

module.exports = { applyPodSlimPackaging, podPackagingCuts, readPodBuildProfile }
