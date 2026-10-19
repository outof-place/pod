// Fork-only (Pod): the composer's notice when main refused a chat send because no agent held the
// terminal (pty:writeAccepted with requireAgentForeground).
import { translate } from '@/i18n/i18n'

export function nativeChatAgentNotInForegroundNotice(reason: string): string {
  return translate(
    'podPasteGuard.refused',
    "Not sent: the agent isn't in front in this terminal ({{reason}})",
    { reason }
  )
}
