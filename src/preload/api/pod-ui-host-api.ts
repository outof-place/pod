import type { PodUiHostQuitBlockers } from '../../shared/pod-ui-host-quit'

/** Fork-only (Pod): one-app's quit questions from main (src/shared/pod-ui-host-quit.ts). */
export type PodUiHostApi = {
  /** Answers main's "what would a quit lose?"; returns the unsubscribe. */
  onQuitAssess: (assess: () => Promise<PodUiHostQuitBlockers>) => () => void
}
