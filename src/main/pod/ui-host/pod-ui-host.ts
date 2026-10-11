// Fork-only (Pod): the runtime side of one-app mode. PodNative attaches over the control socket,
// asks for fallback surfaces, forwards what macOS opened that only this runtime handles, and quits
// Pod through it. This runtime tells it when Pod should quit, what the Dock badge says and when to
// come forward.
import { appendFileSync, existsSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { app, powerMonitor, shell } from 'electron'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import { getCanonicalUserDataPath } from '../../persistence/loading-store/user-data-path'
import { productUrlSchemes } from '../../product-identity/product-identity'
import { readRuntimeMetadata } from '../../runtime/runtime-metadata'
import {
  openSettingsFromSystemMenu,
  showMainWindowFromTray
} from '../../startup/main-window-actions'
import { isProcessQuitRequested, quitProcess } from '../../startup/process-quit-request'
import { mainProcessState as state } from '../../startup/main-process-state'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { isBackgroundLaunch } from '../../window/foreground-activation-policy'
import { installPodBrowserPanes } from '../browser-pane/pod-browser-pane-host'
import type { PodBrowserPaneController } from '../browser-pane/pod-browser-pane'
import { loadPodPeerVerifier, podPeerIdentityAddonPath } from './pod-peer-identity'
import { setPodUiHostSink } from './pod-ui-host-bridge'
import {
  isPodHeadlessUiHost,
  isPodUiHostLaunch,
  podUiHostOuterApp,
  POD_UI_HOST_SWITCH
} from './pod-ui-host-launch'
import { PodUiHostLazyWindow } from './pod-ui-host-lazy-window'
import { installPodHeadlessAgentStatus } from './pod-headless-agent-status'
import { PodUiHostQuitFlow } from './pod-ui-host-quit'
import { assessRendererQuit, commitRendererQuit } from './pod-ui-host-quit-renderer'
import {
  POD_UI_HOST_DIRECTORY_NAME,
  POD_UI_HOST_SOCKET_NAME,
  type PodUiHostOpenSurface,
  type PodUiHostSecondInstance
} from './pod-ui-host-protocol'
import { PodUiHostServer } from './pod-ui-host-server'
import {
  podUiHostSurfaceNavigation,
  sendPodUiHostSurfaceNavigation
} from './pod-ui-host-surface-navigation'
import { podSurfaceFocusChannel, type PodUiHostSessionSource } from './pod-ui-host-surface-tab'

// Long enough for "Pod quit unexpectedly" → Reopen to find this runtime still up.
const NO_UI_GRACE_MS = 60_000

let installed = false
let sessions: PodUiHostSessionSource | null = null

function readToken(): string | null {
  try {
    return readRuntimeMetadata(getCanonicalUserDataPath())?.authToken ?? null
  } catch {
    return null
  }
}

function openSurface(request: PodUiHostOpenSurface): boolean {
  const window = state.mainWindow
  const navigation = podUiHostSurfaceNavigation(request)
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
      const channel = podSurfaceFocusChannel(sessions, worktreeId, tabId)
      // The user's click: an agent tab of a worktree not yet active still shows.
      window.webContents.send(
        channel,
        channel === 'ui:focusEditorTab'
          ? { tabId, worktreeId, userInitiated: true }
          : { tabId, worktreeId }
      )
    }
  }
  sendPodUiHostSurfaceNavigation(state.mainWindow, navigation)
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

/** Only Pod's own URL schemes and existing absolute files go on; null when nothing is left. */
export function admitSecondInstance(
  request: PodUiHostSecondInstance,
  schemes: readonly string[]
): string[] | null {
  const urls = request.urls.filter((url) => {
    try {
      return schemes.includes(new URL(url).protocol.replace(/:$/, ''))
    } catch {
      return false
    }
  })
  const files = request.files.filter((file) => {
    try {
      return isAbsolute(file) && existsSync(file) && statSync(file).isFile()
    } catch {
      return false
    }
  })
  const admitted = [...urls, ...files]
  return admitted.length > 0 ? admitted : null
}

