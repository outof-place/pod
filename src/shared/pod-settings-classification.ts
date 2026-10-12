// Fork-only (Pod): every settings key podSettings.* leaves out, and why.
import type { GlobalSettings } from './global-settings-types'
import type { PodSettingsKey, PodSettingsValues } from './pod-settings-schema'
import type { PodSettingsReadOnlyKey } from './pod-settings-read-only'

/** Never in podSettings.schema, get or subscribe; set refuses them. */
export const POD_SETTINGS_SECRET_KEYS = [
  // Encrypted at rest (PROTECTED_SECRET_SLOT); a proxy URL can carry credentials.
  'httpProxyUrl',
  'opencodeSessionCookie',
  // Per-agent launch env: where API keys go.
  'agentDefaultEnv',
  // The install id.
  'telemetry'
] as const satisfies readonly (keyof GlobalSettings)[]

export type PodSettingsSecretKey = (typeof POD_SETTINGS_SECRET_KEYS)[number]

export type PodSettingsHiddenReason =
  /** A one-shot migration guard. */
  | 'migration'
  /** Windows, Linux or WSL only. */
  | 'platform'
  /** An engineering kill switch. */
  | 'kill-switch'
  /** Edited through its own flow or RPC: accounts, plugins, Pod Workspace, Tasks, pairing. */
  | 'owned'
  /** App state, not a preference. */
  | 'internal'
  /** Superseded by another key. */
  | 'legacy'
  /** A preference no native page shows yet. */
  | 'later'
  /** Shapes only Electron's own window: its sidebar, editor, browser, chat and diff views. */
  | 'electron-ui'

