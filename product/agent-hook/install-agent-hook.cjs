// Builds pod-agent-hook (native/pod-agent-hook-macos) into Contents/Resources/bin; the runtime copies it
// beside claude-hook.sh as Claude's managed status hook (src/main/pod/agent-hook). electron-builder signs it.
const { execFileSync } = require('node:child_process')
const { chmodSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')

const HOOK = 'pod-agent-hook'
const SOURCE = join(
  __dirname,
  '..',
  '..',
  'native',
  'pod-agent-hook-macos',
  'src',
  'pod-agent-hook.c'
)
// Electron 44+ requires macOS 13.
const MACOS_MINIMUM = '13.0'

function installAgentHook(resourcesDir, arch) {
  const binDir = join(resourcesDir, 'bin')
  const hookPath = join(binDir, HOOK)
  const cpu = arch === 'x64' ? 'x86_64' : 'arm64'
  mkdirSync(binDir, { recursive: true })
  execFileSync(
    'xcrun',
    [
      'clang',
      '-O2',
      '-std=c11',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-target',
      `${cpu}-apple-macosx${MACOS_MINIMUM}`,
      SOURCE,
      '-o',
      hookPath
    ],
    { stdio: 'inherit' }
  )
  chmodSync(hookPath, 0o755)
  if (process.arch === (cpu === 'x86_64' ? 'x64' : 'arm64')) {
    // Why: a client that can't even answer "{}" would leave every Claude permission hook failing closed.
    const out = execFileSync(hookPath, { input: '', env: {}, encoding: 'utf8' })
    if (out !== '{}\n') {
      throw new Error(`product: ${HOOK} answered ${JSON.stringify(out)}, expected "{}\\n"`)
    }
    // Claude's statusLine shows whatever this prints: it must stay silent.
    const status = execFileSync(hookPath, ['statusline'], { input: '', env: {}, encoding: 'utf8' })
    if (status !== '') {
      throw new Error(`product: ${HOOK} statusline printed ${JSON.stringify(status)}`)
    }
  }
}

module.exports = { installAgentHook }
