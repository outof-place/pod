// pod-gocache (native/pod-gocache-macos), the Go build cache helper, built per app arch into
// Contents/Resources/bin. The runtime copies it to ~/.pod/gocache/bin and runs it as a launch agent
// (src/main/pod/gocache). Signed as codes.pod.gocache (osx-sign would name a bare executable after
// its file), with no entitlements: the policy's default for an executable without a rule.
const { execFileSync } = require('node:child_process')
const { join } = require('node:path')
const { assertHelperSigned, helperSignOptions } = require('../helper-names.cjs')

const POD_GOCACHE = {
  path: 'Contents/Resources/bin/pod-gocache',
  identifier: 'codes.pod.gocache',
  build: join('native', 'pod-gocache-macos', 'scripts', 'build.sh')
}
// electron-builder's Arch names → build.sh's GOARCH (or both, joined by lipo).
const GOARCH = { arm64: 'arm64', x64: 'amd64', universal: 'universal' }

/**
 * Builds the helper into the app; build.sh fails the package when Go is missing, and when the
 * binary does not answer `version` with the stamped version on a Mac that can run it.
 */
function installPodGoCacheHelper(appPath, repoRoot, arch, options = {}) {
  const goarch = GOARCH[arch]
  if (!goarch) {
    throw new Error(`product: no pod-gocache build for arch ${arch}`)
  }
  execFileSync(
    'bash',
    [
      join(repoRoot, POD_GOCACHE.build),
      '--arch',
      goarch,
      '--out',
      join(appPath, POD_GOCACHE.path),
      ...(options.module ? ['--module', options.module] : [])
    ],
    { cwd: repoRoot, stdio: 'inherit' }
  )
}

/** osx-sign's per-file options, with pod-gocache's signing identifier added for its file. */
function podGoCacheSignOptions(appPath, optionsForFile) {
  return helperSignOptions(appPath, optionsForFile, POD_GOCACHE)
}

/** After signing: pod-gocache is in the app, valid, hardened, and named codes.pod.gocache. */
function assertPodGoCacheSigned(appPath) {
  assertHelperSigned(appPath, POD_GOCACHE)
}

module.exports = {
  POD_GOCACHE,
  assertPodGoCacheSigned,
  installPodGoCacheHelper,
  podGoCacheSignOptions
}
