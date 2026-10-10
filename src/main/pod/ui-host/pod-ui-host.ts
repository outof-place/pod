// Fork-only (Pod): the runtime side of one-app mode. PodNative attaches over the control socket,
// asks for fallback surfaces and quits Pod through it; this runtime tells it when the user quit a
// fallback window, what the Dock badge says and which tab a notification click wants.
import { join } from 'node:path'
import { app, shell } from 'electron'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import { getCanonicalUserDataPath } from '../../persistence/loading-store/user-data-path'
import { readRuntimeMetadata } from '../../runtime/runtime-metadata'
import { openSettingsFromSystemMenu } from '../../startup/main-window-actions'
import { mainProcessState as state } from '../../startup/main-process-state'
import { isBackgroundLaunch } from '../../window/foreground-activation-policy'
import { setPodUiHostSink } from './pod-ui-host-bridge'
import { isPodUiHostLaunch, podUiHostOuterApp, POD_UI_HOST_SWITCH } from './pod-ui-host-launch'
import { POD_UI_HOST_SOCKET_NAME, type PodUiHostShowRequest } from './pod-ui-host-protocol'
import { PodUiHostServer } from './pod-ui-host-server'

// Long enough for "Pod quit unexpectedly" → Reopen to find this runtime still up.
const NO_UI_GRACE_MS = 60_000

let installed = false

function readToken(): string | null {
  try {
    return readRuntimeMetadata(getCanonicalUserDataPath())?.authToken ?? null
  } catch {
    return null
  }
}

function show(request: PodUiHostShowRequest): boolean {
  const window = state.mainWindow
  if (request.surface === 'settings') {
    // Also opens the window when a renderer recovery left none.
    openSettingsFromSystemMenu()
  } else if (window && !window.isDestroyed() && request.worktreeId) {
    const { worktreeId, tabId } = request
    if (worktreeId.includes('::')) {
      window.webContents.send('ui:activateWorktree', {
        repoId: getRepoIdFromWorktreeId(worktreeId),
        worktreeId
      })
    }
    if (tabId) {
      window.webContents.send('ui:focusTerminal', { tabId, worktreeId })
    }
  }
  const target = state.mainWindow
  // Why: automated launches never take the screen (AGENTS.md); the request is still navigated.
  if (!target || target.isDestroyed() || isBackgroundLaunch()) {
    return false
  }
  app.show()
  if (target.isMinimized()) {
    target.restore()
  }
  target.show()
  // PodNative yielded activation before asking (cooperative activation, macOS 14+).
  app.focus({ steal: true })
  return true
}

/** Starts the control socket in a one-app launch; a no-op in every other launch. */
export function installPodUiHost(): void {
  if (installed || !isPodUiHostLaunch()) {
    return
  }
  installed = true
  let graceTimer: ReturnType<typeof setTimeout> | null = null
  let quitAskedByUi = false
  const clearGrace = (): void => {
    if (graceTimer) {
      clearTimeout(graceTimer)
      graceTimer = null
    }
  }
  const server = new PodUiHostServer({
    socketPath: join(getCanonicalUserDataPath(), POD_UI_HOST_SOCKET_NAME),
    readToken,
    pid: process.pid,
    log: (message) => console.log(`[pod] ${message}`),
    onShow: (request) => {
      const visible = show(request)
      server.send({ type: 'shown', surface: request.surface, visible })
    },
    onQuit: () => {
      quitAskedByUi = true
      state.isQuitting = true
      app.quit()
    },
    onUiPresence: (attached) => {
      clearGrace()
      if (attached || state.isQuitting) {
        return
      }
      // PodNative went away without quitting (a crash): keep the runtime for a reopen, then go.
      graceTimer = setTimeout(() => {
        graceTimer = null
        if (!server.attached && !state.mainWindow?.isVisible()) {
          console.log('[pod] ui-host: no PodNative came back; quitting')
          state.isQuitting = true
          app.quit()
        }
      }, NO_UI_GRACE_MS)
      graceTimer.unref?.()
    }
  })
  setPodUiHostSink(server)
  // Why: a fallback window's Quit, logout or an update quits this process; PodNative quits with it
  // instead of restarting a runtime it thinks crashed.
  app.on('before-quit', () => {
    if (!quitAskedByUi) {
      server.send({ type: 'quitRequested' })
    }
  })
  app.once('will-quit', () => {
    clearGrace()
    setPodUiHostSink(null)
    server.close()
  })
  void server.start().then((listening) => {
    // Started without PodNative (a login item, `open -b`, the CLI): bring up the app around it,
    // which finds this runtime and attaches instead of starting another.
    const outer = podUiHostOuterApp()
    if (listening && outer && !process.argv.includes(POD_UI_HOST_SWITCH) && !isBackgroundLaunch()) {
      void shell.openPath(outer)
    }
  })
}
