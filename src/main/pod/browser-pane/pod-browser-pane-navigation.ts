// Fork-only (Pod): a browser pane's toolbar actions on its offscreen page.
import type { WebContents } from 'electron'
import type { PodBrowserPaneClientMessage } from './pod-browser-pane-protocol'
import { isNavigablePaneUrl } from './pod-browser-pane-input'

export function navigatePanePage(
  wc: WebContents,
  message: Extract<PodBrowserPaneClientMessage, { type: 'browserNavigate' }>,
  log: (message: string) => void
): void {
  const history = wc.navigationHistory
  switch (message.action) {
    case 'back':
      if (history.canGoBack()) {
        history.goBack()
      }
      return
    case 'forward':
      if (history.canGoForward()) {
        history.goForward()
      }
      return
    case 'reload':
      wc.reload()
      return
    case 'stop':
      wc.stop()
      return
    case 'load':
      if (!isNavigablePaneUrl(message.url)) {
        log('browser-pane: refused to load a URL that is not http(s)')
        return
      }
      void wc.loadURL(message.url).catch(() => {
        // An aborted or failed load still leaves the page usable; its state says how it went.
      })
  }
}
