// Fork-only (Pod): the Pod build profile, the one list of Orca features Pod compiles out.
//
// config/build-plugins/pod-build-profile.ts substitutes __POD_FEATURES__ in every electron-vite
// target. Tests, the CLI and other builds leave it undefined, which keeps every feature on, so
// upstream code paths and their tests behave exactly like Orca's. POD_BUILD_PROFILE=orca builds
// the full upstream feature set.
//
// Keep this file free of imports and non-erasable TypeScript: product/pod-slim-packaging.cjs
// require()s it through Node's type stripping.

export const POD_FEATURE_IDS = ['featurePromos', 'nonMacPayloads', 'cloudSources'] as const

export type PodFeatureId = (typeof POD_FEATURE_IDS)[number]

export type PodBuildProfile = 'pod' | 'orca'

export type PodFeatureFlags = Readonly<Record<PodFeatureId, boolean>>

type PodPackagingCut = {
  /** electron-builder `files` exclusions added to the app.asar input. */
  readonly excludeFiles?: readonly string[]
  /** `from` paths whose extraResources entries the macOS app drops. */
  readonly dropExtraResources?: readonly string[]
  /** Exclusion filters added to the extraResources entry copied from the key path. */
  readonly filterExtraResources?: Readonly<Record<string, readonly string[]>>
}

type PodFeature = {
  /** Compiled into the Pod product build. */
  readonly pod: boolean
  readonly reason: string
  readonly packaging?: PodPackagingCut
  /** Settings section ids (useSettingsNavigationMetadata) that belong to the feature. */
  readonly settingsSections?: readonly string[]
}

export const POD_FEATURES: Readonly<Record<PodFeatureId, PodFeature>> = {
  featurePromos: {
    pod: false,
    reason: 'Feature wall, feature tips, contextual tours, onboarding checklist and the star nag',
    packaging: { dropExtraResources: ['resources/onboarding/feature-wall'] },
    settingsSections: ['setup-guide']
  },
  nonMacPayloads: {
    pod: false,
    reason: 'The WSL relay bundle and Linux launcher scripts never run in the macOS app',
    packaging: {
      excludeFiles: ['!resources/linux{,/**/*}'],
      filterExtraResources: { 'out/relay': ['!wsl{,/**/*}'] }
    }
  },
  cloudSources: {
    pod: false,
    reason: "Stably's relay and push service sources are deploy inputs, not app runtime",
    packaging: { excludeFiles: ['!cloud{,/**/*}'] }
  }
}

// Why global: upstream build constants are ambient globals too (src/types/build-constants.d.ts).
declare global {
  const __POD_FEATURES__: PodFeatureFlags | undefined
}

// Why one boolean export per flag: the bundler inlines exported literals across modules, so a
// false flag drops the gated code; reads through a shared object would keep it.
export const POD_FEATURE_PROMOS: boolean =
  typeof __POD_FEATURES__ === 'undefined' || __POD_FEATURES__.featurePromos

export function podFeatureFlags(profile: PodBuildProfile): PodFeatureFlags {
  const on = (id: PodFeatureId): boolean => profile === 'orca' || POD_FEATURES[id].pod
  return {
    featurePromos: on('featurePromos'),
    nonMacPayloads: on('nonMacPayloads'),
    cloudSources: on('cloudSources')
  }
}

/** electron-vite `define` entries: the whole object for typeof checks, one key per flag. */
export function podFeatureDefines(profile: PodBuildProfile): Record<string, string> {
  const flags = podFeatureFlags(profile)
  const defines: Record<string, string> = { __POD_FEATURES__: JSON.stringify(flags) }
  for (const id of POD_FEATURE_IDS) {
    defines[`__POD_FEATURES__.${id}`] = String(flags[id])
  }
  return defines
}

export function isPodSettingsSectionEnabled(sectionId: string): boolean {
  if (typeof __POD_FEATURES__ === 'undefined') {
    return true
  }
  const flags = __POD_FEATURES__
  return POD_FEATURE_IDS.every(
    (id) => flags[id] || !POD_FEATURES[id].settingsSections?.includes(sectionId)
  )
}
