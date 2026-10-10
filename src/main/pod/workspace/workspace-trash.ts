import { lstat, mkdir, rename, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

export type WorkspaceTrash = {
  /** Moves a folder to the Trash, never deleting it; the folder's new path, or null if unknown. */
  move(path: string): Promise<string | null>
  /** Moves it back to where it was; refuses when something took its place. */
  putBack(trashedPath: string, originalPath: string): Promise<void>
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false
  )
}

/**
 * Same volume: a rename into `~/.Trash`, so Pod knows the folder's new path and can put it back
 * with everything in it. Another volume: the system's own move (`osTrash`), restorable only from
 * Finder.
 */
export function createWorkspaceTrash(home: string, osTrash: (path: string) => Promise<void>) {
  const trashDir = join(home, '.Trash')
  const trash: WorkspaceTrash = {
    async move(path) {
      const [source, target] = await Promise.all([
        stat(path),
        mkdir(trashDir, { recursive: true }).then(() => stat(trashDir))
      ])
      if (source.dev !== target.dev) {
        await osTrash(path)
        return null
      }
      // Finder's own suffix style keeps same-named folders apart.
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      let destination = join(trashDir, basename(path))
      for (let attempt = 0; await exists(destination); attempt += 1) {
        destination = join(trashDir, `${basename(path)} ${stamp}${attempt ? ` ${attempt}` : ''}`)
      }
      await rename(path, destination)
      return destination
    },
    async putBack(trashedPath, originalPath) {
      if (await exists(originalPath)) {
        throw new Error('Something already exists where it was')
      }
      await rename(trashedPath, originalPath)
    }
  }
  return trash
}
