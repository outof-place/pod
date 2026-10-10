// Fork-only (Pod): an isolated OrbStack machine where Claude runs without seeing the rest of the Mac.
import { isAbsolute, relative, resolve } from 'node:path'
import { runProcess } from '../../../shared/child-process/run-process'
import { buildManagedCommandHook } from '../../agent-hooks/installer-utils'
import { getClaudeManagedHookPlan } from '../../claude/claude-managed-hook-events'
import { getManagedScript } from '../../claude/hook-script'
import {
  applyManagedHooks,
  getPosixManagedScriptFileName,
  getRemoteManagedCommand
} from '../../claude/hook-settings'
import type { OrbstackToolResult, OrbstackToolRunner } from './pod-orbstack-tools'

/** What a sandbox reaches the Mac's loopback as (probed on OrbStack 2.2.3, isolated machines too). */
export const SANDBOX_HOST_ALIAS = 'host.orb.internal'
// Why managed: Claude merges it over user settings, so the agent's own config cannot drop Pod's hooks.
const MANAGED_SETTINGS_PATH = '/etc/claude-code/managed-settings.json'
const LONG_STEP_MS = 10 * 60_000

/** Orca's generated POSIX hook script, posting to the Mac through OrbStack's host alias. */
export function buildSandboxHookScript(): string {
  const script = getManagedScript('posix')
  const next = script
    .replaceAll('http://127.0.0.1:', `http://${SANDBOX_HOST_ALIAS}:`)
    .replaceAll('--noproxy "127.0.0.1"', `--noproxy "${SANDBOX_HOST_ALIAS}"`)
  if (next === script || next.includes('127.0.0.1')) {
    throw new Error('The Claude hook script changed how it reaches the hook server.')
  }
  return next
}

export function buildSandboxManagedSettings(claudeVersion: string | null): string {
  const scriptFileName = getPosixManagedScriptFileName()
  const config = applyManagedHooks(
    {},
    buildManagedCommandHook(getRemoteManagedCommand(scriptFileName)),
    scriptFileName,
    getClaudeManagedHookPlan(claudeVersion)
  )
  // Why no updater: the sandbox pins the host's version; Pod reinstalls it when the host moves.
  return `${JSON.stringify({ ...config, env: { DISABLE_AUTOUPDATER: '1' } }, null, 2)}\n`
}

/** The worktree, plus its git dir when that lives elsewhere (linked worktrees). */
export async function resolveSandboxMounts(
  worktreePath: string,
  gitCommonDir: (path: string) => Promise<string | null> = readGitCommonDir
): Promise<string[]> {
  const common = await gitCommonDir(worktreePath)
  const mounts = [worktreePath]
  if (common) {
    const absolute = isAbsolute(common) ? common : resolve(worktreePath, common)
    const inside = relative(worktreePath, absolute)
    if (inside.startsWith('..') || isAbsolute(inside)) {
      mounts.push(absolute)
    }
  }
  return mounts
}

async function readGitCommonDir(worktreePath: string): Promise<string | null> {
  try {
    const result = await runProcess({
      program: 'git',
      args: ['-C', worktreePath, 'rev-parse', '--git-common-dir'],
      timeoutMs: 10_000
    })
    return result.code === 0 ? result.stdout.trim() || null : null
  } catch {
    // Folder workspaces have no git dir.
    return null
  }
}

function failed(step: string, result: OrbstackToolResult): Error {
  const detail = result.timedOut
    ? 'timed out'
    : result.stderr.trim().split('\n').slice(-4).join('\n')
  return new Error(detail ? `${step}: ${detail}` : `${step} failed`)
}

/**
 * Creates the isolated machine and installs Claude plus Pod's hooks in it. The caller owns the
 * registry record and deletes the machine if this throws.
 */
export async function provisionSandbox(args: {
  run: OrbstackToolRunner
  name: string
  mounts: readonly string[]
  /** The host's Claude Code version; null installs the stable channel. */
  claudeVersion: string | null
  skipAgentInstall?: boolean
}): Promise<{ agentVersion: string | null }> {
  const { run, name } = args
  const mountArgs = args.mounts.flatMap((path) => ['--mount', `${path}:${path}`])
  const step = async (label: string, toolArgs: string[], input?: string): Promise<string> => {
    const result = await run('orb', toolArgs, {
      timeoutMs: LONG_STEP_MS,
      ...(input ? { input } : {})
    })
    if (result.code !== 0) {
      throw failed(label, result)
    }
    return result.stdout
  }
  await step('orb create', ['create', '--isolated', ...mountArgs, 'ubuntu:24.04', name])
  await step('install git', [
    'run',
    '-m',
    name,
    '-u',
    'root',
    'sh',
    '-c',
    'command -v git >/dev/null || { apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git; }'
  ])
  for (const path of args.mounts) {
    await step(`mount ${path}`, ['run', '-m', name, 'test', '-d', path])
  }
  let agentVersion: string | null = null
  if (!args.skipAgentInstall) {
    await step('install Claude Code', [
      'run',
      '-m',
      name,
      'bash',
      '-lc',
      'curl -fsSL https://claude.ai/install.sh | bash -s -- "$0" >/dev/null',
      args.claudeVersion ?? 'stable'
    ])
    const version = await step('claude --version', [
      'run',
      '-m',
      name,
      'bash',
      '-lc',
      '"$HOME/.local/bin/claude" --version'
    ])
    agentVersion = /\d+\.\d+\.\d+/.exec(version)?.[0] ?? null
  }
  await step(
    'write hook script',
    [
      'run',
      '-m',
      name,
      'sh',
      '-c',
      'mkdir -p "$HOME/.orca/agent-hooks" && cat > "$HOME/.orca/agent-hooks/$0" && chmod 755 "$HOME/.orca/agent-hooks/$0"',
      getPosixManagedScriptFileName()
    ],
    buildSandboxHookScript()
  )
  await step(
    'write managed settings',
    [
      'run',
      '-m',
      name,
      '-u',
      'root',
      'sh',
      '-c',
      `mkdir -p /etc/claude-code && cat > ${MANAGED_SETTINGS_PATH}`
    ],
    buildSandboxManagedSettings(agentVersion ?? args.claudeVersion)
  )
  return { agentVersion }
}
