import type { PodUiHostQuitBlockers } from '../../shared/pod-ui-host-quit'
import type { PodUiHostSurfaceNavigation } from '../../shared/pod-ui-host-surface'

/** Fork-only (Pod): one-app's quit questions from main (src/shared/pod-ui-host-quit.ts). */
export type PodUiHostApi = {
  /** Answers main's "what would a quit lose?"; returns the unsubscribe. */
  onQuitAssess: (assess: () => Promise<PodUiHostQuitBlockers>) => () => void
  /** The session is restored: a surface the headless runtime opened this window for can go on. */
  surfaceReady: () => void
  /** Where in a surface PodNative asked for; returns the unsubscribe. */
  onSurfaceNavigate: (navigate: (navigation: PodUiHostSurfaceNavigation) => void) => () => void
}
