// Ships PodNative, Pod's native UI, as Contents/Helpers/PodNative.app: Apple's "Placing content in
// a bundle" puts helper apps in Contents/Helpers, and Resources/ holds no code. The pinned unsigned
// build comes from config/scripts/fetch-pod-native.mjs (resources/pod-native). afterPack copies it,
// checks it and signs it with its own entitlements before electron-builder seals Pod.app.
// POD_NATIVE_SIGN_IGNORE keeps osx-sign from re-signing it with Electron's inherited entitlements
// (JIT, camera, microphone, location...), which it does to every other nested app.
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
const { join } = require('node:path')

const POD_NATIVE_APP = 'PodNative.app'
const POD_NATIVE_BUNDLE_ID = 'codes.pod.native'
const POD_NATIVE_SOURCE = join(__dirname, '..', 'resources', 'pod-native', POD_NATIVE_APP)
const POD_NATIVE_ENTITLEMENTS = join(__dirname, 'pod-native.entitlements')
const MAX_POD_NATIVE_BYTES = 80 * 1024 * 1024
const POD_NATIVE_SIGN_IGNORE = ['/Contents/Helpers/PodNative\\.app(/|$)']
// Never in the fetched resources/pod-native copy, so never packed into the asar either.
const POD_NATIVE_FILE_EXCLUSIONS = ['!resources/pod-native{,/**/*}']
// Build leftovers a dist bundle must not carry: SwiftPM state, build-app.sh stamps, Finder files.
const LEFTOVER = /^(\.build|\.swiftpm|\.git|\.DS_Store|\.unsigned-.*|.*\.sha256)$/
const NESTED_BUNDLE = /\.(app|appex|framework|xpc)$/
const MACH_O_MAGIC = new Set(['feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca'])

function podNativePath(appPath) {
  return join(appPath, 'Contents', 'Helpers', POD_NATIVE_APP)
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

/** Code directly inside `bundle` that codesign must sign first: nested bundles and loose Mach-O files. */
function nestedCode(bundle) {
  const entries = walk(bundle)
  const bundles = entries
    .filter(({ name, stat }) => stat.isDirectory() && NESTED_BUNDLE.test(name))
    .map(({ path }) => path)
  const inNestedBundle = (path) => bundles.some((nested) => path.startsWith(`${nested}/`))
  const executable = mainExecutable(bundle)
  return entries
    .filter(({ path }) => !inNestedBundle(path))
    .filter(({ path, stat }) =>
      stat.isDirectory()
        ? bundles.includes(path)
        : stat.isFile() && path !== executable && isMachO(path)
    )
    .map(({ path }) => path)
}

function codesignArgs(identity, release, entitlements) {
  const args = ['--force', '--sign', identity]
  if (release) {
    args.push('--options', 'runtime', '--timestamp')
  }
  return entitlements ? [...args, '--entitlements', entitlements] : args
}

/** Inside out, no --deep: nested bundles take PodNative's entitlements, loose Mach-O files none. */
function signCode(path, identity, release) {
  const bundle = NESTED_BUNDLE.test(path)
  if (bundle) {
    for (const nested of nestedCode(path)) {
      signCode(nested, identity, release)
    }
  }
  const entitlements = bundle ? POD_NATIVE_ENTITLEMENTS : null
  execFileSync('codesign', [...codesignArgs(identity, release, entitlements), path], {
    stdio: 'inherit'
  })
}

/** A non-release build signs ad hoc. */
function signPodNative(app, { identity, release }) {
  signCode(app, identity, release)
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' })
}

/** electron-builder hands afterPack CSC_NAME without the certificate-type prefix (release.sh). */
function podNativeSignIdentity(release, env = process.env) {
  const name = env.CSC_NAME
  if (!name) {
    if (release) {
      throw new Error('product: no CSC_NAME to sign PodNative with')
    }
    return '-'
  }
  return /^(Developer ID Application|Apple Development|Apple Distribution):/.test(name)
    ? name
    : `Developer ID Application: ${name}`
}

/** afterPack: copies, checks and signs PodNative; a release cannot ship without it. */
function embedPodNative(contentsDir, { source = POD_NATIVE_SOURCE, release, env = process.env }) {
  if (!existsSync(source)) {
    if (release) {
      throw new Error(`product: ${source} is missing: run node config/scripts/fetch-pod-native.mjs`)
    }
    console.warn(`[product] no ${source}; this non-release build ships without PodNative`)
    return null
  }
  assertPodNativeBundle(source)
  const target = join(contentsDir, 'Helpers', POD_NATIVE_APP)
  execFileSync('/usr/bin/ditto', [source, target])
  // Why: an APFS clone keeps xattrs whatever ditto's flags say, quarantine included.
  execFileSync('/usr/bin/xattr', ['-cr', target])
  signPodNative(target, { identity: podNativeSignIdentity(release, env), release })
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

/** After signing and notarization: Developer ID of the team, hardened runtime, a timestamp, our entitlements. */
function podNativeSignatureProblems(app, { teamId, notarized }) {
  const problems = []
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
  const expected = plistJson(readFileSync(POD_NATIVE_ENTITLEMENTS, 'utf8'))
  const actual = entitlementsOf(app)
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    problems.push(`entitlements ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
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
  const teamId = /\(([A-Z0-9]{10})\)$/.exec(podNativeSignIdentity(true))?.[1]
  const problems = podNativeSignatureProblems(app, { teamId, notarized: true })
  if (problems.length > 0) {
    console.error(`pod-native: ${app}:\n  ${problems.join('\n  ')}`)
    process.exit(1)
  }
  console.log(`pod-native: ${app} signed by team ${teamId}, hardened, notarized`)
}

module.exports = {
  MAX_POD_NATIVE_BYTES,
  POD_NATIVE_BUNDLE_ID,
  POD_NATIVE_FILE_EXCLUSIONS,
  POD_NATIVE_SIGN_IGNORE,
  assertPodNativeBundle,
  embedPodNative,
  nestedCode,
  podNativePath,
  podNativeSignIdentity,
  podNativeSignatureProblems
}
