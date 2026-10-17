// Renames Orca's bundled macOS helpers after the product: Finder and Privacy & Security list the
// Computer Use helper by its file name, Activity Monitor lists the Contents/MacOS helpers by theirs.
// Bundle ids and designated requirements stay, so the helpers keep their privacy grants. Runtime
// lookups follow through src/main/product-identity/product-helper-names.ts (same table, in
// src/shared/product-helper-names.ts).
//
// Pod's own helpers are named Pod from the start; the ones the packaging places and signs by name
// are listed here too (POD_SIM).
//
//   node product/helper-names.cjs --check <Product.app>   lists every Orca name a user can see
const { execFileSync, spawnSync } = require('node:child_process')
const {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync
} = require('node:fs')
const { basename, dirname, join } = require('node:path')

const COMPUTER_USE_NAME = 'Orca Computer Use'
const COMPUTER_USE_EXECUTABLE = 'orca-computer-use-macos'
const MACOS_HELPERS = ['orca-notification-status', 'orca-keyboard-layout']
// Info.plist strings macOS shows: Finder, Dock, Activity Monitor, permission prompts.
const VISIBLE_PLIST_KEY =
  /^(CFBundleName|CFBundleDisplayName|CFBundleExecutable|NS\w+UsageDescription)$/
const ORCA_NAME = /orca/i
// Bundles macOS names a process or a login item after: nested apps (Pod Menu, PodNative), XPC
// services (Activity Monitor) and app extensions.
const VISIBLE_BUNDLE = /\.(app|xpc|appex)$/
// Folders that hold no bundle a user sees: packed JS and Electron's framework internals.
const SKIPPED_FOLDER = /^(node_modules|app\.asar\.unpacked|.+\.framework|.+\.lproj)$/

/** Upstream name → product name; mirrors productHelperNameTable() in the runtime. */
function productHelperNameTable(identity) {
  const table = new Map()
  const prefix = `${identity.packageName || identity.userDataName.toLowerCase()}-`
  if (identity.computerUseDisplayName) {
    table.set(`${COMPUTER_USE_NAME}.app`, `${identity.computerUseDisplayName}.app`)
    table.set(COMPUTER_USE_NAME, identity.computerUseDisplayName)
    table.set(COMPUTER_USE_EXECUTABLE, COMPUTER_USE_EXECUTABLE.replace(/^orca-/, prefix))
  }
  for (const helper of MACOS_HELPERS) {
    table.set(helper, helper.replace(/^orca-/, prefix))
  }
  for (const [upstream, product] of table) {
    if (upstream === product) {
      table.delete(upstream)
    }
  }
  return table
}

function plistSet(plist, key, value) {
  execFileSync('plutil', ['-replace', key, '-string', value, plist])
}

/**
 * Before upstream's afterPack signs the helper: its executable name is sealed in its Info.plist.
 * The host keys name the product in the helper's own windows (native/computer-use-macos).
 */
function renameComputerUseExecutable(resourcesDir, identity) {
  const table = productHelperNameTable(identity)
  const contents = join(resourcesDir, `${COMPUTER_USE_NAME}.app`, 'Contents')
  const executable = table.get(COMPUTER_USE_EXECUTABLE)
  if (!executable || !existsSync(contents)) {
    return
  }
  renameSync(join(contents, 'MacOS', COMPUTER_USE_EXECUTABLE), join(contents, 'MacOS', executable))
  const plist = join(contents, 'Info.plist')
  plistSet(plist, 'CFBundleExecutable', executable)
  plistSet(plist, 'ProductHostDisplayName', identity.displayName)
  plistSet(plist, 'ProductHostCLIName', identity.cliName)
  execFileSync('plutil', ['-lint', '-s', plist])
}

/**
 * After upstream's afterPack signed the helpers under their upstream paths. A signature covers
 * what is inside a bundle or a Mach-O file, not the name it sits under, so renaming keeps it.
 */
