// Fork-only (Pod): the one-app launch. PodNative, the app the user sees, starts this runtime through
// LaunchServices with --pod-ui-host. The runtime then runs as an accessory app (no Dock tile, no menu
// bar): its main window loads hidden, so the renderer keeps every duty it has today, and shows only
// for a surface PodNative asks for. Electron-free, so tests and the CLI can import it.
import { POD_HEADLESS_HOST_FLAG } from '../headless-host/headless-host-mode'

export const POD_UI_HOST_SWITCH = '--pod-ui-host'

// Where the one-app Pod.app carries this runtime (Apple's place for helper apps).
const NESTED_RUNTIME_EXECUTABLE_DIR = '/Contents/Helpers/Pod Runtime.app/Contents/MacOS/'

/** The Pod.app around this runtime when it is the one-app layout's helper, else null. */
export function podUiHostOuterApp(execPath: string = process.execPath): string | null {
  const index = execPath.indexOf(NESTED_RUNTIME_EXECUTABLE_DIR)
  return index > 0 ? execPath.slice(0, index) : null
}

/**
 * True for a one-app runtime on macOS: PodNative's switch or the nested layout (a login item,
 * `open -b` or the CLI started the helper directly; it then opens the UI). `serve` counts only as
 * the headless one-app runtime, which PodNative starts with both switches.
 */
export function isPodUiHostLaunch(
  argv: readonly string[] = process.argv,
  platform: NodeJS.Platform = process.platform,
  execPath: string = process.execPath
): boolean {
  if (platform !== 'darwin') {
    return false
  }
  if (argv.includes('--serve')) {
    return hasPodHeadlessUiHostSwitches(argv)
  }
  return argv.includes(POD_UI_HOST_SWITCH) || podUiHostOuterApp(execPath) !== null
}

/** The switches PodNative starts the headless one-app runtime with; nothing else passes all three. */
export function hasPodHeadlessUiHostSwitches(argv: readonly string[]): boolean {
  return (
    argv.includes('--serve') &&
    argv.includes(POD_UI_HOST_SWITCH) &&
    argv.includes(POD_HEADLESS_HOST_FLAG)
  )
}

/** The headless one-app runtime: no window until PodNative asks for a surface; closing destroys it. */
export function isPodHeadlessUiHost(
  argv: readonly string[] = process.argv,
  platform: NodeJS.Platform = process.platform,
  execPath: string = process.execPath
): boolean {
  return argv.includes('--serve') && isPodUiHostLaunch(argv, platform, execPath)
}
