import { gitExecFileAsync } from '../../git/runner'

export type WorkspaceGitResult = { code: number | null; stdout: string; stderr: string }

/** Runs git on this Mac and reports the exit code instead of throwing; null means it never ran. */
export type WorkspaceGitExec = (
  args: string[],
  cwd: string,
  options?: { timeoutMs?: number }
) => Promise<WorkspaceGitResult>

const DEFAULT_TIMEOUT_MS = 20_000

function text(value: unknown): string {
  return typeof value === 'string' ? value : Buffer.isBuffer(value) ? value.toString('utf8') : ''
}

export function createWorkspaceGitExec(): WorkspaceGitExec {
  return async (args, cwd, options) => {
    try {
      const { stdout, stderr } = await gitExecFileAsync(args, {
        cwd,
        timeout: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        // Why background: workspace upkeep must queue behind the status reads the UI waits on.
        admissionTier: 'background'
      })
      return { code: 0, stdout, stderr }
    } catch (error) {
      const code = error instanceof Error ? Reflect.get(error, 'code') : null
      return {
        code: typeof code === 'number' ? code : null,
        stdout: error instanceof Error ? text(Reflect.get(error, 'stdout')) : '',
        stderr: error instanceof Error ? text(Reflect.get(error, 'stderr')) || error.message : ''
      }
    }
  }
}
