// Fork-only (Pod): an isolated OrbStack machine where Claude runs without seeing the rest of the Mac.
import { isAbsolute, join, relative, resolve } from 'node:path'
import { runProcess } from '../../../shared/child-process/run-process'
import { buildManagedCommandHook } from '../../agent-hooks/installer-utils'
import { applyClaudeFolderTrust, toClaudeTrustKey } from '../../claude/claude-folder-trust-file'
import { getClaudeManagedHookPlan } from '../../claude/claude-managed-hook-events'
import { getManagedScript } from '../../claude/hook-script'
import {
  applyManagedHooks,
  getPosixManagedScriptFileName,
  getRemoteManagedCommand
} from '../../claude/hook-settings'
import {
  CLAUDE_RELEASE_KEY_FINGERPRINT,
  SANDBOX_RELEASE_FILES,
  type SandboxClaudeRelease
} from './pod-orbstack-claude-release'
import type { OrbstackToolResult, OrbstackToolRunner } from './pod-orbstack-tools'

/** What a sandbox reaches the Mac's loopback as (probed on OrbStack 2.2.3, isolated machines too). */
export const SANDBOX_HOST_ALIAS = 'host.orb.internal'
// Why managed: Claude merges it over user settings, so the agent's own config cannot drop Pod's hooks.
const MANAGED_SETTINGS_PATH = '/etc/claude-code/managed-settings.json'
const LONG_STEP_MS = 10 * 60_000
// Why /var/tmp: a file orb pushes to /tmp never shows up inside the VM (probed on OrbStack 2.2.3).
const RELEASE_DIR_IN_VM = '/var/tmp/pod-claude-release'

/**
 * Checks the pushed release against Anthropic's signed manifest with the VM's own gpgv, then installs
 * it in the native installer's layout. Arguments: version, platform, key fingerprint, release dir.
 */
export const VERIFY_AND_INSTALL_CLAUDE = `set -eu
version="$1" platform="$2" fingerprint="$3" dir="$4"
status=$(gpgv --status-fd 1 --keyring "$dir/release-key.gpg" "$dir/manifest.json.sig" "$dir/manifest.json" 2>/dev/null) ||
  { echo "the Claude Code release manifest signature is not valid" >&2; exit 1; }
printf '%s\\n' "$status" | grep -Eq "^\\[GNUPG:\\] VALIDSIG .* $fingerprint\\$" ||
  { echo "the Claude Code release manifest is not signed by the release key" >&2; exit 1; }
checksum=$(python3 -I -c 'import json, sys
m = json.load(open(sys.argv[1]))
if m.get("version") != sys.argv[2]: sys.exit("the manifest is for " + str(m.get("version")))
print(m["platforms"][sys.argv[3]]["checksum"])' "$dir/manifest.json" "$version" "$platform")
printf '%s  %s\\n' "$checksum" "$dir/claude" | sha256sum --check --quiet --strict ||
  { echo "the Claude Code binary does not match the signed manifest" >&2; exit 1; }
mkdir -p "$HOME/.local/share/claude/versions" "$HOME/.local/bin"
install -m 755 "$dir/claude" "$HOME/.local/share/claude/versions/$version"
ln -sfn "$HOME/.local/share/claude/versions/$version" "$HOME/.local/bin/claude"
`

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

/** A VM-local ~/.claude.json that trusts only the mounted worktree; the Mac's file never enters. */
export function buildSandboxClaudeConfig(worktreePath: string): string {
  const change = applyClaudeFolderTrust({}, [toClaudeTrustKey(worktreePath, 'posix')])
  return `${JSON.stringify(change.kind === 'changed' ? change.config : {}, null, 2)}\n`
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
  /** The worktree first, as resolveSandboxMounts returns them. */
  mounts: readonly string[]
  /** The cached release to install; null skips Claude (E2E stand-in agents). */
  release: SandboxClaudeRelease | null
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
  const { release } = args
  if (release) {
    await step('copy Claude Code', [
      'push',
      '-m',
      name,
      ...SANDBOX_RELEASE_FILES.map((file) => join(release.dir, file)),
      `${RELEASE_DIR_IN_VM}/`
    ])
    await step('verify Claude Code', [
      'run',
      '-m',
      name,
      'bash',
      '-c',
      VERIFY_AND_INSTALL_CLAUDE,
      'pod-verify-claude',
      release.version,
      release.platform,
      CLAUDE_RELEASE_KEY_FINGERPRINT,
      RELEASE_DIR_IN_VM
    ])
    // orb push writes as root, so only root can clear the copy.
    await step('clean up Claude Code copy', [
      'run',
      '-m',
      name,
      '-u',
      'root',
      'rm',
      '-rf',
      RELEASE_DIR_IN_VM
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
    if (agentVersion !== release.version) {
      throw new Error(`claude --version: expected ${release.version}, got ${version.trim()}`)
    }
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
  const [worktreePath] = args.mounts
  if (worktreePath) {
    await step(
      'trust the worktree',
      ['run', '-m', name, 'sh', '-c', '[ -e "$HOME/.claude.json" ] || cat > "$HOME/.claude.json"'],
      buildSandboxClaudeConfig(worktreePath)
    )
  }
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
    buildSandboxManagedSettings(agentVersion)
  )
  return { agentVersion }
}
