// Ships PodNative, Pod's native UI, as Contents/Helpers/PodNative.app: Apple's "Placing content in
// a bundle" puts helper apps in Contents/Helpers, and Resources/ holds no code. The pinned build
// comes from config/scripts/fetch-pod-native.mjs (~/Library/Caches/codes.pod.release/pod-native).
// afterPack checks it and copies it in; electron-builder then signs it like every nested app, with
// the entitlements product/entitlements-policy.cjs gives it (none), so one identity and one
// notarization cover the whole app.
//
//   node product/pod-native-embed.cjs --check <Pod.app>   checks the signed, notarized copy
const { execFileSync, spawnSync } = require('node:child_process')
const {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync
} = require('node:fs')
const { homedir } = require('node:os')
const { join } = require('node:path')

const POD_NATIVE_APP = 'PodNative.app'
const POD_NATIVE_BUNDLE_ID = 'codes.pod.native'
const POD_NATIVE_PIN = join(__dirname, '..', 'config', 'pod-native.json')
const MAX_POD_NATIVE_BYTES = 80 * 1024 * 1024
// Build leftovers a dist bundle must not carry: SwiftPM state, build-app.sh stamps, Finder files.
const LEFTOVER = /^(\.build|\.swiftpm|\.git|\.DS_Store|\.unsigned-.*|.*\.sha256)$/
const MACH_O_MAGIC = new Set(['feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca'])

function podNativePath(appPath) {
  return join(appPath, 'Contents', 'Helpers', POD_NATIVE_APP)
}

function readPodNativePin(path = POD_NATIVE_PIN) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** Outside every worktree: app.asar never packs it, and an indexed .app gets registered. */
function podNativeCacheDir(key, home = homedir()) {
  return join(home, 'Library', 'Caches', 'codes.pod.release', 'pod-native', key)
}

/** POD_NATIVE_APP_SOURCE (a local build) or the pinned build the fetch unpacked. */
function podNativeSource(env = process.env, pin = readPodNativePin()) {
  return (
    env.POD_NATIVE_APP_SOURCE || join(podNativeCacheDir(pin.sha256 ?? 'unpinned'), POD_NATIVE_APP)
  )
}

/** The pod-native commit the app was built from (release-app.sh writes it into Info.plist). */
function podNativeRevision(app) {
  return plistValue(join(app, 'Contents', 'Info.plist'), 'PodNativeRevision')
}

function isMachO(path) {
  const fd = openSync(path, 'r')
  try {
    const magic = Buffer.alloc(4)
    return readSync(fd, magic, 0, 4, 0) === 4 && MACH_O_MAGIC.has(magic.toString('hex'))
  } finally {
    closeSync(fd)
  }
}

/** Every file and folder under `dir`, children before their parent; symlinks are not followed. */
function walk(dir, found = []) {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)
    const stat = lstatSync(path)
    if (stat.isDirectory()) {
      walk(path, found)
    }
    found.push({ path, name, stat })
  }
  return found
}

function plistValue(plist, key) {
  const result = spawnSync('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist], {
    encoding: 'utf8'
  })
  return result.status === 0 ? result.stdout.trim() : null
}

/** Before signing: the bundle is the pinned app, arm64 only, small, and free of build leftovers. */
function assertPodNativeBundle(app, { maxBytes = MAX_POD_NATIVE_BYTES } = {}) {
  const plist = join(app, 'Contents', 'Info.plist')
  if (!existsSync(plist)) {
    throw new Error(`product: ${app} has no Info.plist`)
  }
  const id = plistValue(plist, 'CFBundleIdentifier')
  if (id !== POD_NATIVE_BUNDLE_ID) {
    throw new Error(`product: ${app} is ${id}, not ${POD_NATIVE_BUNDLE_ID}`)
  }
  const executable = mainExecutable(app)
  if (
    !executable ||
    !existsSync(executable) ||
    !lstatSync(executable).isFile() ||
    !isMachO(executable)
  ) {
    throw new Error(`product: ${app} has no Mach-O main executable`)
  }
  const problems = []
  let bytes = 0
  for (const { path, name, stat } of walk(app)) {
    bytes += stat.isFile() ? stat.size : 0
    if (LEFTOVER.test(name)) {
      problems.push(`${path.slice(app.length + 1)}: build leftover`)
    } else if (stat.isFile() && isMachO(path)) {
      const archs = execFileSync('/usr/bin/lipo', ['-archs', path], { encoding: 'utf8' }).trim()
      if (archs !== 'arm64') {
        problems.push(`${path.slice(app.length + 1)}: ${archs}, not arm64 only`)
      }
    }
  }
  if (bytes > maxBytes) {
    problems.push(`${Math.round(bytes / 2 ** 20)} MB, over ${Math.round(maxBytes / 2 ** 20)} MB`)
  }
  if (problems.length > 0) {
    throw new Error(`product: ${app}:\n  ${problems.join('\n  ')}`)
  }
}

