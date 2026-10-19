// Fork-only (Pod): a Claude sign-in offered outside Settings runs `claude-acc add`, the only way
// Pod adds a Claude account. English only, as Settings' claude-acc section.
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

/** True once claude-acc saved the account; a failure says why in a toast, a cancel says nothing. */
export async function addClaudeAccAccount(): Promise<boolean> {
  try {
    const result = await window.api.podClaudeAcc.add()
    if (!result.ok && !result.cancelled) {
      toast.error(translate('podClaudeAcc.signIn.failed', 'Claude sign-in failed.'), {
        description: result.message
      })
    }
    return result.ok
  } catch (error) {
    toast.error(translate('podClaudeAcc.signIn.failed', 'Claude sign-in failed.'), {
      description: error instanceof Error ? error.message : String(error)
    })
    return false
  }
}
