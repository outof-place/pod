// Fork-only (Pod): one-app hooks for the main window, its tray icon and its notification clicks.
import { app, BrowserWindow } from 'electron'
import { sendToPodUi } from './pod-ui-host-bridge'
import { isPodUiHostLaunch } from './pod-ui-host-launch'

/** One-app close: the window hides, so its renderer keeps serving PodNative; true when it hid. */
export function hidePodUiHostWindowOnClose(window: BrowserWindow, quitting: boolean): boolean {
  if (quitting || !isPodUiHostLaunch() || window.isDestroyed()) {
    return false
  }
  window.hide()
  // Why: hands the foreground back; with no window left macOS activates the app before (PodNative).
  if (!BrowserWindow.getAllWindows().some((other) => other.isVisible())) {
    app.hide()
  }
  sendToPodUi({ type: 'hidden' })
  return true
}

/** One-app: PodNative shows the notification's tab; true when it took the click. */
export function forwardPodUiHostNotificationClick(target: {
  worktreeId: string
  tabId?: string
  leafId?: string
}): boolean {
  return isPodUiHostLaunch() && sendToPodUi({ type: 'focus', ...target })
}
