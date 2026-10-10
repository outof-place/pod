// Builds pod-agent-launcher into Contents/Resources/bin and links each agent command to it there.
// Pod's shell wrappers keep that directory first on every terminal's PATH (ORCA_CLI_BIN_DIR), so the
// links shadow the user's own installs only inside Pod terminals. electron-builder signs the binary.
const { execFileSync } = require('node:child_process')
const { chmodSync, rmSync, symlinkSync } = require('node:fs')
const { join } = require('node:path')

const LAUNCHER = 'pod-agent-launcher'
const AGENT_COMMANDS = ['claude', 'codex']
// Electron 44+ requires macOS 13.
const MACOS_MINIMUM = '13.0'
// TASK_DEFAULT_APPLICATION, what the launcher reports once its policy took.
const APP_ROLE = 7

function installAgentLauncher(resourcesDir, arch) {
  const binDir = join(resourcesDir, 'bin')
  const launcherPath = join(binDir, LAUNCHER)
  const cpu = arch === 'x64' ? 'x86_64' : 'arm64'
  execFileSync(
    'xcrun',
    [
      'swiftc',
      '-O',
      '-target',
      `${cpu}-apple-macosx${MACOS_MINIMUM}`,
      join(__dirname, 'main.swift'),
      '-o',
      launcherPath
    ],
    { stdio: 'inherit' }
  )
  chmodSync(launcherPath, 0o755)
  for (const command of AGENT_COMMANDS) {
    const linkPath = join(binDir, command)
    rmSync(linkPath, { force: true })
    symlinkSync(LAUNCHER, linkPath)
  }
  if (process.arch === (cpu === 'x86_64' ? 'x64' : 'arm64')) {
    // Why: a kernel that stops honoring the role must fail the build, not ship a silent no-op.
    const policy = JSON.parse(
      execFileSync(launcherPath, ['--print-policy'], {
        encoding: 'utf8',
        env: { ...process.env, POD_AGENT_TURBO: '1' }
      })
    )
    if (policy.role !== APP_ROLE) {
      throw new Error(`product: ${LAUNCHER} reported role ${policy.role}, expected ${APP_ROLE}`)
    }
  }
}

module.exports = { AGENT_COMMANDS, installAgentLauncher }
