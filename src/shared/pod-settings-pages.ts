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
    | 'advanced'
    | 'experimental'
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
        title: 'Tabs',
        keys: ['ctrlTabOrderMode', 'confirmClosePinnedTab', 'tabAutoGenerateTitle']
      },
      {
        title: 'Behavior',
        keys: [
          'computerAwakeMode',
          'skipDeleteWorktreeConfirm',
          'skipCloseTerminalWithRunningProcessConfirm',
          'skipDeleteAutomationConfirm',
          'skipDeleteArtifactConfirm',
          'skipCodexRateLimitResetConfirm'
        ]
      },
      { title: 'Open In', keys: ['openInApplications'] },
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
          'terminalLineHeight'
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
        title: 'Keyboard and mouse',
        keys: [
          'terminalMacOptionAsAlt',
          'terminalJISYenToBackslash',
          'terminalMouseHideWhileTyping',
          'terminalFocusFollowsMouse',
          'terminalWordSeparator',
          'terminalShortcutPolicy'
        ]
      },
      {
        title: 'Scrolling',
        keys: [
          'terminalScrollSensitivity',
          'terminalFastScrollSensitivity',
          'terminalTuiScrollSensitivity'
        ]
      },
      {
        title: 'Clipboard',
        keys: [
          'terminalClipboardOnSelect',
          'terminalCopyTrimsGutter',
          'terminalAllowOsc52Clipboard',
          'primarySelectionMiddleClickPaste'
        ]
      },
      {
        title: 'Split panes',
        keys: [
          'terminalInactivePaneOpacity',
          'terminalActivePaneOpacity',
          'terminalDividerThicknessPx',
          'terminalDividerColorDark',
          'terminalDividerColorLight'
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
      { title: 'Codex', keys: ['codexSessionSourceHome'] }
    ]
  },
  {
    id: 'browser',
    title: 'Browser',
    sections: [{ title: 'Links', keys: ['openLinksInApp', 'openLinksInAppModifierInverts'] }]
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
  // The proxy URL can carry a password: podSettings.getNetworkProxy and setNetworkProxy, local only.
  {
    id: 'advanced',
    title: 'Advanced',
    sections: [{ title: 'Network proxy', keys: ['httpProxyBypassRules'] }]
  },
  {
    id: 'experimental',
    title: 'Experimental',
    sections: [
      {
        title: 'Experimental',
        keys: [
          'experimentalTerminalAttention',
          'experimentalAgentHibernation',
          'agentHibernationIdleMs',
          'experimentalActivity'
        ]
      }
    ]
  }
]
