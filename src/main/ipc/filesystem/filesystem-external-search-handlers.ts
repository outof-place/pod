import { ipcMain } from 'electron'
import {
  getExternalWorkspaceSearchProvider,
  notifyExternalSearchFileActivity
} from '../../search/external-workspace-search-provider'
import { resolveAuthorizedPath } from '../filesystem-auth'
import { resolveQuickOpenSearchRoot } from '../quick-open-search-root'
import type { FilesystemHandlerContext } from './filesystem-handler-context'

/** IPC for an external local search index: per-query ranking support and editor activity. */
export function registerFilesystemExternalSearchHandlers(
  context: Pick<FilesystemHandlerContext, 'store'>
): void {
  const { store } = context
  // True when a local index can rank quick-open paths per query instead of listing them all.
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
        const root = await resolveQuickOpenSearchRoot(args.rootPath, store, undefined)
        if (root.wslDistroForOutput) {
          return false
        }
        return await provider.supportsRankedPathSearch({
          rootPath: root.authorizedRootPath,
          includeIgnored: args.includeIgnored !== false,
          followSymlinks: args.followSymlinks === true
        })
      } catch {
        return false
      }
    }
  )
  // A hint only: an unauthorized path or a missing index is not an error for the editor.
  ipcMain.handle('fs:noteFileOpened', async (_event, args: { filePath: string }): Promise<void> => {
    if (!getExternalWorkspaceSearchProvider() || typeof args?.filePath !== 'string') {
      return
    }
    try {
      const filePath = await resolveAuthorizedPath(args.filePath, store)
      notifyExternalSearchFileActivity({ filePath, kind: 'open' })
    } catch {
      // Not a file this host may index.
    }
  })
}
