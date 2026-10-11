import { toast } from 'sonner'
import type { PodOrbstackActionResult } from '../../../../shared/pod-orbstack-types'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { translate } from '@/i18n/i18n'

/**
 * Runs one OrbStack action, reports a failure as a toast, then re-reads the status. A machine
 * OrbStack gave no address gets a Restart OrbStack action on its toast.
 */
export async function runPodOrbstackAction(
  action: () => Promise<PodOrbstackActionResult>,
  refresh: () => Promise<void>,
  onRestart?: () => void
): Promise<boolean> {
  let ok = false
  try {
    const result = await action()
    if (!result.ok) {
      toast.error(
        result.error,
        result.reason === 'out-of-addresses' && onRestart
          ? {
              duration: 15_000,
              action: {
                label: translate('podOrbstack.restart.action', 'Restart OrbStack…'),
                onClick: onRestart
              }
            }
          : undefined
      )
    }
    ok = result.ok
  } catch (caught) {
    toast.error(extractIpcErrorMessage(caught, String(caught)))
  } finally {
    await refresh()
  }
  return ok
}
