// Pod's macOS extraFiles for PodNative, the native UI: the app pinned in config/pod-native.json,
// unpacked by config/scripts/fetch-pod-native.mjs, nested as Contents/Helpers/PodNative.app (Apple's
// place for helper apps). It arrives signed and notarized, so Pod's signing leaves it alone: osx-sign
// would re-sign it with the Electron helpers' entitlements. Pod's own signature seals it as nested
// code. Upstream Orca's config never uses this; the product build does.
const { existsSync, readFileSync } = require('node:fs')
const { homedir } = require('node:os')
const { join } = require('node:path')

const PIN = join(__dirname, 'pod-native.json')
const SHA256 = /^[0-9a-f]{64}$/
const REVISION = /^[0-9a-f]{40}$/

function readPodNativePin(path = PIN) {
  const pin = JSON.parse(readFileSync(path, 'utf8'))
  for (const key of ['repository', 'tag', 'asset', 'teamId']) {
    if (typeof pin[key] !== 'string' || !pin[key]) {
      throw new Error(`PodNative pin: "${key}" is missing`)
    }
  }
  if (!SHA256.test(pin.sha256 ?? '') || !REVISION.test(pin.revision ?? '')) {
    throw new Error('PodNative pin: sha256 and revision must be full hex digests')
  }
  return pin
}

/** Where the pinned app is unpacked: outside the worktree, one folder per asset digest. */
function pinnedPodNativeApp(pin, cacheRoot = join(homedir(), 'Library', 'Caches')) {
  return join(cacheRoot, 'codes.pod.release', 'pod-native', pin.sha256, 'PodNative.app')
}

/** POD_NATIVE_APP_SOURCE (a local build) or the pinned app. */
function podNativeAppSource({ env = process.env, pin = readPodNativePin() } = {}) {
  return env.POD_NATIVE_APP_SOURCE || pinnedPodNativeApp(pin)
}

/** Throws when the app is missing, so a Pod release cannot ship without its native UI. */
function podNativeMacExtraFiles({ source = podNativeAppSource() } = {}) {
  if (!existsSync(join(source, 'Contents', 'Info.plist'))) {
    throw new Error(
      `PodNative.app missing (${source}): run node config/scripts/fetch-pod-native.mjs`
    )
  }
  return [{ from: source, to: 'Helpers/PodNative.app' }]
}

// For mac signIgnore (a regex tested on absolute paths): the app and everything in it.
const podNativeMacSignIgnore = ['/Contents/Helpers/PodNative\\.app(?:/|$)']

module.exports = {
  readPodNativePin,
  pinnedPodNativeApp,
  podNativeAppSource,
  podNativeMacExtraFiles,
  podNativeMacSignIgnore
}
