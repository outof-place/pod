// Fork-only (Pod): every settings key podSettings.* leaves out, and why.
import type { GlobalSettings } from './global-settings-types'
import type { PodSettingsKey, PodSettingsValues } from './pod-settings-schema'

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
  /** A preference Pod keeps that no native page shows yet; each says why. */
  | 'later'
  /** A feature Pod dropped, or chrome that means nothing without Orca's window. */
  | 'dropped'

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
  tabAutoGenerateTitleDefaultedOnForPod: 'migration',
  floatingTerminalCwdMigratedToAppWorkspace: 'migration',
  claudeAgentTeamsDefaultDisabledMigrated: 'migration',
  visibleTaskProvidersDefaultedForJira: 'migration',
  agentYoloDefaultsMigrated: 'migration',
  terminalMacOptionAsAltMigrated: 'migration',
  agentsSidebarMigratedFromExperimental: 'migration',
  experimentalActivityDefaultedOffForAllUsers: 'migration',
  minimizeToTrayOnClose: 'platform',
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
  // Set only through linear.setAgentAccess, from Pod's window or PodNative (pod-linear-access.ts).
  podLinearAgentAccess: 'owned',
  podWorkspaceRoot: 'owned',
  worktreeVisibilityDefaults: 'owned',
  hostSettingOverrides: 'owned',
  terminalCustomThemes: 'owned',
  terminalColorOverrides: 'owned',
  terminalQuickCommands: 'owned',
  nativeChatSessionOptions: 'owned',
  artifactSharingEnabled: 'owned',
  agentSkillSharingEnabled: 'owned',
  floatingTerminalTrustedCwds: 'owned',
  keybindings: 'owned',
  prBotAuthorOverrides: 'owned',
  codexManagedAccounts: 'owned',
  activeCodexManagedAccountId: 'owned',
  activeCodexManagedAccountIdsByRuntime: 'owned',
  claudeManagedAccounts: 'owned',
  activeClaudeManagedAccountId: 'owned',
  activeClaudeManagedAccountIdsByRuntime: 'owned',
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
  // Read into terminalLinkClickBehavior, which a native client sees and writes.
  terminalLinkActionPopoverEnabled: 'legacy',
  artifactsEnabled: 'legacy',
  keepComputerAwakeWhileAgentsRun: 'legacy',
  experimentalSidekick: 'legacy',
  experimentalCompactWorktreeCards: 'legacy',
  commitMessageAi: 'legacy',
  // Kept, with no native page yet:
  // native-panes-shim turns Claude's tmux splits into Orca panes; unverified with PodNative's splits.
  claudeAgentTeamsMode: 'later',
  // Labels in Orca's browser tab; PodNative's browser has none yet.
  localhostWorktreeLabelsEnabled: 'later',
  // The banner it hides is drawn by Orca's renderer; PodNative shows no such banner yet.
  codexSharedServerWarning: 'later',
  // Mobile and emulator panes: native simulators are planned separately.
  experimentalMobile: 'later',
  mobileEmulatorEnabled: 'later',
  mobileEmulatorDefaultDeviceUdid: 'later',
  androidSdkPath: 'later',
  mobileAutoRestoreFitMs: 'later',
  // On-demand environments have no native flow yet.
  experimentalEphemeralVms: 'later',
  // Orca's chat view; whether PodNative gets one is open. Its shell variables can hold secrets.
  experimentalNativeChat: 'later',
  nativeChatAppearance: 'later',
  nativeChatAutoName: 'later',
  nativeChatQueueFollowUps: 'later',
  nativeChatInlineVisuals: 'later',
  nativeChatInheritShellEnvironment: 'later',
  nativeChatShellEnvironmentVariables: 'later',
  // Routes Orca's browser tabs through SSH; PodNative's browser doesn't yet.
  browserSshWorkspaceRoutingEnabled: 'later',
  // PodNative's editor has no preview tabs.
  editorPreviewTabsEnabled: 'later',
  // Row bounds lived in pod-settings-schema.ts at commit ed129568dd; restore them with the control.
  // N1 (native settings): PodNative reads none of these yet, so a row would change nothing.
  terminalShortcutPolicy: 'later',
  // N1: the middle-click paste is fixed behavior in PodNative's terminal, not driven by this key.
  primarySelectionMiddleClickPaste: 'later',
  // N1: PodNative's Open In menu has no custom apps; its "Edit in Pod" row opens the classic window.
  openInApplications: 'later',
  // N1: PodNative has no delete or reset confirmations for these yet.
  skipDeleteAutomationConfirm: 'later',
  skipDeleteArtifactConfirm: 'later',
  skipCodexRateLimitResetConfirm: 'later',
  // N3 (editor and tabs): PodNative's tab strip has its own order, pinning and titles.
  ctrlTabOrderMode: 'later',
  confirmClosePinnedTab: 'later',
  // pod-gocache's switch; its Build speed row on a native page comes with the status it shows.
  podGoCacheEnabled: 'later',
  // Phase 6 (experiments): only Orca's renderer reads these; PodNative has no such feature yet.
  experimentalAgentHibernation: 'later',
  agentHibernationIdleMs: 'later',
  experimentalActivity: 'later',
  // Orca's window chrome, sidebar, Monaco editor and diff views; PodNative keeps its own
  // (sourceControlViewMode and the diff toggles in UserDefaults).
  leftSidebarAppearanceMode: 'dropped',
  leftSidebarTintColor: 'dropped',
  leftSidebarTintOpacity: 'dropped',
  appIcon: 'dropped',
  appFontFamily: 'dropped',
  windowBackgroundBlur: 'dropped',
  showTitlebarAppName: 'dropped',
  showTasksButton: 'dropped',
  showAutomationsButton: 'dropped',
  showArtifactsButton: 'dropped',
  showSkillsButton: 'dropped',
  showMobileButton: 'dropped',
  showPinnedWorktreesInGroups: 'dropped',
  floatingTerminalTriggerLocation: 'dropped',
  compactWorktreeCards: 'dropped',
  experimentalNewWorktreeCardStyle: 'dropped',
  experimentalAgentDashboardPopout: 'dropped',
  experimentalAgentDashboardMode: 'dropped',
  experimentalAgentDashboardShowIdle: 'dropped',
  experimentalPet: 'dropped',
  editorMinimapEnabled: 'dropped',
  richMarkdownSpellcheckEnabled: 'dropped',
  markdownReviewToolsEnabled: 'dropped',
  sourceControlViewMode: 'dropped',
  sourceControlGroupOrder: 'dropped',
  diffDefaultView: 'dropped',
  diffWordWrap: 'dropped',
  diffShowWhitespace: 'dropped',
  diffCollapseUnchangedRegions: 'dropped',
  combinedDiffFileTreeVisibleByDefault: 'dropped',
  // xterm.js renderer options and addons; PodNative's terminal draws its own.
  terminalGpuAcceleration: 'dropped',
  terminalLigatures: 'dropped',
  terminalInlineImages: 'dropped',
  terminalPaneOpacityTransitionMs: 'dropped',
  // Orca's own terminal experiment inside Electron.
  experimentalNativeTerminal: 'dropped'
} as const satisfies { [K in keyof GlobalSettings]?: PodSettingsHiddenReason }

type Classified = PodSettingsKey | keyof typeof POD_SETTINGS_HIDDEN | PodSettingsSecretKey
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
