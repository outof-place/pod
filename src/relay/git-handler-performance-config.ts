import { resolve } from 'node:path'
import { expandTilde } from './context'
import { GitHandlerOperationContext } from './git-handler-operation-context'
import { detectReliableDirectoryMtime } from '../shared/git-performance-config-filesystem'
import {
  runGitPerformanceConfigAction,
  type GitPerformanceConfigHost
} from '../shared/git-performance-config-runner'
import {
  isGitPerformanceConfigAction,
  type GitPerformanceConfigResult
} from '../shared/git-performance-config-types'
import { KeyedSerialRunner } from '../shared/keyed-serial-runner'

// Why a narrow RPC: generic git.exec refuses config writes, and the plan must be made
// host-side because the SSH host's Git version, OS and filesystem decide every key.
export class GitHandlerPerformanceConfigOperations extends GitHandlerOperationContext {
  private readonly perRepo = new KeyedSerialRunner()

  async repoPerformanceConfig(
    params: Record<string, unknown>
  ): Promise<GitPerformanceConfigResult> {
    const repoPath = params.repoPath
    const action = params.action
    if (typeof repoPath !== 'string' || !repoPath || repoPath.includes('\0')) {
      throw new Error('Invalid repository performance config request.')
    }
    if (!isGitPerformanceConfigAction(action)) {
      throw new Error('Unknown repository performance config action.')
    }
    const hostPath = expandTilde(repoPath)
    const host: GitPerformanceConfigHost = {
      platform: process.platform,
      git: (args) => this.git(args, hostPath, { nonInteractive: true }),
      capabilities: this.gitCapabilities,
      hasReliableDirectoryMtime: () => detectReliableDirectoryMtime(hostPath, process.platform),
      resolveGitPath: (gitPath) => resolve(hostPath, gitPath)
    }
    return this.perRepo.run(hostPath, () => runGitPerformanceConfigAction(host, action))
  }
}
