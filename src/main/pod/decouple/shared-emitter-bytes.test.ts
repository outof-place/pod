// Fork-only (Pod): in 1.0 every byte Pod writes where Orca.app writes too (agent configs, plugins,
// remote hook scripts, CLI launchers, relay wrappers, ~/.codex) stays Orca's, so ORCA_ stays
// canonical (pod-env-aliases.ts). These pins are main 594496f90b's output; the managed scripts in
// ~/.orca/agent-hooks are pinned in managed-hook-script-refresh.test.ts.
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as osModule from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as CodexHookHashLookup from '../../codex/codex-hook-hash-lookup'

const { homedirMock } = vi.hoisted(() => ({ homedirMock: vi.fn<() => string>() }))

vi.mock('../../codex/codex-hook-hash-lookup', async (importOriginal) => ({
  ...(await importOriginal<typeof CodexHookHashLookup>()),
  resolveCodexHookAnswerForLaunch: async () =>
    (await import('../../codex/hook-service-test-harness')).codexHookAnswerForTests()
}))
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/orca-user-data' } }))
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof osModule>()
  return { ...actual, homedir: homedirMock.mockImplementation(actual.homedir) }
})

import { MANAGED_AGENT_HOOK_INSTALLERS } from '../../agent-hooks/managed-agent-hook-registry'
import { buildPosixAgentHookPostCommand } from '../../agent-hooks/hook-post-command'
import { buildHookProcessCapture } from '../../agent-hooks/hook-process-capture'
import {
  buildPosixHookPayloadCapture,
  buildPosixHookSpoolLines,
  buildWindowsHookEnvironmentGuardLines,
  buildWindowsHookStdinDrainEpilogue
} from '../../agent-hooks/hook-stdin-contract'
import {
  buildWindowsAgentHookCurlPostCommand,
  buildWindowsAgentHookPostCommand
} from '../../agent-hooks/installer-utils'
import type { AgentHookSource } from '../../../shared/agent-hook-relay'
import { getManagedScript as claudeScript } from '../../claude/hook-script'
import { getWindowsClaudeHookEntry } from '../../claude/windows-hook-files'
import { getManagedStatusLineScript } from '../../claude/statusline-script'
import { buildCodexHookCommand } from '../../codex/codex-hook-command-form'
import { getManagedScript as codexScript } from '../../codex/codex-hook-script'
import {
  getManagedScript as cursorScript,
  getManagedCommand as cursorCommand
} from '../../cursor/hook-script'
import { CURSOR_EVENTS } from '../../cursor/hook-events'
import { getGrokManagedCommand, getGrokManagedScript } from '../../grok/grok-hook-script'
import { buildWindowsGrokHookScript } from '../../grok/windows-grok-hook-script'
import { getManagedScript as copilotScript } from '../../copilot/copilot-managed-script'
import {
  COPILOT_EVENTS,
  getManagedCommand as copilotCommand
} from '../../copilot/copilot-managed-hook-definitions'
import { MUSE_MANAGED_HOOK_ENV_VARS, serializeMuseSettings } from '../../muse/hook-config-json'
import {
  getManagedScript as antigravityScript,
  getWindowsWrapperScript as antigravityWindowsWrapper
} from '../../antigravity/hook-script'
import { WINDOWS_ANTIGRAVITY_JSON_POST_SCRIPT } from '../../antigravity/windows-hook-json-post'
import { buildCommandCodeManagedScript } from '../../command-code/command-code-managed-script'
import { getStatusPluginEndpointSource } from '../../opencode/status-plugin-endpoint-source'
import { getStatusPluginFactorySource } from '../../opencode/status-plugin-factory-source'
import { getStatusPluginPostSource } from '../../opencode/status-plugin-post-source'
import { getOpenCode2TuiSource } from '../../opencode2/status-plugin-tui-source'
import { parseAgentHookEndpointFile } from '../../../shared/agent-hook-endpoint-file'
import { getPiAgentStatusExtensionSource } from '../../pi/agent-status-extension-source'
import { getPiAgentStatusWslCurlSourceLines } from '../../pi/agent-status-wsl-curl-source'
import { getPiPrefillExtensionSource } from '../../pi/prefill-extension-source'
import { getPiTitlebarExtensionSource } from '../../pi/titlebar-extension-source'
import { getPluginInitSource, getPluginManifest } from '../../hermes/hermes-managed-plugin-source'
import { getAmpPluginSource } from '../../amp/agent-status-plugin-source'
import {
  ensureClaudeAgentTeamsShimDir,
  windowsClaudeAgentTeamsShimScript
} from '../../runtime/claude-agent-teams-shim-env'
import { createRemoteCliInstallPlan } from '../../ssh/ssh-remote-cli-launcher'
import {
  buildColocatedWslLauncher,
  buildWslBridgeScript,
  buildWslLauncher
} from '../../cli/wsl-cli-scripts'
import { buildLegacyAppImageCliWrapper } from '../../cli/legacy-appimage-cli-wrapper'
import {
  buildUnixCliLauncher,
  buildWindowsDevLauncher,
  buildWindowsForwarder
} from '../../cli/cli-dev-launcher'
import { ensureOverlayRestoreWrappers } from '../../../relay/pty-shell-overlay-wrappers'
import * as shellTemplates from '../../shell-templates'
import {
  getFishClaudeShellFunction,
  getPosixClaudeShellFunction,
  getPowerShellClaudeShellFunction
} from '../../../shared/claude-shell-function'
import {
  getFishCodexShellLaunchPreflight,
  getPosixCodexShellLaunchPreflight,
  getPowerShellCodexShellLaunchPreflight
} from '../../../shared/codex-shell-function'
import * as managedDataAccountShell from '../../../shared/managed-data-account-shell'
import { ORCA_CLI_POSIX_PATH_RESTORE } from '../../../shared/orca-cli-shell-path'
import { getPosixOmpShellWrapper, getPowerShellOmpShellWrapper } from '../../pty/omp-shell-wrapper'
import { renderLegacyTerminalPosixTombstone } from '../../pty/legacy-terminal-posix-tombstone'
import {
  renderLegacyTerminalWindowsCmdTombstone,
  renderLegacyTerminalWindowsPowerShellTombstone
} from '../../pty/legacy-terminal-windows-tombstone'
import type { RemoteHostPlatform } from '../../ssh/ssh-remote-platform'

