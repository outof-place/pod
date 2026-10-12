import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'

export type WorkspaceTool = 'tmutil' | 'mdfind' | 'mdutil' | 'defaults' | 'pnpm'

export type WorkspaceToolResult = {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export type WorkspaceToolRunner = (
  tool: WorkspaceTool,
  args: readonly string[],
  options: { timeoutMs: number; cwd?: string }
) => Promise<WorkspaceToolResult>

// Why absolute: a PATH entry must not stand in for the system tools that set exclusions.
const SYSTEM_TOOL_PATHS: Record<Exclude<WorkspaceTool, 'pnpm'>, string> = {
  tmutil: '/usr/bin/tmutil',
  mdfind: '/usr/bin/mdfind',
  mdutil: '/usr/bin/mdutil',
  defaults: '/usr/bin/defaults'
}

// Lets E2E runs stub tmutil/mdfind; ignored outside an isolated E2E profile.
export const POD_WORKSPACE_E2E_TOOL_DIR_ENV = 'POD_E2E_WORKSPACE_TOOL_DIR'

function resolveToolProgram(tool: WorkspaceTool, env: NodeJS.ProcessEnv): string {
  const stubDir = env.ORCA_E2E_USER_DATA_DIR ? env[POD_WORKSPACE_E2E_TOOL_DIR_ENV] : undefined
  if (stubDir && existsSync(join(stubDir, tool))) {
    return join(stubDir, tool)
  }
  return tool === 'pnpm' ? 'pnpm' : SYSTEM_TOOL_PATHS[tool]
}

/** Never rejects: a tool that cannot start reports code null, like a timeout. */
export function createWorkspaceToolRunner(
  env: NodeJS.ProcessEnv = process.env
): WorkspaceToolRunner {
  return async (tool, args, options) => {
    try {
      const result = await runProcess({
        program: resolveToolProgram(tool, env),
        args,
        cwd: options.cwd,
        timeoutMs: options.timeoutMs,
        maxOutputBytes: 1024 * 1024
      })
      return {
        code: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: result.timedOut
      }
    } catch (error) {
      return {
        code: null,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        timedOut: false
      }
    }
  }
}
