// Fork-only (Pod): where each podSettings field sits in a native Settings window.
import type { PodSettingsKey } from './pod-settings-schema'

export type PodSettingsPage = {
  id:
    | 'general'
    | 'terminal'
    | 'agents'
    | 'browser'
    | 'notifications'
    | 'accounts'
    | 'git'
    | 'claude'
    | 'plugins'
    | 'advanced'
  title: string
  /** A page whose content comes from another RPC namespace (Accounts: `accounts.*`). */
  source?: string
  sections: readonly { title: string; keys: readonly PodSettingsKey[] }[]
}

/** Where each field sits in a native Settings window. */
export const POD_SETTINGS_PAGES: readonly PodSettingsPage[] = [
  {
    id: 'general',
    title: 'General',
    sections: [
      { title: 'Appearance', keys: ['theme', 'uiLanguage', 'showMenuBarIcon'] },
      {
        title: 'Agents',
        keys: [
          'defaultTuiAgent',
          'disabledTuiAgents',
          'agentStatusHooksEnabled',
          'agentWorkspaceTrustEnabled'
        ]
      },
      {
        title: 'Worktrees',
        keys: [
          'workspaceDir',
          'nestWorkspaces',
          'setupScriptLaunchMode',
          'experimentalPodNativeSearch'
        ]
      },
      {
        title: 'Behavior',
        keys: [
          'computerAwakeMode',
          'skipDeleteWorktreeConfirm',
          'skipCloseTerminalWithRunningProcessConfirm'
        ]
      },
      {
        title: 'Editor',
        keys: ['editorWordWrap', 'editorAutoSave', 'editorAutoSaveDelayMs', 'editorFontFamily']
      }
    ]
  },
  {
    id: 'terminal',
    title: 'Terminal',
    sections: [
      {
        title: 'Font',
        keys: [
          'terminalFontFamily',
          'terminalFontSize',
          'terminalFontWeight',
          'terminalFontWeightBold',
          'terminalLineHeight',
          'terminalLigatures'
        ]
      },
      {
        title: 'Cursor',
        keys: ['terminalCursorStyle', 'terminalCursorBlink', 'terminalCursorOpacity']
      },
      {
        title: 'Colors',
        keys: [
          'terminalThemeDark',
          'terminalUseSeparateLightTheme',
          'terminalThemeLight',
          'terminalBackgroundOpacity',
          'terminalMinimumContrastRatio',
          'terminalPaddingX',
          'terminalPaddingY'
        ]
      },
      {
        title: 'Panes',
        keys: [
          'terminalInactivePaneOpacity',
          'terminalActivePaneOpacity',
          'terminalDividerThicknessPx',
          'terminalDividerColorDark',
          'terminalDividerColorLight'
        ]
      },
      {
        title: 'Keyboard and mouse',
        keys: [
          'terminalMacOptionAsAlt',
          'terminalJISYenToBackslash',
          'terminalMouseHideWhileTyping',
          'terminalFocusFollowsMouse',
          'terminalWordSeparator',
          'terminalScrollSensitivity',
          'terminalFastScrollSensitivity',
          'terminalTuiScrollSensitivity',
          'terminalRightClickToPaste'
        ]
      },
      {
        title: 'Clipboard',
        keys: [
          'terminalClipboardOnSelect',
          'terminalCopyTrimsGutter',
          'terminalAllowOsc52Clipboard'
        ]
      },
      {
        title: 'Shell',
        keys: [
          'terminalDefaultShell',
          'terminalDefaultShellArgs',
          'terminalScrollbackRows',
          'terminalScopeHistoryByWorktree'
        ]
      },
      {
        title: 'Floating terminal',
        keys: ['floatingTerminalEnabled', 'floatingTerminalCwd']
      }
    ]
  },
  // Each agent's launch environment is a secret here: settings.get and settings.update carry it.
  {
    id: 'agents',
    title: 'Agents',
    sections: [
      { title: 'Launch', keys: ['agentCmdOverrides', 'agentDefaultArgs'] },
      { title: 'Prompt cache', keys: ['promptCacheTimerEnabled', 'promptCacheTtlMs'] },
      { title: 'Orchestration', keys: ['nestedWorkerMaxDepth'] },
      { title: 'Tabs', keys: ['tabAutoGenerateTitle'] },
      { title: 'Codex', keys: ['codexSessionSourceHome'] }
    ]
  },
  {
    id: 'browser',
    title: 'Browser',
    sections: [
      { title: 'Links', keys: ['openLinksInApp', 'openLinksInAppModifierInverts'] },
      {
        title: 'Terminal URL clicks',
        keys: ['terminalLinkClickBehavior', 'terminalUrlMiddleClickBehavior']
      }
    ]
  },
  {
    id: 'notifications',
    title: 'Notifications',
    sections: [{ title: 'Notifications', keys: ['notifications'] }]
  },
  { id: 'accounts', title: 'Accounts', source: 'accounts', sections: [] },
  {
    id: 'git',
    title: 'Git',
    sections: [
      {
        title: 'Branches',
        keys: [
          'branchPrefix',
          'branchPrefixCustom',
          'autoRenameBranchFromWork',
          'refreshLocalBaseRefOnWorktreeCreate'
        ]
      },
      { title: 'Performance', keys: ['gitTuning', 'gitTuningFsmonitor'] },
      {
        title: 'Worktrees',
        keys: [
          'alwaysForceDeleteWorktrees',
          'sourceControlCompareAgainstUpstream',
          'showGitIgnoredFiles',
          'followSymlinkedDirectories'
        ]
      },
      { title: 'AI', keys: ['sourceControlAi'] }
    ]
  },
  // Its own page: podMcpLazy.status lists the servers the setting picks from.
  {
    id: 'claude',
    title: 'Claude',
    source: 'podMcpLazy',
    sections: [{ title: 'MCP servers', keys: ['mcpLazyStart'] }]
  },
  // Its own page: plugins.* lists, installs and removes the plugins these switches let run.
  {
    id: 'plugins',
    title: 'Plugins',
    source: 'plugins',
    sections: [{ title: 'Plugins', keys: ['pluginSystemEnabled', 'thirdPartyPluginsEnabled'] }]
  },
  // The proxy URL can carry a password: podSettings.getNetworkProxy and setNetworkProxy, local only.
  {
    id: 'advanced',
    title: 'Advanced',
    sections: [
      { title: 'Network proxy', keys: ['httpProxyBypassRules'] },
      {
        title: 'Experimental',
        keys: ['experimentalTerminalAttention', 'nativeChatResumeWorkOnRestart']
      }
    ]
  }
]
