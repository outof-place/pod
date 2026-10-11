// Fork-only (Pod): the headless one-app runtime makes its window only for a surface PodNative asks
// for (src/main/pod/ui-host/pod-ui-host-lazy-window.ts). The new renderer says when it restored the
// session, so the request's navigation reaches listeners that exist.
export const POD_UI_HOST_SURFACE_IPC = {
  /** renderer → main: the session is restored; a waiting surface request can go on. */
  ready: 'pod:uiHostSurface:ready'
} as const
