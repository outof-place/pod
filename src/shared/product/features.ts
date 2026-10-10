// Fork-only (Pod): the Pod build profile, the one list of Orca features Pod compiles out.
//
// config/build-plugins/pod-build-profile.ts substitutes __POD_FEATURES__ in every electron-vite
// target. Tests, the CLI and other builds leave it undefined, which keeps every feature on, so
// upstream code paths and their tests behave exactly like Orca's. POD_BUILD_PROFILE=orca builds
// the full upstream feature set.
//
// Keep this file free of imports and non-erasable TypeScript: product/pod-slim-packaging.cjs
// require()s it through Node's type stripping.

export const POD_FEATURE_IDS = [
  'featurePromos',
  'uiLocales',
  'mobileWebClient',
  'dictation',
  'windowsSshHosts',
  'usagePolling',
  'emulator',
  'linear',
  'jira',
  'tasks',
  'dashboardPopout',
  'startupBrowserSweep',
  'tccPromptWatch',
  'startupHangWatchdog',
  'nonMacPayloads',
  'cloudSources'
] as const

export type PodFeatureId = (typeof POD_FEATURE_IDS)[number]

export type PodBuildProfile = 'pod' | 'orca'

export type PodFeatureFlags = Readonly<Record<PodFeatureId, boolean>>

type PodPackagingCut = {
  /** electron-builder `files` exclusions added to the app.asar input. */
  readonly excludeFiles?: readonly string[]
  /** `from` paths whose extraResources entries the macOS app drops. */
  readonly dropExtraResources?: readonly string[]
  /** `to` paths whose extraResources entries the macOS app drops. */
  readonly dropExtraResourcesTo?: readonly string[]
  /** Exclusion filters added to the extraResources entry copied from the key path. */
  readonly filterExtraResources?: Readonly<Record<string, readonly string[]>>
  /** Roots removed from the packaged runtime node_modules closure. */
  readonly dropRuntimePackageRoots?: readonly string[]
  /** Bundled ripgrep platforms the macOS app does not ship. */
  readonly dropRipgrepPlatforms?: readonly string[]
  /** Electron (Chromium) locales the app keeps. */
  readonly electronLanguages?: readonly string[]
  /** The app ships no mobile web bundle, so packaging does not require one to be built. */
  readonly skipMobileWebBundleAssert?: boolean
}

type PodFeature = {
  /** Compiled into the Pod product build. */
  readonly pod: boolean
  readonly reason: string
  readonly packaging?: PodPackagingCut
  /** Settings section ids (useSettingsNavigationMetadata) that belong to the feature. */
  readonly settingsSections?: readonly string[]
  /** Modules compiled to an empty stub; rolldown still emits a chunk for a dead import(). */
  readonly stubModules?: readonly RegExp[]
}

