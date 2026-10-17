// What a benchmarked app is: a packaged bundle (standalone, or the runtime nested in a one-app
// Pod) or an unpackaged checkout, with its version, commit, signing team, executable and CLI.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'

// One-app Pod (1.0 and later) is the native PodNative app with the Electron runtime nested inside;
// the suites drive the runtime, so a one-app bundle resolves to it.
export const ONE_APP_RUNTIME = 'Contents/Helpers/Pod Runtime.app'

function plistValue(file, key) {
  try {
    return execFileSync('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', file], {
      encoding: 'utf8'
    }).trim()
  } catch {
    return null
  }
}

function plist(appPath, key) {
  return execFileSync(
    '/usr/bin/plutil',
    ['-extract', key, 'raw', '-o', '-', `${appPath}/Contents/Info.plist`],
    { encoding: 'utf8' }
  ).trim()
}

// An unpackaged checkout with an electron-vite build: launched as tests/e2e/helpers does, through
// its package.json, with the checkout's own Electron and its built CLI.
function describeDevCheckout(dir) {
  const real = realpathSync(dir)
  const version = (file) => JSON.parse(readFileSync(path.join(real, file), 'utf8')).version
  let commit = null
  try {
    commit = execFileSync('git', ['-C', real, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {}
  return {
    path: dir,
    realPath: real,
    dev: true,
    bundleId: null,
    version: version('package.json'),
    buildId: null,
    commit,
    teamId: null,
    executable: path.join(real, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
    appArgs: [real],
    electron: version('node_modules/electron/package.json'),
    cli: process.execPath,
    cliArgs: [path.join(real, 'out/cli/index.js')]
  }
}

/** The one-app bundle around a nested Pod runtime, or null for a standalone app. */
function oneAppOf(real) {
  if (!real.endsWith(`/${ONE_APP_RUNTIME}`)) {
    return null
  }
  const outer = real.slice(0, -(ONE_APP_RUNTIME.length + 1))
  const key = (name) => plistValue(`${outer}/Contents/Info.plist`, name)
  return {
    bundleId: key('CFBundleIdentifier'),
    version: key('CFBundleShortVersionString'),
    build: key('CFBundleVersion'),
    podNativeRevision: key('PodNativeRevision')
  }
}

export function describeApp(appPath) {
  if (existsSync(path.join(appPath, 'out/main/index.js'))) {
    return describeDevCheckout(appPath)
  }
  if (existsSync(path.join(appPath, ONE_APP_RUNTIME))) {
    return describeApp(path.join(appPath, ONE_APP_RUNTIME))
  }
  const real = realpathSync(appPath)
  let build = null
  try {
    build = JSON.parse(readFileSync(`${real}/Contents/Resources/orca-local-build.json`, 'utf8'))
  } catch {}
  const codesign = execFileSync('/bin/sh', ['-c', 'codesign -dv "$1" 2>&1 || true', 'sh', real], {
    encoding: 'utf8'
  })
  return {
    path: appPath,
    realPath: real,
    bundleId: plist(real, 'CFBundleIdentifier'),
    version: plist(real, 'CFBundleShortVersionString'),
    buildId: build?.buildId ?? null,
    commit: build?.commit ?? null,
    teamId: codesign.match(/TeamIdentifier=(\S+)/)?.[1] ?? null,
    executable: `${real}/Contents/MacOS/${plist(real, 'CFBundleExecutable')}`,
    electron: plistValue(
      `${real}/Contents/Frameworks/Electron Framework.framework/Resources/Info.plist`,
      'CFBundleVersion'
    ),
    // Pod renames the CLI (product/identity.json cliName); since pod/decouple it ships only podx.
    cli: ['podx', 'orca']
      .map((name) => `${real}/Contents/Resources/bin/${name}`)
      .find((candidate) => existsSync(candidate)),
    // The suites drive the nested runtime's Electron UI, not PodNative's native UI.
    oneApp: oneAppOf(real)
  }
}
