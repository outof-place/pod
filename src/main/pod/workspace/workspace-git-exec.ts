import { extractExecError, gitExecFileAsync } from '../../git/runner'

export type WorkspaceGitResult = { code: number | null; stdout: string; stderr: string }

/**
 * Runs git on this Mac and reports the exit code instead of throwing; null means it never ran.
 * Never lazy-fetches unless asked: in a blobless clone one stray blob read means a network
 * round trip per object (a pickaxe search over history fetched for hours).
 */
export type WorkspaceGitExec = (
  args: string[],
  cwd: string,
  options?: { timeoutMs?: number; lazyFetch?: boolean }
) => Promise<WorkspaceGitResult>

const DEFAULT_TIMEOUT_MS = 20_000

export function createWorkspaceGitExec(): WorkspaceGitExec {
  return async (args, cwd, options) => {
    try {
      const { stdout, stderr } = await gitExecFileAsync(args, {
        cwd,
        timeout: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        env: options?.lazyFetch ? process.env : { ...process.env, GIT_NO_LAZY_FETCH: '1' },
        // Why background: workspace upkeep must queue behind the status reads the UI waits on.
        admissionTier: 'background'
      })
      return { code: 0, stdout, stderr }
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : null
      return { code: typeof code === 'number' ? code : null, ...extractExecError(error) }
    }
  }
}
