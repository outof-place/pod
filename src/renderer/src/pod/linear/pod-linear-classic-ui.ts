// Fork-only (Pod): the classic window has no Linear in a Pod build; PodNative is Linear's only UI.
// The renderer's Linear client stops here, before any IPC or RPC, whatever podLinear and the key say.
import { POD_LINEAR_CLASSIC_UI } from '../../../../shared/product/features'
import type { LinearConnectionStatus } from '../../../../shared/linear/workspace-types'

export const POD_LINEAR_CLASSIC_UI_OFF_MESSAGE =
  "Pod's window has no Linear. Use Linear in PodNative."

/** What linearStatus answers in a Pod build: not connected, Linear off. Null when the UI is in. */
export function podLinearClassicUiOffStatus(): LinearConnectionStatus | null {
  return POD_LINEAR_CLASSIC_UI
    ? null
    : { connected: false, viewer: null, available: false, reason: 'feature-off' }
}

export function assertPodLinearClassicUi(): void {
  if (!POD_LINEAR_CLASSIC_UI) {
    throw new Error(POD_LINEAR_CLASSIC_UI_OFF_MESSAGE)
  }
}
