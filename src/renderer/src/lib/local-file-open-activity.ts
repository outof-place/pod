import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { AppState } from '@/store/types'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import { resolveWorktreeOperationRoute } from './worktree-operation-route'

let lastNotedPath: string | null = null

/**
 * Tells this machine's search index which file the editor made active, so quick open can rank
 * recent work. Only local files qualify: a remote host's files are not in this machine's index.
 */
export function noteLocalFileOpened(state: AppState, file: OpenFile): void {
  if (file.mode !== 'edit' || file.isUntitled || file.filePath === lastNotedPath) {
    return
  }
  const route = resolveWorktreeOperationRoute(state, file.worktreeId)
  if (route?.executionHostId !== LOCAL_EXECUTION_HOST_ID || route.runtimeEnvironmentId !== null) {
    return
  }
  const noteFileOpened = typeof window === 'undefined' ? undefined : window.api?.fs?.noteFileOpened
  if (noteFileOpened) {
    lastNotedPath = file.filePath
    void noteFileOpened({ filePath: file.filePath }).catch(() => undefined)
  }
}
