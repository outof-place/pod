#!/usr/bin/env node
// Release gate for one-app: the nested runtime must speak the ui-host protocol PodNative's safe quit
// needs (version 2: a quit gets `quitting`/`needsConfirmation` back). A version 1 runtime refuses
// PodNative's v2 hello, so PodNative falls back to the old quit. Two checks, because the main bundle
// is minified and keeps no constant names:
// - the source checkout the runtime was built from declares POD_UI_HOST_PROTOCOL_VERSION >= 2;
// - the runtime's app.asar carries the message types that version added.
//
//   node product/scripts/verify-ui-host-protocol.mjs <runtime .app> [--source <checkout>]
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const ROOT = join(import.meta.dirname, '..', '..')
const PROTOCOL_SOURCE = 'src/main/pod/ui-host/pod-ui-host-protocol.ts'
export const REQUIRED_PROTOCOL_VERSION = 2
// Message types each version added, as they survive minification (string literals).
const VERSION_MARKERS = { 2: ['quitHeartbeat', 'needsConfirmation', 'quitAborted'] }

/** The protocol version a source checkout declares, or null when it has no one-app runtime. */
export function sourceProtocolVersion(text) {
  const match = /export const POD_UI_HOST_PROTOCOL_VERSION = (\d+)/.exec(text)
  return match ? Number(match[1]) : null
}

/** What keeps a source version and a main bundle from meeting `required`. */
export function protocolProblems(sourceVersion, bundleText, required = REQUIRED_PROTOCOL_VERSION) {
  if (sourceVersion === null) {
    return [`the source declares no POD_UI_HOST_PROTOCOL_VERSION (${PROTOCOL_SOURCE})`]
  }
  if (sourceVersion < required) {
    return [`the source declares ui-host protocol ${sourceVersion}, below ${required}`]
  }
  const missing = Object.entries(VERSION_MARKERS)
    .filter(([version]) => Number(version) <= required)
    .flatMap(([, markers]) => markers)
    .filter((marker) => !bundleText.includes(marker))
  return missing.length > 0
    ? [`the runtime's main bundle lacks protocol ${required} messages: ${missing.join(', ')}`]
    : []
}

/** The runtime's main-process JavaScript, from its app.asar. */
export function mainBundleText(app, asar = require('@electron/asar')) {
  const archive = join(app, 'Contents', 'Resources', 'app.asar')
  return asar
    .listPackage(archive, { isPack: false })
    .map((entry) => entry.replace(/^[\\/]/, ''))
    .filter((entry) => /^out[\\/]main[\\/].*\.js$/.test(entry))
    .map((entry) => asar.extractFile(archive, entry).toString('utf8'))
    .join('\n')
}

// Why realpath: run through a symlinked path, a plain compare skips the check and exits 0.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(import.meta.filename)) {
  const [app, flag, source = ROOT] = process.argv.slice(2)
  const sourceFile = join(source, PROTOCOL_SOURCE)
  if (!app || (flag !== undefined && flag !== '--source') || !existsSync(join(app, 'Contents'))) {
    console.error(
      'usage: node product/scripts/verify-ui-host-protocol.mjs <runtime .app> [--source <checkout>]'
    )
    process.exit(2)
  }
  const version = existsSync(sourceFile)
    ? sourceProtocolVersion(readFileSync(sourceFile, 'utf8'))
    : null
  const problems = protocolProblems(version, mainBundleText(app))
  if (problems.length > 0) {
    console.error(`ui-host protocol: ${problems.join('; ')}`)
    process.exit(1)
  }
  console.log(
    `ui-host protocol: ${version} (PodNative's safe quit needs ${REQUIRED_PROTOCOL_VERSION})`
  )
}
