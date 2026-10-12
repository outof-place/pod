// Fork-only (Pod): Claude's hooks handed over with `--settings` by pod-agent-launcher instead of
// written into settings.json (pod-claude-flag-settings.ts). The hook registry takes this subclass;
// outside native mode every call is ClaudeHookService's.
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentHookInstallStatus } from '../../../shared/agent-hook-types'
import { readHooksJson, writeManagedScript } from '../../agent-hooks/installer-utils'
import { claudeVersionReaches } from '../../claude/claude-hook-event-versions'
import { ClaudeHookService } from '../../claude/hook-service'
import {
  CLAUDE_HOOK_SETTINGS,
  getConfigPath,
  getManagedScriptFileName,
  getStatusLineInstallMarkerPath,
  getStatusLineScriptFileName,
  getStatusLineScriptPath,
  getStatusLineSlotState
} from '../../claude/hook-settings'
import { getManagedStatusLineScript } from '../../claude/statusline-script'
import {
  getPodAgentHookInstallPath,
  installPodAgentHookBinary,
  resolveBundledPodAgentHook
} from './pod-agent-hook-native'
import { isPodClaudeFlagSettingsEnabled } from './pod-claude-flag-gate'
import {
  POD_CLAUDE_FALLBACK_SETTINGS_FILE,
  POD_CLAUDE_FALLBACK_SETTINGS_STATUSLINE_FILE,
  POD_CLAUDE_FLAG_SETTINGS_FIRST_VERSION,
  podAgentHooksDir,
  podClaudeFlagSettingsFiles
} from './pod-claude-flag-settings'
import { installPodClaudeProfile } from './pod-claude-profile-hook-service'
import { migratePodClaudeSettings, readPodClaudeMigrations } from './pod-claude-settings-migration'

const LAUNCHER = 'pod-agent-launcher'

/** The launcher this app ships (Contents/Resources/bin), or POD_AGENT_LAUNCHER_BINARY's in tests. */
export function resolveBundledPodAgentLauncher(
  env: Readonly<Record<string, string | undefined>> = process.env,
  resourcesPath: unknown = Reflect.get(process, 'resourcesPath')
): string | null {
  const candidates = [
    env.POD_AGENT_LAUNCHER_BINARY,
    typeof resourcesPath === 'string' ? join(resourcesPath, 'bin', LAUNCHER) : undefined
  ]
  return candidates.find((path): path is string => !!path && existsSync(path)) ?? null
}

function fallbackPaths(): { dir: string; hooks: string; statusLine: string } {
  const dir = podAgentHooksDir(homedir())
  return {
    dir,
    hooks: join(dir, POD_CLAUDE_FALLBACK_SETTINGS_FILE),
    statusLine: join(dir, POD_CLAUDE_FALLBACK_SETTINGS_STATUSLINE_FILE)
  }
}

function expectedFallbackFiles(): Record<string, string> {
  return podClaudeFlagSettingsFiles(
    { home: homedir() },
    {
      hooks: POD_CLAUDE_FALLBACK_SETTINGS_FILE,
      statusLine: POD_CLAUDE_FALLBACK_SETTINGS_STATUSLINE_FILE
    }
  )
}

/** Temp + rename: a launcher reading it mid-write would hand Claude half a file. */
function writeWhole(path: string, text: string): void {
  const temp = `${path}.${process.pid}-${randomUUID()}.tmp`
  try {
    writeFileSync(temp, text, { mode: 0o644 })
    renameSync(temp, path)
  } finally {
    rmSync(temp, { force: true })
  }
}

/** The launcher passes these only while they exist: removing them hands the hooks back to settings.json. */
function removeFallbackFiles(): void {
  const paths = fallbackPaths()
  rmSync(paths.hooks, { force: true })
  rmSync(paths.statusLine, { force: true })
}

/** A user who deleted Pod's statusLine before the move keeps it off (hook-service's marker rule). */
function statusLineOptedOut(settingsPath: string): boolean {
  const config = readHooksJson(settingsPath)
  return (
    config !== null &&
    getStatusLineSlotState(config, getStatusLineScriptFileName()) === 'empty' &&
    existsSync(getStatusLineInstallMarkerPath())
  )
}

