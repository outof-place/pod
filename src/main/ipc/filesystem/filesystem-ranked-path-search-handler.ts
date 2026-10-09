import { ipcMain } from 'electron'
import { getExternalWorkspaceSearchProvider } from '../../search/external-workspace-search-provider'
import { parseWslPath } from '../../wsl'
import { resolveAuthorizedPath } from '../filesystem-auth'
import { getLocalGitOptionsForRegisteredWorktree } from '../local-worktree-runtime-options'
import type { FilesystemHandlerContext } from './filesystem-handler-context'

/** True when a local index can rank quick-open paths per query instead of listing them all. */
export function registerFilesystemRankedPathSearchHandler(context: FilesystemHandlerContext): void {
  const { store } = context
  ipcMain.handle(
    'fs:rankedPathSearch',
    async (
      _event,
      args: { rootPath: string; includeIgnored?: boolean; followSymlinks?: boolean }
    ): Promise<boolean> => {
      const provider = getExternalWorkspaceSearchProvider()
      if (!provider) {
        return false
      }
      try {
        const rootPath = await resolveAuthorizedPath(args.rootPath, store)
        const wslDistro =
          parseWslPath(rootPath)?.distro ??
          getLocalGitOptionsForRegisteredWorktree(store, args.rootPath, rootPath).wslDistro
        if (wslDistro) {
          return false
        }
        return await provider.supportsRankedPathSearch({
          rootPath,
          includeIgnored: args.includeIgnored !== false,
          followSymlinks: args.followSymlinks === true
        })
      } catch {
        return false
      }
    }
  )
}
