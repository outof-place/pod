// Fork-only (Pod): the composer's notice when main refused a chat send because no agent held the
// terminal (pty:writeAccepted with requireAgentForeground).
import { translate } from '@/i18n/i18n'

export function nativeChatAgentNotInForegroundNotice(reason: string): string {
  const notSent = translate(
    'components.native-chat.failureWords.writeFailed',
    "Orca couldn't hand this message to the agent, so it was not sent."
  )
  return `${notSent} (agent_not_in_foreground: ${reason})`
}