export const POD_FEATURES: Readonly<Record<PodFeatureId, PodFeature>> = {
  featurePromos: {
    pod: false,
    reason: 'Feature wall, feature tips, contextual tours, onboarding checklist and the star nag',
    packaging: { dropExtraResources: ['resources/onboarding/feature-wall'] },
    settingsSections: ['setup-guide']
  },
  uiLocales: {
    pod: false,
    reason: 'Pod is English-only: no es/fr/ja/ko/zh catalogs, no language picker, en at startup',
    packaging: { electronLanguages: ['en'] },
    stubModules: [/\/src\/renderer\/src\/i18n\/locales\/(?:es|fr|ja|ko|zh)\.json$/]
  },
  mobileWebClient: {
    pod: false,
    reason:
      "Orca Mobile and the browser web client pair through Stably's apps; desktops pair over WebSocket",
    packaging: {
      excludeFiles: ['!out/web{,/**/*}', '!out/mobile-web{,/**/*}'],
      skipMobileWebBundleAssert: true
    },
    settingsSections: ['mobile']
  },
  dictation: {
    pod: false,
    reason: 'claude-acc owns dictation; drops the sherpa-onnx speech runtime',
    packaging: { dropExtraResources: ['node_modules/sherpa-onnx-darwin-${arch}'] },
    settingsSections: ['voice']
  },
  windowsSshHosts: {
    pod: false,
    reason: 'No SSH to Windows hosts: the win32 relay and ripgrep stay out of the macOS app',
    packaging: {
      dropRipgrepPlatforms: ['win32-x64', 'win32-arm64'],
      filterExtraResources: { 'out/relay': ['!win32-*{,/**/*}'] }
    }
  },
  usagePolling: {
    pod: false,
    reason: 'claude-acc owns quotas: no rate-limit probes spawning claude/agy, no usage scans',
    settingsSections: ['stats']
  },
  emulator: {
    pod: false,
    reason: 'No iOS simulator panes; drops serve-sim',
    packaging: { dropExtraResourcesTo: ['node_modules/serve-sim', 'node_modules/sonner'] },
    settingsSections: ['mobile-emulator']
  },
  linear: {
    pod: false,
    reason: 'No Linear integration; drops @linear/sdk',
    packaging: { dropRuntimePackageRoots: ['@linear/sdk'] },
    settingsSections: ['linear']
  },
  jira: { pod: false, reason: 'No Jira integration' },
  tasks: {
    pod: false,
    reason: 'No tasks page or workspace board',
    settingsSections: ['tasks']
  },
  dashboardPopout: { pod: false, reason: 'No experimental agent dashboard pop-out' },
  startupBrowserSweep: {
    pod: false,
    reason: 'agent-browser orphan sweep runs on first agent-browser use, not at every startup'
  },
  tccPromptWatch: {
    pod: false,
    reason: 'No permanent `log stream` for the Full Disk Access hint'
  },
  startupHangWatchdog: {
    pod: false,
    reason: 'The main-thread hang watchdog starts after the first window is shown'
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
export const POD_UI_LOCALES: boolean =
  typeof __POD_FEATURES__ === 'undefined' || __POD_FEATURES__.uiLocales
export const POD_DICTATION: boolean =
  typeof __POD_FEATURES__ === 'undefined' || __POD_FEATURES__.dictation
export const POD_WINDOWS_SSH_HOSTS: boolean =
  typeof __POD_FEATURES__ === 'undefined' || __POD_FEATURES__.windowsSshHosts
export const POD_USAGE_POLLING: boolean =
  typeof __POD_FEATURES__ === 'undefined' || __POD_FEATURES__.usagePolling
export const POD_EMULATOR: boolean =
  typeof __POD_FEATURES__ === 'undefined' || __POD_FEATURES__.emulator
export const POD_LINEAR: boolean =
  typeof __POD_FEATURES__ === 'undefined' || __POD_FEATURES__.linear
export const POD_JIRA: boolean = typeof __POD_FEATURES__ === 'undefined' || __POD_FEATURES__.jira
export const POD_TASKS: boolean = typeof __POD_FEATURES__ === 'undefined' || __POD_FEATURES__.tasks
export const POD_DASHBOARD_POPOUT: boolean =
  typeof __POD_FEATURES__ === 'undefined' || __POD_FEATURES__.dashboardPopout
export const POD_STARTUP_BROWSER_SWEEP: boolean =
  typeof __POD_FEATURES__ === 'undefined' || __POD_FEATURES__.startupBrowserSweep
export const POD_TCC_PROMPT_WATCH: boolean =
  typeof __POD_FEATURES__ === 'undefined' || __POD_FEATURES__.tccPromptWatch
export const POD_STARTUP_HANG_WATCHDOG: boolean =
  typeof __POD_FEATURES__ === 'undefined' || __POD_FEATURES__.startupHangWatchdog

export function podFeatureFlags(profile: PodBuildProfile): PodFeatureFlags {
  const on = (id: PodFeatureId): boolean => profile === 'orca' || POD_FEATURES[id].pod
  return {
    featurePromos: on('featurePromos'),
    uiLocales: on('uiLocales'),
    mobileWebClient: on('mobileWebClient'),
    dictation: on('dictation'),
    windowsSshHosts: on('windowsSshHosts'),
    usagePolling: on('usagePolling'),
    emulator: on('emulator'),
    linear: on('linear'),
    jira: on('jira'),
    tasks: on('tasks'),
    dashboardPopout: on('dashboardPopout'),
    startupBrowserSweep: on('startupBrowserSweep'),
    tccPromptWatch: on('tccPromptWatch'),
    startupHangWatchdog: on('startupHangWatchdog'),
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

export function podStubModules(profile: PodBuildProfile): RegExp[] {
  const flags = podFeatureFlags(profile)
  return POD_FEATURE_IDS.flatMap((id) => (flags[id] ? [] : (POD_FEATURES[id].stubModules ?? [])))
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
