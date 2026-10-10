// Builds the native `podx` front (native/podx) into Contents/Resources/bin as `<cliName>`, links `orca`
// to it where the tree still ships `orca`, and keeps the patched bash launcher as `podx-node`: the
// native binary execs it for every command it does not port and when POD_NATIVE_CLI=0.
// electron-builder signs the binary.
const { execFileSync } = require('node:child_process')
const {
  chmodSync,
  copyFileSync,
  existsSync,
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
  // Why: pod-decouple renames ORCA_* env names in native/ too; the binary must read what the launcher sets.
  const runtime = readFileSync(
    join(PACKAGE_DIR, 'Sources', 'PodxCore', 'RuntimeClient.swift'),
    'utf8'
  )
  const userDataEnv = `${identity.envPrefix ?? 'ORCA_'}USER_DATA_PATH`
  if (!runtime.includes(`"${userDataEnv}"`)) {
    throw new Error(
      `product: native/podx does not read ${userDataEnv}; rerun pod-decouple over native/`
    )
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
  // Why: a decoupled tree ships <cliName> alone; only a tree that still has `orca` keeps it.
  const orcaPath = join(binDir, 'orca')
  if (identity.cliName !== 'orca' && existsSync(orcaPath)) {
    rmSync(orcaPath, { force: true })
    symlinkSync(identity.cliName, orcaPath)
  }

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
