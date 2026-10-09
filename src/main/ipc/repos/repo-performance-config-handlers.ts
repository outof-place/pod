import { ipcMain } from 'electron'
import { z } from 'zod'
import type { Store } from '../../persistence'
import {
  normalizeGitTuningMode,
  type RepoPerformanceConfigOutcome
} from '../../../shared/git-performance-config-types'
import { runRepoPerformanceConfig } from '../../git/repo-performance-config'

const RepoPerformanceConfigArgs = z.object({
  repoId: z.string().min(1),
  action: z.enum(['inspect', 'apply', 'revert'])
})

export function registerRepoPerformanceConfigHandlers(store: Store): void {
  ipcMain.handle(
    'repos:performanceConfig',
    async (_event, rawArgs: unknown): Promise<RepoPerformanceConfigOutcome> => {
      const args = RepoPerformanceConfigArgs.parse(rawArgs)
      const repo = store.getRepo(args.repoId)
      if (!repo) {
        return { status: 'unavailable', reason: 'not-found' }
      }
      // Why enforced here: the setting is the user's consent; no caller writes config without it.
      if (
        args.action === 'apply' &&
        normalizeGitTuningMode(store.getSettings().gitTuning) !== 'recommended'
      ) {
        return { status: 'unavailable', reason: 'disabled' }
      }
      return runRepoPerformanceConfig(repo, args.action)
    }
  )
}