function mainExecutable(bundle) {
  const name = plistValue(join(bundle, 'Contents', 'Info.plist'), 'CFBundleExecutable')
  return name ? join(bundle, 'Contents', 'MacOS', name) : null
}

/** afterPack: checks and copies PodNative; a release ships only the pinned build. */
function embedPodNative(
  contentsDir,
  { release, env = process.env, pin = readPodNativePin(), source = podNativeSource(env, pin) }
) {
  if (!existsSync(source)) {
    if (release) {
      throw new Error(`product: ${source} is missing: run node config/scripts/fetch-pod-native.mjs`)
    }
    console.warn(`[product] no ${source}; this non-release build ships without PodNative`)
    return null
  }
  assertPodNativeBundle(source)
  if (pin.revision && podNativeRevision(source) !== pin.revision) {
    const message = `${source} is revision ${podNativeRevision(source)}, the pin says ${pin.revision}`
    if (release) {
      throw new Error(`product: ${message}`)
    }
    console.warn(`[product] ${message}; a local build only`)
  }
  const target = join(contentsDir, 'Helpers', POD_NATIVE_APP)
  execFileSync('/usr/bin/ditto', [source, target])
  // Why: an APFS clone keeps xattrs whatever ditto's flags say, quarantine included.
  execFileSync('/usr/bin/xattr', ['-cr', target])
  return target
}

function entitlementsOf(path) {
  const result = spawnSync('codesign', ['-d', '--entitlements', '-', '--xml', path], {
    encoding: 'utf8'
  })
  return result.stdout.trim() ? plistJson(result.stdout) : {}
}

function plistJson(xml) {
  return JSON.parse(
    execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], {
      input: xml,
      encoding: 'utf8'
    })
  )
}

/** After signing and notarization: the pinned build, Developer ID of the team, hardened runtime, a timestamp, our entitlements. */
function podNativeSignatureProblems(app, { teamId, notarized, revision = null }) {
  const problems = []
  if (revision && podNativeRevision(app) !== revision) {
    problems.push(`revision ${podNativeRevision(app)}, the pin says ${revision}`)
  }
  const details = spawnSync('codesign', ['-dvvv', app], { encoding: 'utf8' }).stderr
  if (!details.includes(`TeamIdentifier=${teamId}`)) {
    problems.push(`not signed by team ${teamId}`)
  }
  if (!/^Authority=Developer ID Application: /m.test(details)) {
    problems.push('not signed with a Developer ID Application certificate')
  }
  if (!/^CodeDirectory .*flags=0x[0-9a-f]*\(runtime\)/m.test(details)) {
    problems.push('no hardened runtime')
  }
  if (!/^Timestamp=/m.test(details)) {
    problems.push('no secure timestamp')
  }
  // PodNative needs none: product/entitlements-policy.cjs gives it none.plist.
  const entitlements = Object.keys(entitlementsOf(app))
  if (entitlements.length > 0) {
    problems.push(`entitlements ${entitlements.join(', ')}, expected none`)
  }
  const verify = spawnSync('codesign', ['--verify', '--deep', '--strict', app], {
    encoding: 'utf8'
  })
  if (verify.status !== 0) {
    problems.push(verify.stderr.trim())
  }
  if (notarized) {
    const gatekeeper = spawnSync('spctl', ['-a', '-vv', '-t', 'exec', app], { encoding: 'utf8' })
    if (gatekeeper.status !== 0 || !gatekeeper.stderr.includes('source=Notarized Developer ID')) {
      problems.push(`Gatekeeper: ${gatekeeper.stderr.trim()}`)
    }
  }
  return problems
}

if (require.main === module) {
  const [flag, appPath] = process.argv.slice(2)
  if (flag !== '--check' || !appPath) {
    console.error('usage: node product/pod-native-embed.cjs --check <Pod.app>')
    process.exit(2)
  }
  const app = podNativePath(appPath)
  if (!existsSync(app)) {
    console.error(`pod-native: ${app} is missing`)
    process.exit(1)
  }
  // The nested app must carry the outer app's team.
  const outer = spawnSync('codesign', ['-dv', appPath], { encoding: 'utf8' }).stderr
  const teamId = /^TeamIdentifier=(\S+)$/m.exec(outer)?.[1]
  const { revision } = readPodNativePin()
  const problems = podNativeSignatureProblems(app, { teamId, notarized: true, revision })
  if (problems.length > 0) {
    console.error(`pod-native: ${app}:\n  ${problems.join('\n  ')}`)
    process.exit(1)
  }
  console.log(`pod-native: ${app} revision ${revision}, team ${teamId}, hardened, notarized`)
}

module.exports = {
  MAX_POD_NATIVE_BYTES,
  POD_NATIVE_APP,
  POD_NATIVE_BUNDLE_ID,
  assertPodNativeBundle,
  embedPodNative,
  podNativeCacheDir,
  podNativePath,
  podNativeRevision,
  podNativeSignatureProblems,
  podNativeSource,
  readPodNativePin
}
