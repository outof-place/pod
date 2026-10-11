// Fork-only (Pod): the serve launch's CLI registration, moved out of main-process-runtime-launch.ts
// (max-lines) so a product build can skip it: Pod registers its CLI only from Settings › CLI.
import { app } from 'electron'
import { CliInstaller } from '../cli/cli-installer'
import { installLinuxBareOrcaDispatcher } from '../cli/linux-bare-orca-dispatcher'
import { allowsCliAutoInstall } from '../product-identity/product-identity'

export async function registerServeCli(): Promise<void> {
  if (!allowsCliAutoInstall()) {
    return
  }
  // Why: headless serve has no renderer to run the normal cli:install flow; do it here for macOS/Linux only (Windows-excluded: install() only mutates registry PATH, not child terminals).
  if (process.platform === 'darwin' || process.platform === 'linux') {
    try {
      // Why: serve is headless — a fallback osascript admin prompt would hang it; skip elevation since ~/.local/bin needs none.
      const cliStatus = await new CliInstaller({
        privilegedRunner: async () => {
          throw new Error('serve CLI auto-install must not request administrator privileges')
        }
      }).install()
      console.log(
        `[serve] orca CLI install: ${cliStatus.state}${cliStatus.commandPath ? ` (${cliStatus.commandPath})` : ''}`
      )
    } catch (error) {
      console.warn(
        '[serve] orca CLI install skipped:',
        error instanceof Error ? error.message : String(error)
      )
    }
  }
  // Why: Linux CLI installs as `orca-ide`, but the Claude Team launcher invokes bare `orca`; drop a ~/.local/bin dispatcher (ahead of /usr/bin) so it resolves. Best-effort.
  if (process.platform === 'linux' && app.isPackaged && process.resourcesPath) {
    try {
      const dispatcher = await installLinuxBareOrcaDispatcher({
        resourcesPath: process.resourcesPath
      })
      console.log(
        `[serve] bare orca dispatcher ${dispatcher.state}: ${dispatcher.dispatcherPath}` +
          `${dispatcher.target ? ` -> ${dispatcher.target}` : ''}`
      )
    } catch (error) {
      console.warn(
        '[serve] bare orca dispatcher install skipped:',
        error instanceof Error ? error.message : String(error)
      )
    }
  }
}
