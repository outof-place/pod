// Least-privilege entitlements for everything electron-builder signs in the product app. By
// default osx-sign gives every nested executable Electron's inherited set (JIT, unsigned
// executable memory, DYLD variables, camera, microphone, location, USB, Bluetooth, Apple events):
// 0.0.1-test3 shipped Pod Menu, the Computer Use helper, rg and every CLI helper with all nine.
// Apple: "Make sure to use only the entitlements that are absolutely necessary", and entitlements
// belong to executables only; libraries and frameworks inherit their host's. Accessibility,
// Screen Recording and Input Monitoring are privacy (TCC) grants, not entitlements.
const { join } = require('node:path')

const ENTITLEMENTS_DIR = join(__dirname, 'entitlements')
// Keep electron-builder's own choice: the app and Electron's helper apps run V8 and Chromium.
const ELECTRON = 'electron'

/** First match wins; `path` is relative to the .app, without a leading slash. */
const ENTITLEMENT_RULES = [
  {
    name: 'Electron helpers',
    match:
      /^Contents\/Frameworks\/[^/]+ Helper(?: \([A-Za-z]+\))?\.app(?:\/Contents\/MacOS\/[^/]+)?$/,
    entitlements: ELECTRON
  },
  // Dictation records the microphone; the menu receives URL events but sends no Apple events.
  {
    name: 'Pod Menu',
    match:
      /^Contents\/(?:Resources\/claude-acc|Library\/LoginItems)\/[^/]+\.app(?:\/Contents\/MacOS\/ClaudeAcc)?$/,
    entitlements: 'microphone.plist'
  },
  // Feeds the host camera into an iOS simulator (AVCaptureSession).
  {
    name: 'serve-sim camera',
    match: /\/serve-sim\/dist\/simcam\/serve-sim-camera-helper$/,
    entitlements: 'camera.plist'
  },
  // CPython's JIT (PYTHON_JIT=1) maps executable memory without MAP_JIT.
  {
    name: 'embedded Python',
    match: /^Contents\/Resources\/python\/bin\/python3(?:\.\d+)?$/,
    entitlements: 'python-jit.plist'
  },
  // Exec shims between a user's shell and an agent: without this entitlement dyld strips DYLD_*
  // from their environment, so the agent would no longer see the user's own variables.
  {
    name: 'exec shims',
    match:
      /^Contents\/Resources\/(?:bin\/pod-agent-launcher|node_modules\/node-pty\/(?:build\/Release|prebuilds\/darwin-[a-z0-9]+)\/spawn-helper)$/,
    entitlements: 'exec-shim.plist'
  }
]

/** The rule for `relativePath`; the app itself and its main executable keep Electron's set. */
function entitlementRule(relativePath, mainExecutable) {
  if (relativePath === '' || relativePath === `Contents/MacOS/${mainExecutable}`) {
    return { name: 'the app', entitlements: ELECTRON }
  }
  return (
    ENTITLEMENT_RULES.find((rule) => rule.match.test(relativePath)) ?? {
      name: 'everything else',
      entitlements: 'none.plist'
    }
  )
}

function entitlementsFile(rule) {
  return rule.entitlements === ELECTRON ? null : join(ENTITLEMENTS_DIR, rule.entitlements)
}

/** osx-sign's per-file options with the policy's entitlements in place of the inherited set. */
function productOptionsForFile(appPath, optionsForFile, mainExecutable) {
  return (filePath) => {
    const options = optionsForFile(filePath)
    const relativePath = filePath === appPath ? '' : filePath.slice(appPath.length + 1)
    const file = entitlementsFile(entitlementRule(relativePath, mainExecutable))
    return file ? { ...options, entitlements: file } : options
  }
}

/**
 * mac.sign: electron-builder's own signing (app-builder-lib's macCodeSign.sign, which retries
 * osx-sign) with per-file entitlements; identity, keychain, ignore and timestamps stay its own.
 */
async function signWithProductEntitlements(options, packager) {
  const { sign } = require('app-builder-lib/out/codeSign/macCodeSign')
  if (typeof options.optionsForFile !== 'function') {
    throw new Error('product: electron-builder passed no optionsForFile to mac.sign')
  }
  const mainExecutable = packager.appInfo.productFilename
  return sign({
    ...options,
    optionsForFile: productOptionsForFile(options.app, options.optionsForFile, mainExecutable)
  })
}

module.exports = {
  ELECTRON,
  ENTITLEMENTS_DIR,
  ENTITLEMENT_RULES,
  entitlementRule,
  entitlementsFile,
  productOptionsForFile,
  signWithProductEntitlements
}