/** Starts the control socket in a one-app launch; a no-op in every other launch. */
export function installPodUiHost(
  runtime: Pick<OrcaRuntimeService, 'setOffscreenBrowserBackend'>,
  workspaceSessions?: PodUiHostSessionSource
): void {
  if (installed || !isPodUiHostLaunch()) {
    return
  }
  installed = true
  sessions = workspaceSessions ?? null
  let graceTimer: ReturnType<typeof setTimeout> | null = null
  let quitAskedByUi = false
  let systemShutdown = false
  let forwardingSecondInstance = false
  // POD_UI_HOST_LOG=<file>: a runtime LaunchServices started has no stdout; E2Es read this instead.
  const logFile = process.env.POD_UI_HOST_LOG
  const log = (message: string): void => {
    console.log(`[pod] ${message}`)
    if (logFile) {
      try {
        appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`)
      } catch {
        // A log that can't be written is no reason to stop.
      }
    }
  }
  const clearGrace = (): void => {
    if (graceTimer) {
      clearTimeout(graceTimer)
      graceTimer = null
    }
  }
  const addonPath = podPeerIdentityAddonPath({
    resourcesPath: typeof process.resourcesPath === 'string' ? process.resourcesPath : null,
    appPath: app.getAppPath(),
    isPackaged: app.isPackaged
  })
  const verifyPeer = loadPodPeerVerifier(addonPath)
  // Set below, once the server exists: the panes answer through it.
  let panes: PodBrowserPaneController | null = null
  if (!verifyPeer) {
    log('ui-host: no peer identity check (addon missing); the control socket admits no one')
  }
  const server = new PodUiHostServer({
    socketPath: join(
      getCanonicalUserDataPath(),
      POD_UI_HOST_DIRECTORY_NAME,
      POD_UI_HOST_SOCKET_NAME
    ),
    readToken,
    verifyPeer,
    pid: process.pid,
    log,
    onOpenSurface: (request) => showSurface(request),
    onSecondInstance: (request) => {
      const argv = admitSecondInstance(request, productUrlSchemes())
      if (!argv) {
        log('ui-host: refused a forwarded launch with no Pod URL or existing file')
        return
      }
      // The path a second launch of this app takes: deep links and documents reach the renderer.
      forwardingSecondInstance = true
      app.emit('second-instance', { preventDefault: () => {} }, [process.execPath, ...argv], '')
      forwardingSecondInstance = false
      showSurface({ type: 'openSurface', surface: 'window' })
    },
    onBrowser: (message) => panes?.handle(message),
    headless: isPodHeadlessUiHost(),
    onQuit: ({ reason, confirmed, version }) => {
      log(`ui-host: PodNative asked to quit (${reason}${confirmed ? ', confirmed' : ''})`)
      if (version < 2) {
        panes?.reset()
        quitAskedByUi = true
        state.isQuitting = true
        quitProcess()
        return
      }
      void quitFlow.request(reason, confirmed)
    },
    onUiPresence: (attached) => {
      // A new PodNative hands over its own receiver; a gone one takes nothing with it.
      panes?.reset()
      clearGrace()
      if (attached || state.isQuitting) {
        return
      }
      // PodNative went away without quitting (a crash): keep the runtime for a reopen, then go.
      graceTimer = setTimeout(() => {
        graceTimer = null
        if (!server.attached && !state.mainWindow?.isVisible()) {
          log('ui-host: no PodNative came back; quitting')
          state.isQuitting = true
          quitProcess()
        }
      }, NO_UI_GRACE_MS)
      graceTimer.unref?.()
    }
  })
  const quitFlow = new PodUiHostQuitFlow({
    assess: () => assessRendererQuit(state.mainWindow),
    runningAgents: () => state.agentAwakeService?.getWorkingAgentCount() ?? 0,
    commit: () => {
      panes?.reset()
      quitAskedByUi = true
      state.isQuitting = true
      server.noteQuitCommitted()
      commitRendererQuit(state.mainWindow, () => {
        quitAskedByUi = false
        server.noteQuitAborted()
        quitFlow.aborted('the session could not be saved')
      })
      quitProcess()
    },
    send: (message) => server.send(message),
    log
  })
  const present = (request: PodUiHostOpenSurface): void => {
    const visible = openSurface(request)
    server.send({ type: 'surfaceShown', surface: request.surface, visible })
  }
  // The headless runtime has no window until a surface needs one (pod-ui-host-lazy-window.ts).
  const lazyWindow = isPodHeadlessUiHost()
    ? new PodUiHostLazyWindow<PodUiHostOpenSurface>({
        getWindow: () => state.mainWindow,
        canOpen: () =>
          !state.isQuitting &&
          (state.desktopActivationGate === null ||
            state.desktopActivationGate.getState() === 'ready'),
        openWindow: showMainWindowFromTray,
        present,
        refuse: (request) =>
          server.send({ type: 'surfaceShown', surface: request.surface, visible: false }),
        log
      })
    : null
  const showSurface = (request: PodUiHostOpenSurface): void =>
    lazyWindow ? lazyWindow.request(request) : present(request)
  const uninstallAgentStatus = lazyWindow ? installPodHeadlessAgentStatus() : null
  setPodUiHostSink(server)
  panes = installPodBrowserPanes({
    runtime,
    addonPath,
    send: (message) => server.send(message),
    log
  })
  powerMonitor.on('shutdown', () => {
    systemShutdown = true
  })
  // Why: a Quit in a fallback window, logout or a signal quits this process; PodNative quits with
  // it instead of restarting a runtime it thinks crashed.
  app.on('before-quit', () => {
    // An unmarked quit of the headless runtime is vetoed; the veto tells PodNative itself.
    const vetoed = isPodHeadlessUiHost() && !isProcessQuitRequested()
    if (!quitAskedByUi && !vetoed) {
      server.send({ type: 'quitRequested', reason: systemShutdown ? 'system' : 'user' })
    }
  })
  // A reopen or second launch of this helper (Spotlight, `open -b`, the CLI) means "show Pod".
  app.on('second-instance', () => {
    if (!forwardingSecondInstance) {
      server.send({ type: 'activate' })
    }
  })
  app.on('activate', () => server.send({ type: 'activate' }))
  app.once('will-quit', () => {
    clearGrace()
    lazyWindow?.dispose()
    uninstallAgentStatus?.()
    setPodUiHostSink(null)
    // Why: a committed quit keeps its connection for the heartbeat through teardown (up to 20 s).
    if (quitFlow.isCommitted) {
      server.stopListening()
    } else {
      server.close()
    }
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