export const POD_SETTINGS_HIDDEN = {
  autoRenameBranchFromWorkDefaultedOn: 'migration',
  primarySelectionMiddleClickPasteDefaultedForLinux: 'migration',
  primarySelectionMiddleClickPasteDefaultedForTerminalDefaults: 'migration',
  terminalTuiScrollSensitivityDefaultedToOne: 'migration',
  terminalCursorStyleDefaultedToBlock: 'migration',
  terminalRightClickToPasteDefaultedForPlatform: 'migration',
  localAccountRuntimeDefaultedToAutoForAllUsers: 'migration',
  terminalAllowOsc52ClipboardDefaultedOnForAllUsers: 'migration',
  floatingTerminalDefaultedForAllUsers: 'migration',
  floatingTerminalCwdMigratedToAppWorkspace: 'migration',
  claudeAgentTeamsDefaultDisabledMigrated: 'migration',
  visibleTaskProvidersDefaultedForJira: 'migration',
  agentYoloDefaultsMigrated: 'migration',
  terminalMacOptionAsAltMigrated: 'migration',
  agentsSidebarMigratedFromExperimental: 'migration',
  experimentalActivityDefaultedOffForAllUsers: 'migration',
  minimizeToTrayOnClose: 'platform',
  terminalRightClickToPaste: 'platform',
  terminalWindowsShell: 'platform',
  terminalWindowsWslDistro: 'platform',
  localAccountRuntime: 'platform',
  localAccountWslDistro: 'platform',
  localAgentRuntime: 'platform',
  localAgentWslDistro: 'platform',
  localWindowsRuntimeDefault: 'platform',
  terminalWindowsPowerShellImplementation: 'platform',
  electronHttp1CompatibilityMode: 'kill-switch',
  browserClientHostedRemoteEnabled: 'kill-switch',
  terminalHiddenViewParking: 'kill-switch',
  terminalSshViewParking: 'kill-switch',
  terminalHiddenWorktreeRetentionBudget: 'kill-switch',
  browserGuestWorktreeRetentionBudget: 'kill-switch',
  terminalMainSideEffectAuthority: 'kill-switch',
  terminalHiddenDeliveryGate: 'kill-switch',
  terminalModelQueryAuthority: 'kill-switch',
  terminalMainModelDormancy: 'kill-switch',
  podTerminalMainModelDormancy: 'kill-switch',
  terminalDaemonQueryAuthority: 'kill-switch',
  agentStateRulesLiveUpdates: 'kill-switch',
  codexTerminalServerIsolation: 'kill-switch',
  experimentalNativeTerminalParseOnce: 'kill-switch',
  experimentalPodWorkspace: 'owned',
  podWorkspaceRoot: 'owned',
  thirdPartyPluginsEnabled: 'owned',
  worktreeVisibilityDefaults: 'owned',
  hostSettingOverrides: 'owned',
  terminalCustomThemes: 'owned',
  terminalColorOverrides: 'owned',
  terminalQuickCommands: 'owned',
  nativeChatSessionOptions: 'owned',
  artifactSharingEnabled: 'owned',
  agentSkillSharingEnabled: 'owned',
  nestedWorkerMaxDepth: 'owned',
  floatingTerminalTrustedCwds: 'owned',
  keybindings: 'owned',
  prBotAuthorOverrides: 'owned',
  codexManagedAccounts: 'owned',
  activeCodexManagedAccountId: 'owned',
  activeCodexManagedAccountIdsByRuntime: 'owned',
  claudeManagedAccounts: 'owned',
  activeClaudeManagedAccountId: 'owned',
  activeClaudeManagedAccountIdsByRuntime: 'owned',
  pluginSystemEnabled: 'owned',
  disabledPlugins: 'owned',
  pluginConsents: 'owned',
  devPluginPaths: 'owned',
  defaultTaskViewPreset: 'owned',
  defaultTaskSource: 'owned',
  visibleTaskProviders: 'owned',
  defaultRepoSelection: 'owned',
  defaultLinearTeamSelection: 'owned',
  opencodeWorkspaceId: 'owned',
  minimaxGroupId: 'owned',
  minimaxUsageModels: 'owned',
  minimaxEndpoint: 'owned',
  zcodePlanSite: 'owned',
  geminiCliOAuthEnabled: 'owned',
  mobilePairingConnectionMode: 'owned',
  mobilePairingCustomAddress: 'owned',
  mobilePairingCustomAddresses: 'owned',
  machineName: 'owned',
  activeRuntimeEnvironmentId: 'owned',
  githubProjects: 'owned',
  gitlabProjects: 'owned',
  voice: 'owned',
  aiVaultSearch: 'owned',
  workspaceDirHistory: 'internal',
  localBaseRefSuggestionDismissed: 'internal',
  openLinksInAppPreferencePrompted: 'internal',
  browserSshWorkspaceRoutingDisabledTargetIds: 'internal',
  browserSshWorkspaceRoutingProbeSkippedTargetIds: 'internal',
  claudeCopiedSystemDefaultNoticeDismissed: 'internal',
  agentStateRulesPath: 'internal',
  dismissedSkillFreshnessNudges: 'internal',
  agentsSidebarIntroShown: 'internal',
  tabSwitchKeybindingSeed: 'internal',
  rightSidebarOpenByDefault: 'legacy',
  artifactsEnabled: 'legacy',
  keepComputerAwakeWhileAgentsRun: 'legacy',
  experimentalSidekick: 'legacy',
  experimentalCompactWorktreeCards: 'legacy',
  terminalScrollSensitivity: 'later',
  terminalFastScrollSensitivity: 'later',
  terminalTuiScrollSensitivity: 'later',
  claudeAgentTeamsMode: 'later',
  httpProxyBypassRules: 'later',
  localhostWorktreeLabelsEnabled: 'later',
  openInApplications: 'later',
  promptCacheTimerEnabled: 'later',
  promptCacheTtlMs: 'later',
  agentCmdOverrides: 'later',
  codexSessionSourceHome: 'later',
  agentDefaultArgs: 'later',
  codexSharedServerWarning: 'later',
  tabAutoGenerateTitle: 'later',
  experimentalMobile: 'later',
  mobileEmulatorEnabled: 'later',
  mobileEmulatorDefaultDeviceUdid: 'later',
  androidSdkPath: 'later',
  mobileAutoRestoreFitMs: 'later',
  experimentalAgentHibernation: 'later',
  agentHibernationIdleMs: 'later',
  experimentalEphemeralVms: 'later',
  commitMessageAi: 'later',
  nativeChatAppearance: 'electron-ui',
  nativeChatAutoName: 'electron-ui',
  leftSidebarAppearanceMode: 'electron-ui',
  leftSidebarTintColor: 'electron-ui',
  leftSidebarTintOpacity: 'electron-ui',
  appIcon: 'electron-ui',
  appFontFamily: 'electron-ui',
  editorMinimapEnabled: 'electron-ui',
  editorFontFamily: 'electron-ui',
  richMarkdownSpellcheckEnabled: 'electron-ui',
  markdownReviewToolsEnabled: 'electron-ui',
  primarySelectionMiddleClickPaste: 'electron-ui',
  terminalGpuAcceleration: 'electron-ui',
  terminalLigatures: 'electron-ui',
  terminalInlineImages: 'electron-ui',
  terminalDividerColorDark: 'electron-ui',
  terminalDividerColorLight: 'electron-ui',
  terminalInactivePaneOpacity: 'electron-ui',
  terminalActivePaneOpacity: 'electron-ui',
  terminalPaneOpacityTransitionMs: 'electron-ui',
  terminalDividerThicknessPx: 'electron-ui',
  windowBackgroundBlur: 'electron-ui',
  terminalLinkActionPopoverEnabled: 'electron-ui',
  terminalLinkClickBehavior: 'electron-ui',
  terminalUrlMiddleClickBehavior: 'electron-ui',
  experimentalNativeChat: 'electron-ui',
  nativeChatResumeWorkOnRestart: 'electron-ui',
  nativeChatQueueFollowUps: 'electron-ui',
  nativeChatInlineVisuals: 'electron-ui',
  nativeChatInheritShellEnvironment: 'electron-ui',
  nativeChatShellEnvironmentVariables: 'electron-ui',
  sourceControlViewMode: 'electron-ui',
  sourceControlGroupOrder: 'electron-ui',
  showTitlebarAppName: 'electron-ui',
  showTasksButton: 'electron-ui',
  showAutomationsButton: 'electron-ui',
  showArtifactsButton: 'electron-ui',
  showSkillsButton: 'electron-ui',
  showMobileButton: 'electron-ui',
  showPinnedWorktreesInGroups: 'electron-ui',
  ctrlTabOrderMode: 'electron-ui',
  terminalShortcutPolicy: 'electron-ui',
  browserSshWorkspaceRoutingEnabled: 'electron-ui',
  floatingTerminalTriggerLocation: 'electron-ui',
  diffDefaultView: 'electron-ui',
  diffWordWrap: 'electron-ui',
  diffShowWhitespace: 'electron-ui',
  diffCollapseUnchangedRegions: 'electron-ui',
  combinedDiffFileTreeVisibleByDefault: 'electron-ui',
  skipDeleteAutomationConfirm: 'electron-ui',
  skipDeleteArtifactConfirm: 'electron-ui',
  skipCodexRateLimitResetConfirm: 'electron-ui',
  confirmClosePinnedTab: 'electron-ui',
  editorPreviewTabsEnabled: 'electron-ui',
  experimentalPet: 'electron-ui',
  experimentalActivity: 'electron-ui',
  experimentalAgentDashboardPopout: 'electron-ui',
  experimentalAgentDashboardMode: 'electron-ui',
  experimentalAgentDashboardShowIdle: 'electron-ui',
  experimentalTerminalAttention: 'electron-ui',
  experimentalNativeTerminal: 'electron-ui',
  experimentalNewWorktreeCardStyle: 'electron-ui',
  compactWorktreeCards: 'electron-ui'
} as const satisfies { [K in keyof GlobalSettings]?: PodSettingsHiddenReason }

