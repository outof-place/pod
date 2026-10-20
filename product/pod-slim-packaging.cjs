// Fork-only (Pod): removes what the Pod feature profile (src/shared/product/features.ts) cuts
// from the packaged macOS app, layered over an electron-builder config so upstream hooks and
// guards still run. POD_BUILD_PROFILE=orca keeps every upstream resource.
const {
  POD_FEATURES,
  POD_FEATURE_IDS,
  podFeatureFlags
} = require('../src/shared/product/features.ts')

// Runtime packages every Pod build ships whatever a feature flag says: PodNative calls the runtime's
// linear.* methods, which load @linear/sdk on first use (src/main/linear/linear-sdk.ts).
const ALWAYS_PACKAGED_RUNTIME_ROOTS = new Set(['@linear/sdk'])

function readPodBuildProfile(env = process.env) {
  return env.POD_BUILD_PROFILE === 'orca' ? 'orca' : 'pod'
}

function podPackagingCuts(profile) {
  const flags = podFeatureFlags(profile)
  return POD_FEATURE_IDS.filter((id) => !flags[id])
    .map((id) => POD_FEATURES[id].packaging)
    .filter(Boolean)
}

function removeListedItems(list, items, label) {
  for (const item of items) {
    const index = list.indexOf(item)
    if (index === -1) {
      throw new Error(`pod-slim: upstream ${label} no longer lists ${item}`)
    }
    list.splice(index, 1)
  }
}

// Why before the upstream config loads: it derives the runtime node_modules closure and the
// ripgrep afterPack finalize from these shared lists at require time; the orcad template's
// afterPack verify reads its list later.
let prepared = false
function preparePodSlimPackaging(profile = readPodBuildProfile()) {
  if (prepared) {
    return
  }
  prepared = true
  const cuts = podPackagingCuts(profile)
  const runtimeRoots = cuts
    .flatMap((cut) => cut.dropRuntimePackageRoots ?? [])
    .filter((root) => !ALWAYS_PACKAGED_RUNTIME_ROOTS.has(root))
  const ripgrepPlatforms = cuts.flatMap((cut) => cut.dropRipgrepPlatforms ?? [])
  const templateTargets = cuts.flatMap((cut) => cut.dropOrcadTemplateTargets ?? [])
  const runtime = require('../config/packaged-runtime-node-modules.cjs')
  removeListedItems(runtime.PACKAGED_RUNTIME_PACKAGE_ROOTS, runtimeRoots, 'runtime package roots')
  const ripgrep = require('../config/bundled-ripgrep-resources.cjs')
  removeListedItems(ripgrep.BUNDLED_RIPGREP_PLATFORMS, ripgrepPlatforms, 'ripgrep platforms')
  const template = require('../config/scripts/packaged-orcad-template.cjs')
  removeListedItems(
    template.PACKAGED_ORCAD_TEMPLATE_TARGETS,
    templateTargets,
    'orcad template targets'
  )
}

function applyPodSlimPackaging(base, profile = readPodBuildProfile()) {
  const cuts = podPackagingCuts(profile)
  const dropped = new Set(cuts.flatMap((cut) => cut.dropExtraResources ?? []))
  const droppedTo = new Set(cuts.flatMap((cut) => cut.dropExtraResourcesTo ?? []))
  const filters = {}
  for (const cut of cuts) {
    for (const [from, exclusions] of Object.entries(cut.filterExtraResources ?? {})) {
      filters[from] = [...(filters[from] ?? []), ...exclusions]
    }
  }
  const ripgrepPlatforms = cuts.flatMap((cut) => cut.dropRipgrepPlatforms ?? [])
  const { RIPGREP_PACKAGE_BIN_DIR } = require('../config/bundled-ripgrep-resources.cjs')
  const slimResource = (entry) => {
    const resource = typeof entry === 'string' ? { from: entry, to: entry } : entry
    if (dropped.has(resource.from) || droppedTo.has(resource.to)) {
      return []
    }
    if (resource.from === RIPGREP_PACKAGE_BIN_DIR && ripgrepPlatforms.length > 0) {
      const filter = resource.filter.filter(
        (pattern) => !ripgrepPlatforms.some((platform) => pattern.startsWith(`${platform}/`))
      )
      return [{ ...resource, filter }]
    }
    const exclusions = filters[resource.from]
    return exclusions
      ? [{ ...resource, filter: [...(resource.filter ?? ['**/*']), ...exclusions] }]
      : [entry]
  }
  const electronLanguages = cuts.flatMap((cut) => cut.electronLanguages ?? [])
  return {
    ...base,
    ...(electronLanguages.length > 0 ? { electronLanguages } : {}),
    files: [...base.files, ...cuts.flatMap((cut) => cut.excludeFiles ?? [])],
    mac: { ...base.mac, extraResources: base.mac.extraResources.flatMap(slimResource) }
  }
}

module.exports = {
  applyPodSlimPackaging,
  podPackagingCuts,
  preparePodSlimPackaging,
  readPodBuildProfile
}