// Why: set it to a file path to regenerate the pins below.
const PRINT_TO = process.env.SHARED_EMITTER_DIGESTS_OUT
const AGENT_HOOK_SOURCES: readonly AgentHookSource[] = [
  'claude',
  'codex',
  'qoder',
  'qoder-cn',
  'qwen-code',
  'codebuddy',
  'gemini',
  'antigravity',
  'amp',
  'opencode',
  'opencode2',
  'mimo-code',
  'cursor',
  'pi',
  'omp',
  'prime-agent',
  'droid',
  'command-code',
  'grok',
  'copilot',
  'hermes',
  'devin',
  'kimi',
  'muse',
  'zcode',
  'dsh',
  'jcode',
  'kiro'
]
const FIXED_HOME = '/home/pod-test'
const LINUX_HOST: RemoteHostPlatform = {
  os: 'linux',
  arch: 'x64',
  relayPlatform: 'linux-x64',
  pathFlavor: 'posix',
  commandDialect: 'posix',
  pathSeparator: '/',
  pathDelimiter: ':'
}
const WINDOWS_HOST: RemoteHostPlatform = {
  os: 'win32',
  arch: 'x64',
  relayPlatform: 'win32-x64',
  pathFlavor: 'windows',
  commandDialect: 'powershell',
  pathSeparator: '\\',
  pathDelimiter: ';'
}
const AGENT_HOME_ENV = ['GROK_HOME', 'KIMI_CODE_HOME', 'XDG_CONFIG_HOME', 'CODEX_HOME'] as const

let userDataDir = ''
let previousUserDataPath: string | undefined
beforeEach(() => {
  previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  userDataDir = mkdtempSync(join(tmpdir(), 'pod-shared-bytes-user-data-'))
  process.env.ORCA_USER_DATA_PATH = userDataDir
  homedirMock.mockReturnValue(FIXED_HOME)
})
afterEach(() => {
  if (previousUserDataPath === undefined) {
    delete process.env.ORCA_USER_DATA_PATH
  } else {
    process.env.ORCA_USER_DATA_PATH = previousUserDataPath
  }
  rmSync(userDataDir, { recursive: true, force: true })
})

async function withPlatform<T>(platform: NodeJS.Platform, run: () => T | Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  try {
    return await run()
  } finally {
    if (original) {
      Object.defineProperty(process, 'platform', original)
    }
  }
}

