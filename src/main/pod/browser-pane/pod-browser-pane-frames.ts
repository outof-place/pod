// Fork-only (Pod): one-app's frame path. An attached, visible offscreen page's shared texture goes
// to PodNative's random launchd name as an IOSurface Mach port (native/pod-peer-identity-macos
// browser_frames.c); PodNative checks the sender by audit token.

// The device scale offscreen pages render at: Retina pixels on every Mac display Pod targets.
export const POD_BROWSER_PANE_SCALE = 2

export type PodBrowserFrames = {
  browserConnect: (service: string) => boolean
  browserDisconnect: () => boolean
  browserSend: (
    ioSurface: Buffer,
    frame: {
      seq: number
      token: number
      widget: number
      popupX: number
      popupY: number
      scaleX100: number
    }
  ) => { ok: boolean; ns: number }
}

export type PodBrowserPaneStats = { framesSent: number; sendFailures: number; sendNs: number }

/** What a page's paint needs to go out: its pane's token (null: no pane) and whether it shows. */
export type PaneFrameTarget = { token: number | null; visible: boolean; seq: number }

export class PaneFramePump {
  readonly stats: PodBrowserPaneStats = { framesSent: 0, sendFailures: 0, sendNs: 0 }
  private connected = false
  private connectedService: string | null = null
  // Attached paints in a row with no shared texture: Ganesh (disable-skia-graphite) turns them off.
  private texturelessPaints = 0

  constructor(
    private readonly frames: PodBrowserFrames | null,
    private readonly log: (message: string) => void
  ) {}

  get service(): string | null {
    return this.connectedService
  }

  connect(service: string): void {
    this.connectedService = service
    this.connected = this.frames?.browserConnect(service) ?? false
    this.log(
      this.connected
        ? 'browser-pane: frames go to PodNative'
        : 'browser-pane: PodNative has no frame receiver under that name'
    )
  }

  disconnect(): void {
    this.frames?.browserDisconnect()
    this.connected = false
    this.connectedService = null
  }

  paint(target: PaneFrameTarget, texture: Electron.OffscreenSharedTexture | undefined): void {
    if (!texture) {
      if (target.token !== null && ++this.texturelessPaints === 30) {
        this.log('browser-pane: paints come without shared textures; the pane stays blank')
      }
      return
    }
    this.texturelessPaints = 0
    try {
      const ioSurface = texture.textureInfo.handle.ioSurface
      if (
        target.token === null ||
        !target.visible ||
        !this.connected ||
        !this.frames ||
        !ioSurface
      ) {
        return
      }
      const info = texture.textureInfo
      target.seq += 1
      const result = this.frames.browserSend(ioSurface, {
        seq: target.seq,
        token: target.token,
        widget: info.widgetType === 'popup' ? 1 : 0,
        popupX: Math.round(info.contentRect?.x ?? 0),
        popupY: Math.round(info.contentRect?.y ?? 0),
        scaleX100: POD_BROWSER_PANE_SCALE * 100
      })
      this.count(result)
    } finally {
      // Why at once: Chromium's pool is two surfaces; PodNative maps its own reference.
      texture.release()
    }
  }

  private count(result: { ok: boolean; ns: number }): void {
    this.stats.sendNs += result.ns
    if (result.ok) {
      this.stats.framesSent += 1
      if (this.stats.framesSent === 1) {
        this.log('browser-pane: first frame sent')
      }
    } else {
      this.stats.sendFailures += 1
      if (this.stats.sendFailures === 1) {
        this.log('browser-pane: a frame could not be sent')
      }
    }
  }
}
