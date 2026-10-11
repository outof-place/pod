// Fork-only (Pod): one-app hooks for the main window, its tray icon and its notification clicks.
import { app, BrowserWindow } from 'electron'
import { publishHeadlessRuntimeGraph } from '../../runtime/headless-runtime-graph'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { rearmPodHeadlessWindowServices } from './pod-headless-window-services'
import { sendToPodUi } from './pod-ui-host-bridge'
import { isPodHeadlessUiHost, isPodUiHostLaunch } from './pod-ui-host-launch'

/** Hands the foreground back; with no window left macOS activates the app before (PodNative). */
function yieldForeground(): void {
  if (!BrowserWindow.getAllWindows().some((other) => other.isVisible())) {
    app.hide()
  }
  sendToPodUi({ type: 'surfaceHidden' })
}

/** One-app close: the window hides, so its renderer keeps serving PodNative; true when it hid. */
export function hidePodUiHostWindowOnClose(
  window: Pick<BrowserWindow, 'hide' | 'isDestroyed'>,
  quitting: boolean
): boolean {
  // The headless runtime closes it for real: its renderer goes with it.
  if (quitting || !isPodUiHostLaunch() || isPodHeadlessUiHost() || window.isDestroyed()) {
    return false
  }
  window.hide()
  yieldForeground()
  return true
}

/** Headless one-app: once the window is gone, the runtime's own graph serves PodNative again. */
export function notePodHeadlessWindowClosed(
  runtime: Pick<OrcaRuntimeService, 'syncWindowGraph'>
): void {
  if (!isPodHeadlessUiHost()) {
    return
  }
  publishHeadlessRuntimeGraph(runtime)
  rearmPodHeadlessWindowServices()
  yieldForeground()
}

/** Headless one-app: a user Quit (menu, Cmd-Q, a native terminate) quits Pod, so PodNative asks
 *  for it; true when it was told. Without PodNative the serve host closes its windows instead. */
export function requestPodHeadlessQuit(): boolean {
  return isPodHeadlessUiHost() && sendToPodUi({ type: 'quitRequested', reason: 'user' })
}

/** One-app: PodNative shows the notification's tab; true when it took the click. */
export function forwardPodUiHostNotificationClick(target: {
  worktreeId: string
  tabId?: string
  leafId?: string
}): boolean {
  return isPodUiHostLaunch() && sendToPodUi({ type: 'activate', ...target })
}
