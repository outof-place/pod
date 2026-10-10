// Builds the native `podx` front (native/podx) into Contents/Resources/bin as `<cliName>`, with `orca`
// linked to it, and keeps the patched bash launcher as `podx-node`: the native binary execs it for
// every command it does not port and when POD_NATIVE_CLI=0. electron-builder signs the binary.
const { execFileSync } = require('node:child_process')
const {
  chmodSync,
  copyFileSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync
} = require('node:fs')
const { join } = require('node:path')

const PACKAGE_DIR = join(__dirname, '..', '..', 'native', 'podx')
const NODE_LAUNCHER = 'podx-node'

function assertIdentityInSync(identity) {
  const source = readFileSync(
    join(PACKAGE_DIR, 'Sources', 'PodxCore', 'ProductIdentity.swift'),
    'utf8'
  )
  const expected = [
    `PRODUCT_USER_DATA_NAME = ${JSON.stringify(identity.userDataName)}`,
    `NODE_LAUNCHER_NAME = ${JSON.stringify(NODE_LAUNCHER)}`
  ]
  for (const line of expected) {
    if (!source.includes(line)) {
      throw new Error(`product: native/podx ProductIdentity.swift must declare ${line}`)
    }
  }
}

function installNativeCli(resourcesDir, arch, identity) {
  assertIdentityInSync(identity)
  const cpu = arch === 'x64' ? 'x86_64' : 'arm64'
  const build = [
    'build',
    '-c',
    'release',
    '--package-path',
    PACKAGE_DIR,
    '--arch',
    cpu,
    '--product',
    'podx'
  ]
  execFileSync('xcrun', ['swift', ...build], { stdio: 'inherit' })
  const builtDir = execFileSync('xcrun', ['swift', ...build, '--show-bin-path'], {
    encoding: 'utf8'
  }).trim()

  const binDir = join(resourcesDir, 'bin')
  const nativePath = join(binDir, identity.cliName)
  renameSync(nativePath, join(binDir, NODE_LAUNCHER))
  copyFileSync(join(builtDir, 'podx'), nativePath)
  chmodSync(nativePath, 0o755)
  const orcaPath = join(binDir, 'orca')
  rmSync(orcaPath, { force: true })
  symlinkSync(identity.cliName, orcaPath)

  if (process.arch === (cpu === 'x86_64' ? 'x64' : 'arm64')) {
    // Why: --version runs natively, so a binary that cannot find the bundled CLI fails the build.
    const cliPackage = join(resourcesDir, 'app.asar.unpacked', 'out', 'package.json')
    const { version } = JSON.parse(readFileSync(cliPackage, 'utf8'))
    const reported = execFileSync(nativePath, ['--version'], {
      encoding: 'utf8'
    }).trim()
    if (reported !== version) {
      throw new Error(
        `product: native ${identity.cliName} --version printed ${reported}, expected ${version}`
      )
    }
  }
}

module.exports = { NODE_LAUNCHER, installNativeCli }
