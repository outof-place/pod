// Fork-only (Pod): the headless one-app runtime makes its window only for a surface PodNative asks
// for (src/main/pod/ui-host/pod-ui-host-lazy-window.ts). The new renderer says when it restored the
// session, so the request's navigation reaches listeners that exist.
import { z } from 'zod'

export const POD_UI_HOST_SURFACE_IPC = {
  /** renderer → main: the session is restored; a waiting surface request can go on. */
  ready: 'pod:uiHostSurface:ready',
  /** main → renderer: where in the surface PodNative asked for (PodUiHostSurfaceNavigation). */
  navigate: 'pod:uiHostSurface:navigate'
} as const

/** The classic window's top-level views PodNative can ask for by name. */
export const POD_UI_HOST_WINDOW_SECTIONS = [
  'activity',
  'automations',
  'skills',
  'artifacts',
  'space'
] as const

/** The section of an `openSurface`; the renderer checks the names (an unknown one opens the root). */
export type PodUiHostSurfaceNavigation = {
  surface: 'window' | 'settings'
  /** Settings: a pane id (settings-navigation-types.ts). Window: one of POD_UI_HOST_WINDOW_SECTIONS. */
  section: string
  repoId?: string
  hostId?: string
  /** Settings: an anchor in the pane. Window: the item to select (an automation id). */
  item?: string
  /** Settings: what the pane opens for (`add-quick-command`). */
  intent?: string
}

const PodUiHostSurfaceNavigationSchema = z
  .object({
    surface: z.enum(['window', 'settings']),
    section: z.string(),
    repoId: z.string().optional(),
    hostId: z.string().optional(),
    item: z.string().optional(),
    intent: z.string().optional()
  })
  .strict()

export function isPodUiHostSurfaceNavigation(value: unknown): value is PodUiHostSurfaceNavigation {
  return PodUiHostSurfaceNavigationSchema.safeParse(value).success
}
