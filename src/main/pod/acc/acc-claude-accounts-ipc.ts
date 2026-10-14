// Fork-only (Pod): the IPC for Settings' claude-acc Claude accounts; nothing in upstream Orca.
import { ipcMain } from 'electron'
import { POD_CLAUDE_ACC_IPC } from '../../../shared/pod-claude-acc-accounts'
import { getProductIdentity } from '../../product-identity/product-identity'
import { PodClaudeAccAccounts } from './acc-claude-accounts'

export function registerPodClaudeAccHandlers(accounts = new PodClaudeAccAccounts()): void {
  if (!getProductIdentity()) {
    return
  }
  ipcMain.handle(POD_CLAUDE_ACC_IPC.list, () => accounts.list())
  ipcMain.handle(POD_CLAUDE_ACC_IPC.add, () => accounts.add())
  ipcMain.handle(POD_CLAUDE_ACC_IPC.signInAgain, (_event, email: unknown) =>
    accounts.signInAgain(String(email))
  )
  ipcMain.handle(POD_CLAUDE_ACC_IPC.switchTo, (_event, email: unknown) =>
    accounts.switchTo(String(email))
  )
  ipcMain.handle(POD_CLAUDE_ACC_IPC.cancel, () => accounts.cancel())
}
