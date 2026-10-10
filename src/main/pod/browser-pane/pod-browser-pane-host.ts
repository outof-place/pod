// Fork-only (Pod): sets one-app's browser panes up. Browser pages become offscreen WebContents with
// shared textures (the headless offscreen backend, plus two options), so the runtime routes browser
// tab creation there instead of to the hidden window's <webview>s.
import { app, type WebContents } from 'electron'
import { OffscreenBrowserBackend } from '../../browser/offscreen-browser-backend'
import { browserManager } from '../../browser/browser-manager'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { mainProcessState as state } from '../../startup/main-process-state'
import { isBackgroundLaunch } from '../../window/foreground-activation-policy'
import { loadPodBrowserFrames } from '../ui-host/pod-peer-identity'
import { setPodBrowserPaneHooks } from './pod-browser-pane-hooks'
import type { PodBrowserPaneServerMessage } from './pod-browser-pane-protocol'
import { POD_BROWSER_PANE_SCALE, PodBrowserPaneController } from './pod-browser-pane'

export function installPodBrowserPanes(options: {
  runtime: Pick<OrcaRuntimeService, 'setOffscreenBrowserBackend'>
  addonPath: string
  send: (message: PodBrowserPaneServerMessage) => boolean
  log: (message: string) => void
}): PodBrowserPaneController {
  const frames = loadPodBrowserFrames(options.addonPath)
  if (!frames) {
    options.log('browser-pane: no frame sender (addon missing); panes stay blank')
  }
  const panes = new PodBrowserPaneController({
    frames,
    send: options.send,
    openDevTools: (wc: WebContents) =>
      wc.openDevTools({ mode: 'detach', activate: !isBackgroundLaunch() }),
    log: options.log
  })
  options.runtime.setOffscreenBrowserBackend(
    new OffscreenBrowserBackend(browserManager, {
      getAgentBrowserBridge: () => state.agentBrowserBridge,
      extraWebPreferences: {
        offscreen: { useSharedTexture: true, deviceScaleFactor: POD_BROWSER_PANE_SCALE }
      },
      onWindowCreated: (browserPageId, win) => panes.trackPage(browserPageId, win)
    })
  )
  // POD_E2E_DOWNLOADS_DIR: an E2E's downloads land in its own directory, never ~/Downloads.
  const downloads = process.env.POD_E2E_DOWNLOADS_DIR
  if (downloads) {
    app.setPath('downloads', downloads)
  }
  setPodBrowserPaneHooks({
    agentCommand: (webContentsId) => panes.noteAgentCommand(webContentsId),
    download: (event) => panes.noteDownload(event)
  })
  app.once('will-quit', () => setPodBrowserPaneHooks(null))
  return panes
}
