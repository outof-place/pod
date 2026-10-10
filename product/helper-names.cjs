// Renames Orca's bundled macOS helpers after the product: Finder and Privacy & Security list the
// Computer Use helper by its file name, Activity Monitor lists the Contents/MacOS helpers by theirs.
// Bundle ids and designated requirements stay, so the helpers keep their privacy grants. Runtime
// lookups follow through src/main/product-identity/product-helper-names.ts (same table).
//
//   node product/helper-names.cjs --check <Product.app>   lists every Orca name a user can see
const { execFileSync } = require('node:child_process')
const { existsSync, readdirSync, renameSync, statSync } = require('node:fs')
const { basename, join } = require('node:path')

const COMPUTER_USE_NAME = 'Orca Computer Use'
const COMPUTER_USE_EXECUTABLE = 'orca-computer-use-macos'
const MACOS_HELPERS = ['orca-notification-status', 'orca-keyboard-layout']
// Info.plist strings macOS shows: Finder, Dock, Activity Monitor, permission prompts.
const VISIBLE_PLIST_KEY =
  /^(CFBundleName|CFBundleDisplayName|CFBundleExecutable|NS\w+UsageDescription)$/
const ORCA_NAME = /orca/i
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

function appBundles(dir, found = []) {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)
    if (SKIPPED_FOLDER.test(name) || !statSync(path).isDirectory()) {
      continue
    }
    if (name.endsWith('.app')) {
      found.push(path)
    }
    appBundles(path, found)
  }
  return found
}

/** Every Orca name a packaged product shows as an app, process or permission prompt. */
function upstreamNameLeaks(appPath) {
  const leaks = []
  for (const bundle of [appPath, ...appBundles(join(appPath, 'Contents'))]) {
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
  assertNoUpstreamNames,
  productHelperNameTable,
  renameComputerUseExecutable,
  renameSignedHelpers,
  upstreamNameLeaks
}
