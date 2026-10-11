// Fork-only (Pod): the headless one-app runtime makes its window only for a surface PodNative asks
// for (src/main/pod/ui-host/pod-ui-host-lazy-window.ts). The new renderer says when it restored the
// session, so the request's navigation reaches listeners that exist.
export const POD_UI_HOST_SURFACE_IPC = {
  /** renderer → main: the session is restored; a waiting surface request can go on. */
  ready: 'pod:uiHostSurface:ready',
  /** main → renderer: open a section of this window or of Settings (PodUiHostSectionRequest). */
  openSection: 'pod:uiHostSurface:openSection'
} as const

/** What `openSurface.section` may name in the window: a view or panel PodNative has no native
 *  version of yet. In Settings it names a pane (settings-navigation-types.ts). */
export const POD_UI_HOST_WINDOW_SECTIONS = [
  'new-workspace',
  'add-project',
  'tasks',
  'workspace-board',
  'activity',
  'quick-commands',
  'explorer',
  'search',
  'source-control',
  'checks',
  'ports'
] as const
export type PodUiHostWindowSection = (typeof POD_UI_HOST_WINDOW_SECTIONS)[number]

export type PodUiHostSectionRequest = {
  surface: 'window' | 'settings'
  section: string
  /** The asked worktree: a project's own Settings pane (`repo`) opens for its project. */
  worktreeId?: string
}