function renameSignedHelpers(resourcesDir, identity) {
  const table = productHelperNameTable(identity)
  const macosDir = join(resourcesDir, '..', 'MacOS')
  const moves = [
    [resourcesDir, `${COMPUTER_USE_NAME}.app`],
    ...MACOS_HELPERS.map((helper) => [macosDir, helper])
  ]
  for (const [dir, upstream] of moves) {
    const product = table.get(upstream)
    if (!product || !existsSync(join(dir, upstream))) {
      continue
    }
    const target = join(dir, product)
    renameSync(join(dir, upstream), target)
    if (isSigned(target)) {
      execFileSync('codesign', ['--verify', '--strict', target], { stdio: 'inherit' })
    }
  }
}

/**
 * pod-sim, the iOS simulator helper (native/pod-sim-macos), where the runtime looks for it
 * (src/main/pod/sim/helper/sim-helper-path.ts). Viewers admit its frame messages by its signing
 * identifier (CPodSimSurface/include/pod_sim_frame.h), so it is signed as codes.pod.sim: osx-sign
 * would otherwise name a bare executable after its file.
 */
const POD_SIM = {
  path: 'Contents/Resources/bin/pod-sim',
  identifier: 'codes.pod.sim',
  build: join('native', 'pod-sim-macos', 'scripts', 'build.sh'),
  output: join('native', 'pod-sim-macos', '.build', 'release', 'pod-sim')
}

/**
 * The environment pod-sim builds in: the Xcode the release itself runs under (the runbook's
 * DEVELOPER_DIR). release.sh points DEVELOPER_DIR at the Xcode whose actool compiles the app icon
 * for the whole electron-builder run, and passes the one it was started with as
 * POD_RELEASE_DEVELOPER_DIR (empty: none, so xcode-select's Xcode builds it). Outside release.sh
 * DEVELOPER_DIR is passed as it is.
 */
function podSimBuildEnv(env) {
  const { POD_RELEASE_DEVELOPER_DIR: releaseDeveloperDir, ...rest } = env
  if (releaseDeveloperDir === undefined) {
    return rest
  }
  const { DEVELOPER_DIR: _actoolDeveloperDir, ...withoutActool } = rest
  return releaseDeveloperDir
    ? { ...withoutActool, DEVELOPER_DIR: releaseDeveloperDir }
    : withoutActool
}

/** Builds pod-sim for `arch` (electron-builder's arm64, x64 or universal) and places it in the app. */
function installPodSimHelper(appPath, repoRoot, arch) {
  const archArgs = { arm64: ['--arch', 'arm64'], x64: ['--arch', 'x86_64'], universal: [] }[arch]
  if (!archArgs) {
    throw new Error(`product: no pod-sim build for arch ${arch}`)
  }
  execFileSync('bash', [join(repoRoot, POD_SIM.build), ...archArgs], {
    cwd: repoRoot,
    env: podSimBuildEnv(process.env),
    stdio: 'inherit'
  })
  const target = join(appPath, POD_SIM.path)
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(join(repoRoot, POD_SIM.output), target)
  chmodSync(target, 0o755)
}

/** osx-sign's per-file options, with pod-sim's signing identifier added for its file. */
function podSimSignOptions(appPath, optionsForFile) {
  const podSim = join(appPath, POD_SIM.path)
  return (filePath) => {
    const options = optionsForFile(filePath)
    return filePath === podSim
      ? {
          ...options,
          additionalArguments: [
            ...(options.additionalArguments ?? []),
            '--identifier',
            POD_SIM.identifier
          ]
        }
      : options
  }
}

