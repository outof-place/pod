import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Why one file: a downstream product (product/identity.json, copied into Resources at packaging)
// renames bundle id, profile, keychain item, URL scheme and update feed together. Absent = upstream Orca.
export const PRODUCT_IDENTITY_RESOURCE = 'product-identity.json'

export type ProductUpdateFeed = { provider: 'github'; owner: string; repo: string }

export type ProductIdentity = {
  displayName: string
  appId: string
  cliName: string
  userDataName: string
  // Electron names the macOS safeStorage item "<keychainName> Safe Storage".
  keychainName: string
  protocols: string[]
  updateFeed: ProductUpdateFeed | null
  copyright: string
  credits: string
  legacyProfile: { userDataName: string; keychainName: string } | null
}

const PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/
const REVERSE_DNS = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/
const URL_SCHEME = /^[a-z][a-z0-9+.-]{0,31}$/
const GITHUB_NAME = /^[A-Za-z0-9_.-]{1,100}$/

function field(record: object, key: string): unknown {
  return Reflect.get(record, key)
}

function requireString(record: object, key: string, pattern?: RegExp): string {
  const value = field(record, key)
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) {
    throw new Error(`product identity: "${key}" must be a non-empty string`)
  }
  if (pattern && !pattern.test(value)) {
    throw new Error(`product identity: "${key}" has an invalid value "${value}"`)
  }
  return value
}

function parseUpdateFeed(value: unknown): ProductUpdateFeed | null {
  if (value === null || value === undefined) {
    return null
  }
  if (typeof value !== 'object' || field(value, 'provider') !== 'github') {
    throw new Error(
      'product identity: "updateFeed" must be null or { provider: "github", owner, repo }'
    )
  }
  return {
    provider: 'github',
    owner: requireString(value, 'owner', GITHUB_NAME),
    repo: requireString(value, 'repo', GITHUB_NAME)
  }
}

function parseLegacyProfile(value: unknown): ProductIdentity['legacyProfile'] {
  if (value === null || value === undefined) {
    return null
  }
  if (typeof value !== 'object') {
    throw new Error('product identity: "legacyProfile" must be null or an object')
  }
  return {
    userDataName: requireString(value, 'userDataName', PATH_SEGMENT),
    keychainName: requireString(value, 'keychainName', PATH_SEGMENT)
  }
}

/** Throws on a malformed file: booting a renamed build as Orca would open Orca's profile. */
export function parseProductIdentity(value: unknown): ProductIdentity {
  if (typeof value !== 'object' || value === null || field(value, 'formatVersion') !== 1) {
    throw new Error('product identity: expected an object with "formatVersion": 1')
  }
  const protocols = field(value, 'protocols')
  if (
    !Array.isArray(protocols) ||
    !protocols.every((scheme) => typeof scheme === 'string' && URL_SCHEME.test(scheme))
  ) {
    throw new Error('product identity: "protocols" must be an array of URL schemes')
  }
  return {
    displayName: requireString(value, 'displayName', PATH_SEGMENT),
    appId: requireString(value, 'appId', REVERSE_DNS),
    cliName: requireString(value, 'cliName', PATH_SEGMENT),
    userDataName: requireString(value, 'userDataName', PATH_SEGMENT),
    keychainName: requireString(value, 'keychainName', PATH_SEGMENT),
    protocols: [...protocols],
    updateFeed: parseUpdateFeed(field(value, 'updateFeed')),
    copyright: requireString(value, 'copyright'),
    credits: requireString(value, 'credits'),
    legacyProfile: parseLegacyProfile(field(value, 'legacyProfile'))
  }
}

/** Reads `<resourcesPath>/product-identity.json`; null when the build ships none. */
export function readProductIdentity(resourcesPath: string): ProductIdentity | null {
  let text: string
  try {
    text = readFileSync(join(resourcesPath, PRODUCT_IDENTITY_RESOURCE), 'utf8')
  } catch (error) {
    if (Reflect.get(Object(error), 'code') === 'ENOENT') {
      return null
    }
    throw error
  }
  return parseProductIdentity(JSON.parse(text))
}

let cached: ProductIdentity | null | undefined

/** The packaged build's identity; always null for dev and unpackaged runs. */
export function getProductIdentity(): ProductIdentity | null {
  if (cached === undefined) {
    const resourcesPath: unknown = process.resourcesPath
    // Why not app.isPackaged: plain-Node hosts (CLI, orcad) import this without Electron.
    const packaged =
      typeof resourcesPath === 'string' &&
      resourcesPath.length > 0 &&
      !process.defaultApp &&
      process.versions.electron !== undefined
    cached = packaged ? readProductIdentity(resourcesPath) : null
  }
  return cached
}

/** URL schemes this build registers with the OS. */
export function productUrlSchemes(): readonly string[] {
  return getProductIdentity()?.protocols ?? ['orca']
}
