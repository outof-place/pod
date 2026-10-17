import { dirname, join } from 'node:path'

/** The Resources of the image the daemon runs: the clone's when relocated (an update deletes the
 *  installed bundle), else the app's. `relocatedExecPath` is the clone's `Contents/MacOS/<exe>`. */
export function daemonImageResourcesPath(relocatedExecPath?: string): string | null {
  if (relocatedExecPath) {
    return join(dirname(dirname(relocatedExecPath)), 'Resources')
  }
  return typeof process.resourcesPath === 'string' ? process.resourcesPath : null
}