export class PodClaudeHookService extends ClaudeHookService {
  /** Native mode: Pod on macOS, both binaries bundled, and a Claude that takes the file. It sticks
   *  once the files exist: through an unknown version (one failed detection), and on a host without
   *  the bundle (the CLI's `agent-hooks install`). */
  private nativeMode(version: string | undefined): boolean {
    const moved = existsSync(fallbackPaths().hooks)
    if (process.platform !== 'darwin' || process.env.POD_CLAUDE_FLAG_SETTINGS === '0') {
      return false
    }
    if (
      version === undefined
        ? !moved
        : !claudeVersionReaches(version, POD_CLAUDE_FLAG_SETTINGS_FIRST_VERSION)
    ) {
      return false
    }
    if (!isPodClaudeFlagSettingsEnabled() || resolveBundledPodAgentLauncher() === null) {
      return moved && existsSync(getPodAgentHookInstallPath())
    }
    const bundled = resolveBundledPodAgentHook()
    return bundled !== null && installPodAgentHookBinary(bundled, getPodAgentHookInstallPath())
  }

  override install(
    options: { claudeVersion?: string; configDir?: string } = {}
  ): AgentHookInstallStatus {
    if (options.configDir !== undefined) {
      return installPodClaudeProfile(options.configDir) ?? super.install(options)
    }
    if (!this.nativeMode(options.claudeVersion)) {
      removeFallbackFiles()
      return super.install(options)
    }
    const settingsPath = getConfigPath(CLAUDE_HOOK_SETTINGS)
    const paths = fallbackPaths()
    try {
      // Why first: the files must be in place before settings.json loses its entries.
      const first = !existsSync(paths.hooks) && readPodClaudeMigrations(paths.dir).length === 0
      const statusLine = first ? !statusLineOptedOut(settingsPath) : existsSync(paths.statusLine)
      writeManagedScript(getStatusLineScriptPath(), getManagedStatusLineScript('local'))
      const files = expectedFallbackFiles()
      writeWhole(paths.hooks, files[POD_CLAUDE_FALLBACK_SETTINGS_FILE])
      if (statusLine) {
        writeWhole(paths.statusLine, files[POD_CLAUDE_FALLBACK_SETTINGS_STATUSLINE_FILE])
      } else {
        rmSync(paths.statusLine, { force: true })
      }
      migratePodClaudeSettings(settingsPath, paths.dir, {
        hookScript: getManagedScriptFileName(),
        statusLineScript: getStatusLineScriptFileName()
      })
    } catch (error) {
      return {
        agent: 'claude',
        state: 'error',
        configPath: settingsPath,
        managedHooksPresent: false,
        detail: error instanceof Error ? error.message : String(error)
      }
    }
    return this.getStatus()
  }

  override getStatus(
    options: { claudeVersion?: string; configDir?: string } = {}
  ): AgentHookInstallStatus {
    const paths = fallbackPaths()
    const off = process.platform !== 'darwin' || process.env.POD_CLAUDE_FLAG_SETTINGS === '0'
    if (off || !existsSync(paths.hooks)) {
      return super.getStatus(options)
    }
    let current = ''
    try {
      current = readFileSync(paths.hooks, 'utf8')
    } catch {
      // Reported as partial below.
    }
    const intact = current === expectedFallbackFiles()[POD_CLAUDE_FALLBACK_SETTINGS_FILE]
    return {
      agent: 'claude',
      state: intact ? 'installed' : 'partial',
      configPath: paths.hooks,
      managedHooksPresent: true,
      detail: intact ? null : `${POD_CLAUDE_FALLBACK_SETTINGS_FILE} differs from this Pod's`
    }
  }

  override remove(): AgentHookInstallStatus {
    removeFallbackFiles()
    return super.remove()
  }
}

export const podClaudeHookService = new PodClaudeHookService()