type Classified =
  | PodSettingsKey
  | keyof typeof POD_SETTINGS_HIDDEN
  | PodSettingsSecretKey
  | PodSettingsReadOnlyKey
type Unclassified = Exclude<keyof GlobalSettings, Classified>
/** Fails to compile, naming the keys, when Orca or Pod adds a setting nobody classified here. */
export const POD_SETTINGS_ALL_CLASSIFIED: [Unclassified] extends [never] ? true : Unclassified =
  true

type NotASetting = Exclude<PodSettingsKey, keyof GlobalSettings>
/** Fails to compile when a field names no setting (renamed or removed upstream). */
export const POD_SETTINGS_FIELDS_EXIST: [NotASetting] extends [never] ? true : NotASetting = true

// Objects are written as partial updates the store merges; everything else whole.
type Written<T> = T extends readonly unknown[] ? T : T extends object ? Partial<T> : T
type MistypedField = {
  [K in PodSettingsKey]-?: Exclude<PodSettingsValues[K], undefined> extends Written<
    Exclude<GlobalSettings[K & keyof GlobalSettings], undefined>
  >
    ? never
    : K
}[PodSettingsKey]
/** Fails to compile when a field accepts a value its setting's type does not. */
export const POD_SETTINGS_FIELDS_TYPED: [MistypedField] extends [never] ? true : MistypedField =
  true
