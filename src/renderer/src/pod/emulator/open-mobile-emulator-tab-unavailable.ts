import { MOBILE_EMULATOR_UNAVAILABLE_MESSAGE } from '@/lib/client-creation-action-policy'

/**
 * Fork-only (Pod): the upstream emulator is cut. Pod's creation policy already hid it, and the
 * upstream opener threw this message first; the tab system's callers keep it until wave 3.
 */
export async function openMobileEmulatorTab(
  _worktreeId: string,
  _options: { targetGroupId?: string; placement?: 'activeGroup' | 'rightSplit' } = {}
): Promise<string | null> {
  throw new Error(MOBILE_EMULATOR_UNAVAILABLE_MESSAGE)
}