/** After signing: pod-sim is in the app, valid, hardened, and named codes.pod.sim. */
function assertPodSimSigned(appPath) {
  const podSim = join(appPath, POD_SIM.path)
  if (!existsSync(podSim)) {
    throw new Error(`product: ${POD_SIM.path} is missing from ${basename(appPath)}`)
  }
  execFileSync('codesign', ['--verify', '--strict', podSim], { stdio: 'inherit' })
  // codesign -d prints to stderr.
  const { stderr } = spawnSync('codesign', ['-d', '--verbose=2', podSim], { encoding: 'utf8' })
  const problems = podSimSignatureProblems(stderr ?? '')
  if (problems.length > 0) {
    throw new Error(`product: ${POD_SIM.path}: ${problems.join('; ')}`)
  }
}

function podSimSignatureProblems(details) {
  const problems = []
  if (!details.split('\n').includes(`Identifier=${POD_SIM.identifier}`)) {
    problems.push(`its identifier is not ${POD_SIM.identifier}`)
  }
  if (!/^CodeDirectory .*flags=0x\w+\([^)]*runtime[^)]*\)/m.test(details)) {
    problems.push('it is not signed with the hardened runtime')
  }
  return problems
}

function isSigned(path) {
  try {
    execFileSync('codesign', ['--display', path], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** Top-level string values of an Info.plist; `plutil -p` indents nested entries deeper. */
function readPlistStrings(plist) {
  const text = execFileSync('plutil', ['-p', plist], { encoding: 'utf8' })
  return new Map(
    [...text.matchAll(/^ {2}"([^"]+)" => "(.*)"$/gm)].map(([, key, value]) => [key, value])
  )
}

function visibleBundles(dir, found = []) {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)
    if (SKIPPED_FOLDER.test(name) || !statSync(path).isDirectory()) {
      continue
    }
    if (VISIBLE_BUNDLE.test(name)) {
      found.push(path)
    }
    visibleBundles(path, found)
  }
  return found
}

/** Every Orca name a packaged product shows as an app, process or permission prompt. */
function upstreamNameLeaks(appPath) {
  const leaks = []
  for (const bundle of [appPath, ...visibleBundles(join(appPath, 'Contents'))]) {
    const where = bundle === appPath ? basename(appPath) : bundle.slice(appPath.length + 1)
    if (bundle !== appPath && ORCA_NAME.test(basename(bundle))) {
      leaks.push(`${where}: bundle name`)
    }
    const macosDir = join(bundle, 'Contents', 'MacOS')
    for (const file of existsSync(macosDir) ? readdirSync(macosDir).sort() : []) {
      if (ORCA_NAME.test(file)) {
        leaks.push(`${where}: Contents/MacOS/${file}`)
      }
    }
    const plist = join(bundle, 'Contents', 'Info.plist')
    for (const [key, value] of existsSync(plist) ? readPlistStrings(plist) : []) {
      if (VISIBLE_PLIST_KEY.test(key) && ORCA_NAME.test(value)) {
        leaks.push(`${where}: Info.plist ${key} "${value}"`)
      }
    }
  }
  return leaks
}

function assertNoUpstreamNames(appPath) {
  const leaks = upstreamNameLeaks(appPath)
  if (leaks.length > 0) {
    throw new Error(`product: the bundle still shows Orca's names:\n  ${leaks.join('\n  ')}`)
  }
}

if (require.main === module) {
  const [flag, appPath] = process.argv.slice(2)
  if (flag !== '--check' || !appPath) {
    console.error('usage: node product/helper-names.cjs --check <Product.app>')
    process.exit(2)
  }
  const leaks = upstreamNameLeaks(appPath)
  console.log(leaks.length === 0 ? 'no Orca names' : leaks.join('\n'))
  process.exit(leaks.length === 0 ? 0 : 1)
}

module.exports = {
  POD_SIM,
  assertNoUpstreamNames,
  assertPodSimSigned,
  installPodSimHelper,
  podSimBuildEnv,
  podSimSignOptions,
  podSimSignatureProblems,
  productHelperNameTable,
  renameComputerUseExecutable,
  renameSignedHelpers,
  upstreamNameLeaks
}
