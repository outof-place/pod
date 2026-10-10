// Fork-only (Pod): closes the idle renderer Electron launches when the default session is created.
// Only a sandboxed window on the default session can use it; the headless host opens none (agent
// browser pages use their own partitions), so it would sit idle for the host's whole life.
import { app, WebContentsView, webContents } from 'electron'
import { podHeadlessHostCuts, type PodHeadlessHostCuts } from './headless-host-mode'

// Why a delay: startup is still busy, and the release blocks main for a few tens of ms.
export const SPARE_RENDERER_RELEASE_DELAY_MS = 5_000

export type SpareRendererPorts = {
  liveWebContentsCount(): number
  rendererProcessCount(): number
  /** Creates a default-session sandboxed page, which takes the spare, and closes it at once. */
  takeAndClose(): void
}

const electronPorts: SpareRendererPorts = {
  liveWebContentsCount: () => webContents.getAllWebContents().length,
  rendererProcessCount: () => app.getAppMetrics().filter((metric) => metric.type === 'Tab').length,
  takeAndClose: () => {
    const view = new WebContentsView({ webPreferences: { sandbox: true } })
    view.webContents.close()
  }
}

/** Returns whether it closed one. */
export function releaseStartupSpareRenderer(ports: SpareRendererPorts = electronPorts): boolean {
  // Why only with no pages: any renderer then belongs to a page, and the spare may serve its next one.
  if (ports.liveWebContentsCount() > 0 || ports.rendererProcessCount() === 0) {
    return false
  }
  // Why taken, not killed: a killed renderer reads as a crash; a closed page's process exits
  // cleanly, and with SpareRendererForSitePerProcess off (Electron's default) none is warmed again.
  ports.takeAndClose()
  return true
}

export function schedulePodHeadlessSpareRendererRelease(
  cuts: PodHeadlessHostCuts | null = podHeadlessHostCuts(),
  ports: SpareRendererPorts = electronPorts
): void {
  if (!cuts?.releaseSpareRenderer) {
    return
  }
  const timer = setTimeout(
    () => releaseStartupSpareRenderer(ports),
    SPARE_RENDERER_RELEASE_DELAY_MS
  )
  timer.unref?.()
}
