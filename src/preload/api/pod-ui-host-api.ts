import type { PodUiHostQuitBlockers } from '../../shared/pod-ui-host-quit'
import type { PodUiHostSurfaceNavigation } from '../../shared/pod-ui-host-surface'
import type { PodUiHostPaneRestartRequest } from '../../shared/pod-ui-host-pane-restart'
import type {
  PodUiHostPaneLayoutReply,
  PodUiHostPaneLayoutRequest
} from '../../shared/pod-ui-host-pane-layout'

/** Fork-only (Pod): one-app's quit questions from main (src/shared/pod-ui-host-quit.ts). */
export type PodUiHostApi = {
  /** Answers main's "what would a quit lose?"; returns the unsubscribe. */
  onQuitAssess: (assess: () => Promise<PodUiHostQuitBlockers>) => () => void
  /** The session is restored: a surface the headless runtime opened this window for can go on. */
  surfaceReady: () => void
  /** Where in a surface PodNative asked for; returns the unsubscribe. */
  onSurfaceNavigate: (navigate: (navigation: PodUiHostSurfaceNavigation) => void) => () => void
  /** Before Close Terminals stops this window's panes: the worktree is going to sleep. */
  beginRuntimeSleep: (worktreeId: string) => void
  /** After: the runtime sleeps the worktree's PTYs no pane here bound, and holds it asleep. */
  sleepRuntimeTerminals: (worktreeId: string) => Promise<void>
  /** Restart for a failed shell's pane PodNative asked for; returns the unsubscribe. */
  onPaneRestart: (restart: (request: PodUiHostPaneRestartRequest) => boolean) => () => void
  /** A failed shell's pane main kept, whose agent must not resume; returns the unsubscribe. */
  onPaneExitRetained: (retained: (pane: PodUiHostPaneRestartRequest) => void) => () => void
  /** A pane layout PodNative sent for a tab here; returns the unsubscribe. */
  onPaneLayout: (
    apply: (request: PodUiHostPaneLayoutRequest) => PodUiHostPaneLayoutReply
  ) => () => void
}
