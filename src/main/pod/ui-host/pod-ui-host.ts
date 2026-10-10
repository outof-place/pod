// Fork-only (Pod): the runtime side of one-app mode. PodNative attaches over the control socket,
// asks for fallback surfaces, forwards what macOS opened that only this runtime handles, and quits
// Pod through it. This runtime tells it when Pod should quit, what the Dock badge says and when to
// come forward.
import { existsSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { app, powerMonitor, shell } from 'electron'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import { getCanonicalUserDataPath } from '../../persistence/loading-store/user-data-path'
import { productUrlSchemes } from '../../product-identity/product-identity'
import { readRuntimeMetadata } from '../../runtime/runtime-metadata'
import { openSettingsFromSystemMenu } from '../../startup/main-window-actions'
import { mainProcessState as state } from '../../startup/main-process-state'
import { isBackgroundLaunch } from '../../window/foreground-activation-policy'
import { loadPodPeerVerifier, podPeerIdentityAddonPath } from './pod-peer-identity'
import { setPodUiHostSink } from './pod-ui-host-bridge'
import { isPodUiHostLaunch, podUiHostOuterApp, POD_UI_HOST_SWITCH } from './pod-ui-host-launch'
import {
  POD_UI_HOST_DIRECTORY_NAME,
  POD_UI_HOST_SOCKET_NAME,
  type PodUiHostOpenSurface,
  type PodUiHostSecondInstance
} from './pod-ui-host-protocol'
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

function openSurface(request: PodUiHostOpenSurface): boolean {
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
export function installPodUiHost(): void {
  if (installed || !isPodUiHostLaunch()) {
    return
  }
  installed = true
  let graceTimer: ReturnType<typeof setTimeout> | null = null
  let quitAskedByUi = false
  let systemShutdown = false
  let forwardingSecondInstance = false
  const log = (message: string): void => console.log(`[pod] ${message}`)
  const clearGrace = (): void => {
    if (graceTimer) {
      clearTimeout(graceTimer)
      graceTimer = null
    }
  }
  const verifyPeer = loadPodPeerVerifier(
    podPeerIdentityAddonPath({
      resourcesPath: typeof process.resourcesPath === 'string' ? process.resourcesPath : null,
      appPath: app.getAppPath(),
      isPackaged: app.isPackaged
    })
  )
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
    onOpenSurface: (request) => {
      const visible = openSurface(request)
      server.send({ type: 'surfaceShown', surface: request.surface, visible })
    },
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
      const visible = openSurface({ type: 'openSurface', surface: 'window' })
      server.send({ type: 'surfaceShown', surface: 'window', visible })
    },
    onQuit: (reason) => {
      quitAskedByUi = true
      state.isQuitting = true
      log(`ui-host: PodNative asked to quit (${reason})`)
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
          log('ui-host: no PodNative came back; quitting')
          state.isQuitting = true
          app.quit()
        }
      }, NO_UI_GRACE_MS)
      graceTimer.unref?.()
    }
  })
  setPodUiHostSink(server)
  powerMonitor.on('shutdown', () => {
    systemShutdown = true
  })
  // Why: a Quit in a fallback window, logout or a signal quits this process; PodNative quits with
  // it instead of restarting a runtime it thinks crashed.
  app.on('before-quit', () => {
    if (!quitAskedByUi) {
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
