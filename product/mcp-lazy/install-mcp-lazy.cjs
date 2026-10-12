// Builds mcp-lazy (native/mcp-lazy-macos) into Contents/Resources/bin; the runtime copies it beside
// its managed hooks when the Claude setting "Lazy-start heavy MCP servers" wraps a server
// (src/main/pod/mcp-lazy). electron-builder signs it; the entitlement policy gives it none.
const { execFileSync, spawnSync } = require('node:child_process')
const { chmodSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')

const SHIM = 'mcp-lazy'
const SOURCE = join(__dirname, '..', '..', 'native', 'mcp-lazy-macos', 'src', 'mcp-lazy.c')
// Electron 44+ requires macOS 13.
const MACOS_MINIMUM = '13.0'

function installMcpLazy(resourcesDir, arch) {
  const binDir = join(resourcesDir, 'bin')
  const shimPath = join(binDir, SHIM)
  const cpu = arch === 'x64' ? 'x86_64' : 'arm64'
  mkdirSync(binDir, { recursive: true })
  execFileSync(
    'xcrun',
    [
      'clang',
      '-Os',
      '-std=c11',
      '-Wall',
      '-Wextra',
      '-Wno-unused-result',
      '-Werror',
      '-target',
      `${cpu}-apple-macosx${MACOS_MINIMUM}`,
      SOURCE,
      '-o',
      shimPath
    ],
    { stdio: 'inherit' }
  )
  chmodSync(shimPath, 0o755)
  if (process.arch === (cpu === 'x86_64' ? 'x64' : 'arm64')) {
    // Why: a shim that doesn't even start would turn every wrapped server into a failed one (the
    // wrapper falls back to the server only when the shim is missing, not when it is broken).
    const run = spawnSync(shimPath, [], { input: '', env: {}, encoding: 'utf8' })
    if (run.status !== 2 || !run.stderr.startsWith('usage: mcp-lazy')) {
      throw new Error(`product: ${SHIM} answered ${run.status} ${JSON.stringify(run.stderr)}`)
    }
  }
}

module.exports = { installMcpLazy }
