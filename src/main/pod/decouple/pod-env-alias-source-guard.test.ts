import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { scanSourceTree } from '../../../shared/source-scan/source-tree-scan'
import { POD_ALIASED_ORCA_ENV_NAMES, podSpellingOf } from '../../../shared/pod-env-aliases'

// Fork-only (Pod): guards for the 1.0 env aliases (pod-env-aliases.ts).
const repoRoot = resolve(__dirname, '..', '..', '..', '..')

/** Files whose bytes Pod shares with Orca (hook scripts, agent configs, plugins, relay wrappers). */
const SHARED_WITH_ORCA_FILES = [
  'src/main/agent-hooks/hook-post-command.ts',
  'src/main/agent-hooks/hook-process-capture.ts',
  'src/main/agent-hooks/hook-stdin-contract.ts',
  'src/main/agent-hooks/installer-utils.ts',
  'src/main/claude/hook-script.ts',
  'src/main/claude/windows-hook-files.ts',
  'src/main/claude/statusline-script.ts',
  'src/main/codex/codex-hook-command-form.ts',
  'src/main/codex/codex-hook-script.ts',
  'src/main/gemini/hook-service.ts',
  'src/main/cursor/hook-script.ts',
  'src/main/grok/grok-hook-script.ts',
  'src/main/grok/grok-hook-remote-install.ts',
  'src/main/grok/windows-grok-hook-script.ts',
  'src/main/copilot/copilot-managed-script.ts',
  'src/main/copilot/copilot-managed-hook-definitions.ts',
  'src/main/copilot/copilot-remote-hook-install.ts',
  'src/main/kiro/hook-service.ts',
  'src/main/kimi/hook-service.ts',
  'src/main/droid/hook-service.ts',
  'src/main/devin/hook-service.ts',
  'src/main/dsh/hook-service.ts',
  'src/main/jcode/hook-service.ts',
  'src/main/muse/hook-service.ts',
  'src/main/muse/hook-config-json.ts',
  'src/main/antigravity/hook-script.ts',
  'src/main/antigravity/hook-service.ts',
  'src/main/antigravity/windows-hook-json-post.ts',
  'src/main/command-code/command-code-managed-script.ts',
  'src/main/zcode/hook-service.ts',
  'src/main/opencode/status-plugin-endpoint-source.ts',
  'src/main/opencode/status-plugin-factory-source.ts',
  'src/main/opencode/status-plugin-post-source.ts',
  'src/main/opencode2/status-plugin-tui-source.ts',
  'src/shared/opencode-startup-prompt.ts',
  'src/shared/agent-hook-endpoint-file.ts',
  'src/main/pi/agent-status-extension-source.ts',
  'src/main/pi/agent-status-handler-source.ts',
  'src/main/pi/agent-status-wsl-curl-source.ts',
  'src/main/pi/omp-session-status-owner-source.ts',
  'src/main/pi/prefill-extension-source.ts',
  'src/main/pi/titlebar-extension-lifetime-source.ts',
  'src/main/pi/titlebar-extension-source.ts',
  'src/main/hermes/hermes-managed-plugin-source.ts',
  'src/main/amp/agent-status-plugin-source.ts',
  'src/main/runtime/claude-agent-teams-shim-env.ts',
  'src/main/ssh/ssh-remote-cli-launcher.ts',
  'src/main/cli/wsl-cli-scripts.ts',
  'src/main/cli/legacy-appimage-cli-wrapper.ts',
  'src/main/cli/cli-dev-launcher.ts',
  'src/relay/pty-shell-overlay-wrappers.ts',
  'src/main/zsh-startup-wrapper-builder.ts',
  'src/main/shell-templates.ts',
  'src/main/shell-startup-features.ts',
  'src/shared/claude-shell-function.ts',
  'src/shared/codex-shell-function.ts',
  'src/shared/managed-data-account-shell.ts',
  'src/shared/orca-cli-shell-path.ts',
  'src/main/pty/omp-shell-wrapper.ts',
  'src/main/pty/legacy-terminal-posix-tombstone.ts',
  'src/main/pty/legacy-terminal-windows-tombstone.ts'
]
/** POD_ names those files already carried before the aliases, all Pod's own. */
const SHARED_FILE_POD_NAMES = new Set(['POD_CLAUDE_SETTINGS_PID'])
const ALIAS_MODULES = new Set([
  'src/shared/pod-env-aliases.ts',
  'src/shared/pod-env-alias-names.ts'
])
const POD_TOKEN = /(?<![A-Za-z0-9_])POD_[A-Z0-9_]*[A-Z0-9](?![A-Za-z0-9_])/g
const SCANNED = [
  { root: 'src', extensions: /\.(?:tsx?|[cm]?js)$/ },
  { root: 'native', extensions: /\.(?:c|h|m|swift|sh)$/ },
  { root: 'product', extensions: /\.(?:tsx?|[cm]?js|sh)$/ }
]

function scannedFiles(): { relativePath: string; source: string }[] {
  return SCANNED.flatMap(({ root, extensions }) =>
    scanSourceTree(join(repoRoot, root), { extensions })
      .map((file) => ({ ...file, relativePath: `${root}/${file.relativePath}` }))
      .filter((file) => !file.relativePath.endsWith('.test-support.ts'))
  )
}

describe('Pod env alias source guards', () => {
  it('writes aliased POD_ names only in pod-env-aliases.ts and reads them only next to ORCA_', () => {
    const aliasedPodNames = new Map(
      POD_ALIASED_ORCA_ENV_NAMES.map((name) => [podSpellingOf(name), name])
    )
    const offenders: string[] = []
    for (const file of scannedFiles()) {
      if (ALIAS_MODULES.has(file.relativePath)) {
        continue
      }
      file.source.split('\n').forEach((line, index) => {
        for (const match of line.matchAll(POD_TOKEN)) {
          const orcaName = aliasedPodNames.get(match[0])
          // Why skip `@@POD_X@@`: a template placeholder (pod-claude-launch-settings.ts), not env.
          if (orcaName === undefined || line.slice(0, match.index).endsWith('@@')) {
            continue
          }
          const rest = line.slice((match.index ?? 0) + match[0].length)
          const written =
            /^['"`\]]*\s*(?::(?!:)|=(?![=>]))/.test(rest) ||
            /\bdelete\s+\S*$/.test(line.slice(0, match.index))
          if (written || !line.includes(orcaName)) {
            offenders.push(
              `${file.relativePath}:${index + 1} ${match[0]} ${written ? 'written' : 'read without ORCA_'}`
            )
          }
        }
      })
    }
    expect(offenders).toEqual([])
  })

  it('imports the start pass first in the main entry', () => {
    const entry = readFileSync(join(repoRoot, 'src/main/index.ts'), 'utf8')
    const firstImport = entry.split('\n').find((line) => line.startsWith('import '))
    expect(firstImport).toBe("import './pod/decouple/adopt-pod-user-env'")
  })

  it('keeps every byte shared with Orca free of new POD_ names', () => {
    const offenders: string[] = []
    for (const path of SHARED_WITH_ORCA_FILES) {
      const absolute = join(repoRoot, path)
      expect(existsSync(absolute), path).toBe(true)
      for (const match of readFileSync(absolute, 'utf8').matchAll(POD_TOKEN)) {
        if (!SHARED_FILE_POD_NAMES.has(match[0])) {
          offenders.push(`${path} ${match[0]}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