function normalized(text: string, roots: string[]): string {
  let result = text.replaceAll(/-EncodedCommand ([A-Za-z0-9+/=]+)/g, (_match, encoded: string) =>
    Buffer.from(encoded, 'base64').toString('utf16le')
  )
  for (const root of [...roots, userDataDir, process.execPath]) {
    result = result.replaceAll(root, '<root>')
  }
  return result
}

function digest(value: unknown, roots: string[] = []): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return createHash('sha256').update(normalized(text, roots)).digest('hex')
}

/** `<file count>:<sha256>`, so a pin also shows how many files the emitter wrote. */
function treeDigest(root: string, skip: (path: string) => boolean): string {
  const hash = createHash('sha256')
  let files = 0
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      const path = join(directory, entry.name)
      const name = relative(root, path)
      if (skip(name)) {
        continue
      }
      if (entry.isDirectory()) {
        visit(path)
      } else if (entry.isFile()) {
        hash.update(`${name}\0${normalized(readFileSync(path, 'utf8'), [root])}\0`)
        files += 1
      }
    }
  }
  visit(root)
  return `${files}:${hash.digest('hex')}`
}

/** Every file the managed installers write outside ~/.orca/agent-hooks: agent configs, plugins. */
async function installedConfigDigest(platform: NodeJS.Platform): Promise<string> {
  const home = mkdtempSync(join(tmpdir(), 'pod-shared-bytes-home-'))
  homedirMock.mockReturnValue(home)
  const savedEnv = AGENT_HOME_ENV.map((key) => [key, process.env[key]] as const)
  for (const key of AGENT_HOME_ENV) {
    delete process.env[key]
  }
  try {
    await withPlatform(platform, async () => {
      for (const [, install] of MANAGED_AGENT_HOOK_INSTALLERS) {
        await install()
      }
    })
    // Why skip agent-hooks/: managed-hook-script-refresh.test.ts pins those scripts.
    return treeDigest(home, (name) => name === join('.orca', 'agent-hooks'))
  } finally {
    homedirMock.mockReturnValue(FIXED_HOME)
    for (const [key, value] of savedEnv) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
    rmSync(home, { recursive: true, force: true })
  }
}

