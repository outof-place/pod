import { BrowserWindow } from 'electron'
import type { DeferredImportProgress } from './deferred-profile-import'
import type { ProductIdentity } from './product-identity'

const UPDATE_INTERVAL_MS = 80

function progressPage(identity: Pick<ProductIdentity, 'displayName'>): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
:root { color-scheme: light dark; font: 13px -apple-system, BlinkMacSystemFont, sans-serif; }
body { margin: 0; padding: 30px 22px 18px; -webkit-user-select: none; cursor: default; background: transparent; }
h1 { font-size: 13px; font-weight: 600; margin: 0 0 4px; }
p { margin: 0 0 12px; color: color-mix(in srgb, currentColor 60%, transparent); font-variant-numeric: tabular-nums; }
.track { height: 6px; border-radius: 3px; background: color-mix(in srgb, currentColor 14%, transparent); overflow: hidden; }
.fill { height: 100%; width: 0; border-radius: 3px; background: AccentColor; transition: width 80ms linear; }
</style></head><body>
<h1>Importing your Orca profile into ${identity.displayName}</h1>
<p id="detail">Counting files…</p>
<div class="track"><div class="fill" id="fill"></div></div>
<script>
const format = new Intl.NumberFormat()
window.update = (copied, total) => {
  document.getElementById('detail').textContent =
    format.format(copied) + ' of ' + format.format(total) + ' files'
  document.getElementById('fill').style.width = (total > 0 ? (100 * copied) / total : 100) + '%'
}
</script></body></html>`
}

export type ImportProgressWindow = { update(progress: DeferredImportProgress): void; close(): void }

/** A small native-looking window (vibrancy, hidden title bar) with a progress bar and dock progress. */
export function openImportProgressWindow(
  identity: Pick<ProductIdentity, 'displayName'>
): ImportProgressWindow {
  const window = new BrowserWindow({
    width: 420,
    height: 118,
    show: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    closable: false,
    title: identity.displayName,
    titleBarStyle: 'hidden',
    vibrancy: 'under-window',
    visualEffectState: 'active',
    backgroundColor: '#00000000',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  let ready = false
  let latest: DeferredImportProgress | null = null
  let lastSent = 0
  const send = (): void => {
    if (!ready || !latest || window.isDestroyed()) {
      return
    }
    lastSent = Date.now()
    void window.webContents
      .executeJavaScript(`window.update(${latest.copied}, ${latest.total})`)
      .catch(() => {})
    window.setProgressBar(latest.total > 0 ? latest.copied / latest.total : 1)
  }
  window.once('ready-to-show', () => {
    ready = true
    window.show()
    send()
  })
  void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(progressPage(identity))}`)
  return {
    update(progress) {
      latest = { ...progress }
      if (Date.now() - lastSent >= UPDATE_INTERVAL_MS || progress.copied >= progress.total) {
        send()
      }
    },
    close() {
      if (!window.isDestroyed()) {
        window.setProgressBar(-1)
        window.destroy()
      }
    }
  }
}
