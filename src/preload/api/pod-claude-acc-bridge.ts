// Fork-only (Pod): Settings' Claude accounts through claude-acc (src/main/pod/acc/acc-claude-accounts.ts).
import { ipcRenderer } from 'electron'
import type { PodClaudeAccResult, PodClaudeAccState } from '../../shared/pod-claude-acc-accounts'
import { POD_CLAUDE_ACC_IPC } from '../../shared/pod-claude-acc-accounts'

export type PodClaudeAccApi = {
  list: () => Promise<PodClaudeAccState>
  /** `claude-acc add`: the browser signs in a new account; resolves when the script ends. */
  add: () => Promise<PodClaudeAccResult>
  signInAgain: (email: string) => Promise<PodClaudeAccResult>
  switchTo: (email: string) => Promise<PodClaudeAccResult>
  /** Stops the open sign-in; false when none is open. */
  cancel: () => Promise<boolean>
}

export const podClaudeAccApi: PodClaudeAccApi = {
  list: () => ipcRenderer.invoke(POD_CLAUDE_ACC_IPC.list),
  add: () => ipcRenderer.invoke(POD_CLAUDE_ACC_IPC.add),
  signInAgain: (email) => ipcRenderer.invoke(POD_CLAUDE_ACC_IPC.signInAgain, email),
  switchTo: (email) => ipcRenderer.invoke(POD_CLAUDE_ACC_IPC.switchTo, email),
  cancel: () => ipcRenderer.invoke(POD_CLAUDE_ACC_IPC.cancel)
}