async function shimDirDigest(platform: NodeJS.Platform): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'pod-shared-bytes-shim-'))
  try {
    await withPlatform(platform, () => ensureClaudeAgentTeamsShimDir(root))
    return treeDigest(root, () => false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function relayWrapperDigest(): string {
  const root = mkdtempSync(join(tmpdir(), 'pod-shared-bytes-relay-'))
  try {
    ensureOverlayRestoreWrappers(root)
    return treeDigest(root, () => false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

async function computeDigests(): Promise<Record<string, string>> {
  const scriptPath = `${FIXED_HOME}/.orca/agent-hooks/hook.sh`
  const windowsEnv = { SystemRoot: 'C:\\Windows' }
  const pure: Record<string, () => unknown> = {
    'agent-hooks/hook-post-command': () =>
      AGENT_HOOK_SOURCES.map((source) => buildPosixAgentHookPostCommand(source)),
    'agent-hooks/hook-process-capture': () => buildHookProcessCapture(),
    'agent-hooks/hook-stdin-contract': () => [
      buildPosixHookPayloadCapture(),
      AGENT_HOOK_SOURCES.map((source) => buildPosixHookSpoolLines(source)),
      buildWindowsHookEnvironmentGuardLines(),
      buildWindowsHookStdinDrainEpilogue()
    ],
    'agent-hooks/installer-utils:windows': () =>
      AGENT_HOOK_SOURCES.map((source) => [
        buildWindowsAgentHookPostCommand(source),
        buildWindowsAgentHookCurlPostCommand(source)
      ]),
    'claude/hook-script:posix': () => claudeScript('posix'),
    'claude/windows-hook-entry': () => getWindowsClaudeHookEntry(),
    'claude/statusline:posix': () => getManagedStatusLineScript('posix'),
    'codex/command-form:posix': () => buildCodexHookCommand(scriptPath, 'darwin', windowsEnv),
    'codex/command-form:win32': () =>
      buildCodexHookCommand(
        'C:/Users/pod-test/.orca/agent-hooks/codex-hook.cmd',
        'win32',
        windowsEnv
      ),
    'codex/hook-script:posix': () => codexScript('posix'),
    'cursor/hook-script:posix': () => cursorScript('posix'),
    'cursor/commands': () => CURSOR_EVENTS.map((event) => cursorCommand(scriptPath, event)),
    'grok/hook-script:posix': () => getGrokManagedScript('posix'),
    'grok/command': () => getGrokManagedCommand(scriptPath),
    'grok/windows-hook-script': () => buildWindowsGrokHookScript(),
    'copilot/script:posix': () => copilotScript('posix'),
    'copilot/commands': () => COPILOT_EVENTS.map((event) => copilotCommand(scriptPath, event)),
    'muse/hook-config': () => [MUSE_MANAGED_HOOK_ENV_VARS, serializeMuseSettings(null, scriptPath)],
    'antigravity/hook-script:posix': () => antigravityScript('posix', '/opt/pod-node'),
    'antigravity/windows': () => [
      antigravityWindowsWrapper('BeforeTool'),
      WINDOWS_ANTIGRAVITY_JSON_POST_SCRIPT
    ],
    'command-code/script:posix': () => buildCommandCodeManagedScript('posix'),
    'opencode/status-plugin': () => [
      getStatusPluginEndpointSource(),
      getStatusPluginFactorySource({ emitSessionStart: true }),
      getStatusPluginFactorySource({
        emitSessionStart: false,
        emitNextEvents: true,
        expectedAgent: 'opencode2'
      }),
      getStatusPluginPostSource('/hook/opencode'),
      getOpenCode2TuiSource()
    ],
    'shared/agent-hook-endpoint-file:parse': () => parseAgentHookEndpointFile.toString(),
    'pi/extensions': () => [
      ...(['pi', 'omp', 'prime-agent'] as const).map((kind) =>
        getPiAgentStatusExtensionSource(kind)
      ),
      ...(['pi', 'omp', 'prime-agent'] as const).map((kind) => getPiTitlebarExtensionSource(kind)),
      ...(['pi', 'omp'] as const).map((kind) => getPiPrefillExtensionSource(kind)),
      getPiAgentStatusWslCurlSourceLines()
    ],
    'hermes/plugin': () => [getPluginManifest(), getPluginInitSource()],
    'amp/plugin': () => getAmpPluginSource(),
    'runtime/agent-teams-shim:win32': () => windowsClaudeAgentTeamsShimScript(),
    'ssh/remote-cli:linux': () =>
      createRemoteCliInstallPlan({
        binDir: '/home/pod-test/.orca-relay/bin',
        relayDir: '/home/pod-test/.orca-relay',
        nodePath: '/home/pod-test/.orca-relay/node',
        sockPath: '/home/pod-test/.orca-relay/relay.sock',
        credentialFile: '/home/pod-test/.orca-relay/credential',
        hostPlatform: LINUX_HOST
      }),
    'ssh/remote-cli:win32': () =>
      createRemoteCliInstallPlan({
        binDir: 'C:\\Users\\pod-test\\.orca-relay\\bin',
        relayDir: 'C:\\Users\\pod-test\\.orca-relay',
        nodePath: 'C:\\Users\\pod-test\\.orca-relay\\node.exe',
        sockPath: '\\\\.\\pipe\\orca-relay',
        hostPlatform: WINDOWS_HOST
      }),
    'cli/wsl-scripts': () => [
      buildWslLauncher('/mnt/c/Users/pod-test/AppData/Local/Pod/bin/orca.exe'),
      buildColocatedWslLauncher(
        '/mnt/c/Users/pod-test/AppData/Local/Pod/bin/orca.exe',
        '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
      ),
      buildWslBridgeScript({ userDataPath: 'C:\\Users\\pod-test\\AppData\\Roaming\\Pod' })
    ],
    'cli/legacy-appimage-wrapper': () => buildLegacyAppImageCliWrapper('/opt/Pod.AppImage'),
    'cli/dev-launchers': () => [
      buildUnixCliLauncher('/opt/pod/electron', '/opt/pod/cli.js', '/home/pod-test/.config/Pod'),
      buildWindowsDevLauncher(
        'C:\\pod\\electron.exe',
        'C:\\pod\\cli.js',
        'C:\\Users\\pod-test\\Pod'
      ),
      buildWindowsForwarder('C:\\pod\\orca.cmd')
    ],
    'shell/templates': () =>
      Object.entries(shellTemplates)
        .filter(([, value]) => typeof value === 'string')
        .sort(([a], [b]) => a.localeCompare(b)),
    'shell/agent-functions': () => [
      getPosixClaudeShellFunction(),
      getFishClaudeShellFunction(),
      getPowerShellClaudeShellFunction(),
      getPosixCodexShellLaunchPreflight(),
      getFishCodexShellLaunchPreflight(),
      getPowerShellCodexShellLaunchPreflight(),
      Object.entries(managedDataAccountShell).sort(([a], [b]) => a.localeCompare(b)),
      ORCA_CLI_POSIX_PATH_RESTORE,
      getPosixOmpShellWrapper(),
      getPowerShellOmpShellWrapper()
    ],
    'pty/tombstones': () => [
      renderLegacyTerminalPosixTombstone('git', '/bin/sh'),
      renderLegacyTerminalPosixTombstone('gh', '/bin/sh'),
      renderLegacyTerminalWindowsCmdTombstone('git'),
      renderLegacyTerminalWindowsPowerShellTombstone('gh')
    ]
  }
  const digests: Record<string, string> = {}
  for (const [key, build] of Object.entries(pure)) {
    digests[key] = await withPlatform('darwin', () => digest(build(), [FIXED_HOME]))
  }
  for (const platform of ['darwin', 'linux', 'win32'] as const) {
    digests[`installers/configs:${platform}`] = await installedConfigDigest(platform)
    digests[`runtime/agent-teams-shim-dir:${platform}`] = await shimDirDigest(platform)
  }
  digests['relay/shell-ready-wrappers'] = relayWrapperDigest()
  return digests
}

// Why a change here fails: Orca.app writes the same files, so Pod's bytes must stay Orca's in 1.0.
const SHARED_EMITTER_DIGESTS: Record<string, string> = {
  'agent-hooks/hook-post-command':
    '4d74510809f21ad246d259ec54cd178601ab5e207dc276b2fcda27d6e06aa7fa',
  'agent-hooks/hook-process-capture':
    '784c4a376c86a718e65217bc1d0ff6ee1e5ca047e4010624b938ddcf670fd812',
  'agent-hooks/hook-stdin-contract':
    '83580c40150e38cf2d90e11bf146255eb7b216837b637d4af2b73e2e900e528a',
  'agent-hooks/installer-utils:windows':
    '49b4368f8696abdd8aa760a02746e4615f9cd16347f673cb21444e4ca87d73bc',
  'claude/hook-script:posix': '65215fd5e0f186c5195265290f697bef37d57cadcc75baf2e4ecdf700d671c90',
  'claude/windows-hook-entry': 'fbc787a241e7291597d7f5b5cd9f19fa9cf29d93f7185bc5ca325b99ff1ce9ea',
  'claude/statusline:posix': 'aebc77fc5b36182100214ae7703fe23a95a55b0836774bfc3cb7af24531a4bb1',
  'codex/command-form:posix': '3da389906382108f31af765cd0d0f5af2b493341bbca806c7694eec03bc4ab82',
  'codex/command-form:win32': '898f8063896d3e89ba9e60fbfe08d270c7ea6594b6517098ab787e7cab617a1a',
  'codex/hook-script:posix': '33d44c305023507bd8fc33a4c49b4343519b2f99b99295c62b695ffe13ba7e63',
  'cursor/hook-script:posix': '5da35205644a9dfa177466a98739af1c5872ff94d9b1a518bead4fb6380da8c0',
  'cursor/commands': '8e62e9e024b080b4421667ba4208720a7baa77f2cb1ee02e844122882d5e7946',
  'grok/hook-script:posix': 'b635113ededa1c347053acc138800cb8c919a4e673c1ab857273a458a00c8628',
  'grok/command': 'd5c5afde0fdf20d7595d5b62b82cd8ac215d1ec17ec6b7f90a760788e76ae274',
  'grok/windows-hook-script': '14d6011707e15f5fce5a1f0b374cfaccbbe5676a2abb532b410dff06434fc99a',
  'copilot/script:posix': 'ac22c66e8129baa33b967c533239fbb296baed903657e1635e06d9ae87dbfcaf',
  'copilot/commands': '17ef6895f2684205bcdffb68e20bcece4d5ec88c534608778a016f22032d3f03',
  'muse/hook-config': '9fd15f1c52b10059c02fed9eb76684d06f3d79b5851a8513d487d794f06eb64b',
  'antigravity/hook-script:posix':
    '6ae781f5ce963ea60ca99f0f0174bf01cfb076466ba8a7e1a3a2cf44b7d2bb0f',
  'antigravity/windows': '0a9a40317a945a4f0c0246acf4f1563c5ffcedc6cffcd2c724c92aebca3dfa19',
  'command-code/script:posix': '6002a093cf232c9f45af1208fd07c1221674217015153064c039e31e7b0a5485',
  'opencode/status-plugin': '61b2c07fff31fc22976d2dc6ae86b5d0b8a4883c42606f2b23948302a7cd8e5f',
  'shared/agent-hook-endpoint-file:parse':
    'c5c6dae152896cc56e1819e11f6123be4c42ffcd913a2f45cea2d136a590a2f7',
  'pi/extensions': 'a743ebd6a1de4603cf8213b544d53b8dbd35c038b58b618bb0444345d481412f',
  'hermes/plugin': '09e109535e91bb2f3598aa8b381766067681f22ca39dd8e561e96038787cb83a',
  'amp/plugin': 'faac4b0aecbfe0a2bce911b40883ed008c0d4cceeb8b1c895c2636bd783d418b',
  'runtime/agent-teams-shim:win32':
    '06010ec374a7d8cd8c268b7c3e0b7d84e36276a164fe4cb7c17c2ec38e800117',
  'ssh/remote-cli:linux': '94431dd40c32e668b7aa71a1c9a99c99ef9f987d7202d299c5c298e7889cadc4',
  'ssh/remote-cli:win32': '0928c7c4e3207c5418bcaa71ee0ce3fd34855605974639bfba4b45cccabd19f6',
  'cli/wsl-scripts': '8ff93cbe7bd5caa53b4595b375cd9f2d023a2fdf74901a8a6fb21243d2294661',
  'cli/legacy-appimage-wrapper': '087b504161a006f15524fece58d1143a8fd98d0a9aa6472a0d9cae3db6791482',
  'cli/dev-launchers': '208d1a90db641f40d13bbebe4fb62c372f068b28a48d87cc89f966eed31dc1de',
  'shell/templates': '95bdaa81188198d17c742c5a6e892eee33c5219e11cff221cb7e9983de505ee0',
  'shell/agent-functions': 'b21ebfa2dc4f2725a3defc1be566f8825e4be414e264875e1e5c2a4b4e0e42c1',
  'pty/tombstones': 'b3b493bb0902c0e3e2fc27b5120642a26b3b8ec34575e20a47392623bb4f816f',
  'installers/configs:darwin':
    '23:797abe89e97b2b9a7ee2a456b20d017b50d7382f84b2050e1fcef0ad99f327e4',
  'runtime/agent-teams-shim-dir:darwin':
    '1:bab9dd2ccb2721e0595586fba7c1af22da1e03f99b9f45f4829cc65d516a7320',
  'installers/configs:linux': '23:797abe89e97b2b9a7ee2a456b20d017b50d7382f84b2050e1fcef0ad99f327e4',
  'runtime/agent-teams-shim-dir:linux':
    '1:bab9dd2ccb2721e0595586fba7c1af22da1e03f99b9f45f4829cc65d516a7320',
  'installers/configs:win32': '23:8fc85c348d88511d43e52ee23e8ceaf952aa773c1374f3ce495f3fad6c6ddf13',
  'runtime/agent-teams-shim-dir:win32':
    '2:cbeaab4bb93a57451e312063ebbe25e779a311e29d8521a8aacf9687154c21fa',
  'relay/shell-ready-wrappers': '3:88a4667794461feb87627219e3e4a57c691410da90cd9fa6164fd4a0747852c4'
}

describe('bytes Pod shares with Orca', () => {
  it('match the pins from before the POD_ aliases', async () => {
    const actual = await computeDigests()
    if (PRINT_TO) {
      writeFileSync(PRINT_TO, `${JSON.stringify(actual, null, 2)}\n`)
      return
    }
    expect(actual).toEqual(SHARED_EMITTER_DIGESTS)
  }, 120_000)

  it('are deterministic', async () => {
    expect(await computeDigests()).toEqual(await computeDigests())
  }, 240_000)
})
