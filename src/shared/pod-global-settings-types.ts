import type { NativeChatGlobalSettings } from './native-chat-appearance-settings'

/** Fork-only (Pod): Pod's own settings keys, kept out of Orca's GlobalSettings body. */
export type PodGlobalSettings = {
  /** Pod (macOS): turns the workspace root on outside Pod builds. */
  experimentalPodWorkspace?: boolean
  /** Pod (macOS): where repositories live, as `<root>/<owner>/<repo>`; absent means `~/pod`. */
  podWorkspaceRoot?: string
  /** Fork-only (Pod): marketplace and Git plugins in a product without Stably's kill list. */
  thirdPartyPluginsEnabled?: boolean
  /** Experimental (Pod): answer local quick open and file search from the ogd index daemon. */
  experimentalPodNativeSearch?: boolean
}

/** What GlobalSettings extends: Orca's native chat settings plus Pod's keys. */
export type GlobalSettingsBase = NativeChatGlobalSettings & PodGlobalSettings
