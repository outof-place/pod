import { describe, expect, it } from 'vitest'
import { POD_SETTINGS_HIDDEN } from './pod-settings-classification'
import { POD_SETTINGS_PAGES } from './pod-settings-pages'

// A page row is a promise that the setting does something in PodNative. A key joins this list only
// once PodNative (or the runtime, for what it launches or routes) applies it: check with
// `rg '<key>' PodNative/Sources` and the runtime before adding one.
const APPLIED_FOR_PODNATIVE = [
  // General
  'theme',
  'uiLanguage',
  'showMenuBarIcon',
  'defaultTuiAgent',
  'disabledTuiAgents',
  'agentStatusHooksEnabled',
  'agentWorkspaceTrustEnabled',
  'workspaceDir',
  'nestWorkspaces',
  'setupScriptLaunchMode',
  'experimentalPodNativeSearch',
  'computerAwakeMode',
  'skipDeleteWorktreeConfirm',
  'skipCloseTerminalWithRunningProcessConfirm',
  'editorWordWrap',
  'editorAutoSave',
  'editorAutoSaveDelayMs',
  'editorFontFamily',
  // Terminal
  'terminalFontFamily',
  'terminalFontSize',
  'terminalFontWeight',
  'terminalFontWeightBold',
  'terminalLineHeight',
  'terminalCursorStyle',
  'terminalCursorBlink',
  'terminalCursorOpacity',
  'terminalThemeDark',
  'terminalUseSeparateLightTheme',
  'terminalThemeLight',
  'terminalBackgroundOpacity',
  'terminalMinimumContrastRatio',
  'terminalPaddingX',
  'terminalPaddingY',
  'terminalInactivePaneOpacity',
  'terminalActivePaneOpacity',
  'terminalDividerThicknessPx',
  'terminalDividerColorDark',
  'terminalDividerColorLight',
  'terminalMacOptionAsAlt',
  'terminalJISYenToBackslash',
  'terminalMouseHideWhileTyping',
  'terminalFocusFollowsMouse',
  'terminalWordSeparator',
  'terminalScrollSensitivity',
  'terminalFastScrollSensitivity',
  'terminalTuiScrollSensitivity',
  'terminalRightClickToPaste',
  'terminalClipboardOnSelect',
  'terminalCopyTrimsGutter',
  'terminalAllowOsc52Clipboard',
  'terminalDefaultShell',
  'terminalDefaultShellArgs',
  'terminalScrollbackRows',
  'terminalScopeHistoryByWorktree',
  'floatingTerminalEnabled',
  'floatingTerminalCwd',
  // Agents: the runtime applies these when it launches an agent
  'agentCmdOverrides',
  'agentDefaultArgs',
  'codexSessionSourceHome',
  'promptCacheTimerEnabled',
  'promptCacheTtlMs',
  'nestedWorkerMaxDepth',
  'tabAutoGenerateTitle',
  // Browser: PodNative's link handling reads them
  'openLinksInApp',
  'openLinksInAppModifierInverts',
  // Notifications, Git, Claude
  'notifications',
  'branchPrefix',
  'branchPrefixCustom',
  'autoRenameBranchFromWork',
  'refreshLocalBaseRefOnWorktreeCreate',
  'gitTuning',
  'gitTuningFsmonitor',
  'alwaysForceDeleteWorktrees',
  'sourceControlCompareAgainstUpstream',
  'showGitIgnoredFiles',
  'followSymlinkedDirectories',
  'sourceControlAi',
  'mcpLazyStart',
  // Plugins: discovery follows them (main-process-plugins.ts)
  'pluginSystemEnabled',
  'thirdPartyPluginsEnabled',
  // Advanced: the runtime's proxy applies it
  'httpProxyBypassRules',
  // Experimental: PodNative's pane highlight (pn-acc's PN branch, landed in a pair)
  'experimentalTerminalAttention',
  // Experimental: PodNative's resume-on-restart prompt (pn-acc's PN branch, landed in a pair)
  'nativeChatResumeWorkOnRestart'
]

describe('podSettings pages', () => {
  const placed: string[] = POD_SETTINGS_PAGES.flatMap((page) =>
    page.sections.flatMap((section) => section.keys)
  )

  it('offers only settings PodNative applies', () => {
    expect(placed.filter((key) => !APPLIED_FOR_PODNATIVE.includes(key))).toEqual([])
  })

  it('keeps no stale entry in the applied list', () => {
    expect(APPLIED_FOR_PODNATIVE.filter((key) => !placed.includes(key))).toEqual([])
  })

  it('has no page or section with nothing in it', () => {
    for (const page of POD_SETTINGS_PAGES) {
      if (page.source === undefined) {
        expect(page.sections, page.id).not.toHaveLength(0)
      }
      for (const section of page.sections) {
        expect(section.keys, `${page.id}/${section.title}`).not.toHaveLength(0)
      }
    }
  })

  it('keeps the settings nobody applies yet hidden as later', () => {
    for (const key of [
      'ctrlTabOrderMode',
      'confirmClosePinnedTab',
      'skipDeleteAutomationConfirm',
      'skipDeleteArtifactConfirm',
      'skipCodexRateLimitResetConfirm',
      'terminalShortcutPolicy',
      'primarySelectionMiddleClickPaste',
      'openInApplications',
      'experimentalAgentHibernation',
      'agentHibernationIdleMs',
      'experimentalActivity',
      // The chat UI and its shell environment stay the desktop's: the variables can hold secrets.
      'experimentalNativeChat',
      'nativeChatInheritShellEnvironment',
      'nativeChatShellEnvironmentVariables'
    ]) {
      expect(Reflect.get(POD_SETTINGS_HIDDEN, key), key).toBe('later')
    }
  })
})
