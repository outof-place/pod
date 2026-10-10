import { toast } from 'sonner'
import type { PodOrbstackActionResult } from '../../../../shared/pod-orbstack-types'
import { extractIpcErrorMessage } from '@/lib/ipc-error'

/** Runs one OrbStack action, reports a failure as a toast, then re-reads the status. */
export async function runPodOrbstackAction(
  action: () => Promise<PodOrbstackActionResult> | undefined,
  refresh: () => Promise<void>
): Promise<boolean> {
  let ok = false
  try {
    const result = await action()
    if (result && !result.ok) {
      toast.error(result.error)
    }
    ok = result?.ok === true
  } catch (caught) {
    toast.error(extractIpcErrorMessage(caught, String(caught)))
  } finally {
    await refresh()
  }
  return ok
}
