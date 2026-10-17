// Fork-only (Pod): session.tabs.restartTerminal, Restart on a failed local shell's kept pane.
import { z } from 'zod'
import { WorktreeTabSelector } from './session-tabs-schemas-params'

export const SessionTabsRestartTerminalParams = WorktreeTabSelector.extend({
  tabId: z.string().min(1, 'Missing tab id').max(256),
  leafId: z.string().max(128).optional()
}).strict()
