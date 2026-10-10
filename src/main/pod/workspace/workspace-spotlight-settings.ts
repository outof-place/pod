import { shell } from 'electron'

// Search Privacy is a sheet inside the Spotlight pane, which has no deep link of its own.
const SPOTLIGHT_SETTINGS_URLS = [
  'x-apple.systempreferences:com.apple.Spotlight-Settings.extension',
  'x-apple.systempreferences:com.apple.preference.spotlight'
] as const
const SYSTEM_SETTINGS_APP = '/System/Applications/System Settings.app'

export async function openSpotlightSettings(): Promise<boolean> {
  for (const url of SPOTLIGHT_SETTINGS_URLS) {
    try {
      await shell.openExternal(url)
      return true
    } catch {
      // Older or newer macOS may only know one of the two pane ids.
    }
  }
  return (await shell.openPath(SYSTEM_SETTINGS_APP)) === ''
}
