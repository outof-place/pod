#!/usr/bin/env node
// Release gate: every executable and bundle in the app carries only what product/entitlements-policy.cjs
// allows it. The app and Electron's helpers may have the keys of the electron-builder config's
// entitlements files; every other executable only its rule's plist, and most get none.
//
//   node product/scripts/verify-entitlements.mjs <Pod.app>
import { execFileSync, spawnSync } from 'node:child_process'
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const policy = require('../entitlements-policy.cjs')
const ROOT = join(import.meta.dirname, '..', '..')
const BUNDLE = /\.(app|appex|xpc)$/
const MH_EXECUTE = 2

function plistJson(xml) {
  if (!xml.trim()) {
    return {}
  }
  return JSON.parse(
    execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], {
      input: xml,
      encoding: 'utf8'
    })
  )
}

/** Whether `path` is a Mach-O main executable (thin, or the first slice of a universal file). */
function isExecutable(path) {
  const fd = openSync(path, 'r')
  try {
    const head = Buffer.alloc(32)
    if (readSync(fd, head, 0, 32, 0) < 32) {
      return false
    }
    if (head.readUInt32BE(0) === 0xcffaedfe) {
      return head.readUInt32LE(12) === MH_EXECUTE
    }
    if (head.readUInt32BE(0) === 0xcafebabe) {
      const slice = Buffer.alloc(16)
      readSync(fd, slice, 0, 16, head.readUInt32BE(16))
      return slice.readUInt32BE(0) === 0xcffaedfe && slice.readUInt32LE(12) === MH_EXECUTE
    }
    return false
  } finally {
    closeSync(fd)
  }
}

/** The app, its nested bundles and every Mach-O executable, relative to the app. */
export function signedCode(app) {
  const found = ['']
  const walk = (relative) => {
    for (const name of readdirSync(join(app, relative)).sort()) {
      const path = relative ? `${relative}/${name}` : name
      const stat = lstatSync(join(app, path))
      if (stat.isDirectory()) {
        if (BUNDLE.test(name)) {
          found.push(path)
        }
        walk(path)
      } else if (stat.isFile() && stat.size >= 32 && isExecutable(join(app, path))) {
        found.push(path)
      }
    }
  }
  walk('')
  return found
}

/** Keys the electron-builder config grants the app and Electron's helpers. */
export function electronEntitlementKeys(
  config = require(join(ROOT, 'product', 'electron-builder.pod.cjs'))
) {
  const files = [config.mac.entitlements, config.mac.entitlementsInherit].filter(Boolean)
  return new Set(
    files.flatMap((file) => Object.keys(plistJson(readFileSync(join(ROOT, file), 'utf8'))))
  )
}

export function allowedKeys(rule, electronKeys) {
  const file = policy.entitlementsFile(rule)
  return file ? new Set(Object.keys(plistJson(readFileSync(file, 'utf8')))) : electronKeys
}

/** Each code path whose entitlements step outside its rule, with the keys that do. */
export function entitlementViolations(
  app,
  { electronKeys = electronEntitlementKeys(), read } = {}
) {
  const mainExecutable = plistValue(join(app, 'Contents', 'Info.plist'), 'CFBundleExecutable')
  const entitlementsOf =
    read ??
    ((path) =>
      plistJson(
        spawnSync('codesign', ['-d', '--entitlements', '-', '--xml', path], { encoding: 'utf8' })
          .stdout
      ))
  const violations = []
  const code = signedCode(app)
  for (const path of code) {
    const rule = policy.entitlementRule(path, mainExecutable)
    const allowed = allowedKeys(rule, electronKeys)
    const entitlements = entitlementsOf(join(app, path))
    const extra = Object.keys(entitlements)
      .filter((key) => !allowed.has(key) || entitlements[key] !== true)
      .sort()
    if (extra.length > 0) {
      const keys = extra.map((key) => key.replace('com.apple.security.', ''))
      violations.push(`${path || '.'} (${rule.name}): ${keys.join(', ')}`)
    }
  }
  return { checked: code.length, violations }
}

function plistValue(plist, key) {
  const result = spawnSync('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist], {
    encoding: 'utf8'
  })
  return result.status === 0 ? result.stdout.trim() : null
}

// Why realpath: run through a symlinked path, a plain compare skips the check and exits 0.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(import.meta.filename)) {
  const app = process.argv[2]
  if (!app || !existsSync(join(app, 'Contents', 'Info.plist'))) {
    console.error('usage: node product/scripts/verify-entitlements.mjs <Pod.app>')
    process.exit(2)
  }
  const { checked, violations } = entitlementViolations(app)
  if (violations.length > 0) {
    console.error(`entitlements: outside the policy:\n  ${violations.join('\n  ')}`)
    process.exit(1)
  }
  console.log(
    `entitlements: ${checked} executables and bundles within product/entitlements-policy.cjs`
  )
}
