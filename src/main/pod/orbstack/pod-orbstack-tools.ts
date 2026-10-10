import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '../../../shared/child-process/run-process'

export type OrbstackTool = 'orb' | 'orbctl' | 'docker'

export type OrbstackToolPaths = Record<OrbstackTool, string | null> & { appInstalled: boolean }

export type OrbstackToolResult = {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export type OrbstackToolRunner = (
  tool: OrbstackTool,
  args: readonly string[],
  options?: { timeoutMs?: number; input?: string }
) => Promise<OrbstackToolResult>

const DEFAULT_TIMEOUT_MS = 15_000
// Lets E2E runs swap in a fake orb/docker; ignored outside an isolated E2E profile.
export const POD_ORBSTACK_E2E_TOOL_DIR_ENV = 'POD_E2E_ORBSTACK_TOOL_DIR'
// Why: E2E profiles get a long temp HOME, and orb's socket path under it passes the 104-byte
// limit, so OrbStack reads as stopped. A real-OrbStack E2E names the account home here.
export const POD_ORBSTACK_E2E_HOME_ENV = 'POD_E2E_ORBSTACK_HOME'

// E2E only: skip the Claude Code download when a spec runs a stand-in agent in the sandbox.
export const POD_ORBSTACK_E2E_SKIP_AGENT_INSTALL_ENV = 'POD_E2E_ORBSTACK_SKIP_AGENT_INSTALL'

export function resolveOrbstackSkipAgentInstall(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ORCA_E2E_USER_DATA_DIR) && env[POD_ORBSTACK_E2E_SKIP_AGENT_INSTALL_ENV] === '1'
}

/** HOME for orb, orbctl and docker; null keeps the inherited one. */
export function resolveOrbstackHomeOverride(env: NodeJS.ProcessEnv = process.env): string | null {
  return (env.ORCA_E2E_USER_DATA_DIR && env[POD_ORBSTACK_E2E_HOME_ENV]) || null
}

function appBundles(home: string): string[] {
  return ['/Applications/OrbStack.app', join(home, 'Applications', 'OrbStack.app')]
}

// Why absolute: a packaged app's PATH need not include Homebrew, and the bundle's own CLI is canonical.
function toolCandidates(tool: OrbstackTool, home: string): string[] {
  const bundleDir = tool === 'docker' ? 'xbin' : 'bin'
  return [
    ...appBundles(home).map((app) => join(app, 'Contents', 'MacOS', bundleDir, tool)),
    join('/opt/homebrew/bin', tool),
    join('/usr/local/bin', tool)
  ]
}

export function resolveOrbstackToolPaths(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
  home: string = homedir()
): OrbstackToolPaths {
  const stubDir = env.ORCA_E2E_USER_DATA_DIR ? env[POD_ORBSTACK_E2E_TOOL_DIR_ENV] : undefined
  const resolve = (tool: OrbstackTool): string | null => {
    if (stubDir) {
      return exists(join(stubDir, tool)) ? join(stubDir, tool) : null
    }
    return toolCandidates(tool, home).find((candidate) => exists(candidate)) ?? null
  }
  return {
    appInstalled: stubDir ? resolve('orb') !== null : appBundles(home).some(exists),
    orb: resolve('orb'),
    orbctl: resolve('orbctl'),
    docker: resolve('docker')
  }
}

/** Never rejects: a missing tool or one that cannot start reports code null. */
export function createOrbstackToolRunner(
  paths: () => OrbstackToolPaths,
  home: string | null = resolveOrbstackHomeOverride()
): OrbstackToolRunner {
  return async (tool, args, options) => {
    const program = paths()[tool]
    if (!program) {
      return { code: null, stdout: '', stderr: `${tool} was not found`, timedOut: false }
    }
    try {
      const result = await runProcess({
        program,
        args,
        ...(home ? { env: { ...process.env, HOME: home } } : {}),
        timeoutMs: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        ...(options?.input !== undefined ? { input: options.input } : {}),
        maxOutputBytes: 4 * 1024 * 1024
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
