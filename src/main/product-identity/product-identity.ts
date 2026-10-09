import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Why one file: a downstream product (product/identity.json, copied into Resources at packaging)
// renames bundle id, profile, keychain item, URL scheme and update feed together. Absent = upstream Orca.
export const PRODUCT_IDENTITY_RESOURCE = 'product-identity.json'
// Written at packaging from upstream.json: the Orca base this build was cut from.
export const PRODUCT_UPSTREAM_RESOURCE = 'product-upstream.json'
// Lets unpackaged E2E runs (which never read Resources) exercise product behaviour.
export const PRODUCT_IDENTITY_E2E_ENV = 'POD_E2E_PRODUCT_IDENTITY_PATH'

export type ProductUpdateFeed = { provider: 'github'; owner: string; repo: string }

export type ProductIdentity = {
  displayName: string
  appId: string
  /** package.json `name` in the packaged app; Electron's default app name before startup renames it. */
  packageName: string
  cliName: string
  userDataName: string
  // Electron names the macOS safeStorage item "<keychainName> Safe Storage" / "<keychainName> Key".
  keychainName: string
  protocols: string[]
  homepage: string | null
  updateFeed: ProductUpdateFeed | null
  copyright: string
  credits: string
  /** False turns off Stably's hosted services (telemetry, relay, push, share, feedback). */
  stablyServices: boolean
  computerUseDisplayName: string | null
  /** Keychain service for Orca-managed Claude Code accounts; null keeps Orca's. */
  claudeManagedCredentialsService: string | null
  legacyProfile: {
    userDataName: string
    keychainName: string
    claudeManagedCredentialsService: string | null
  } | null
}

export type ProductUpstream = { tag: string | null; sha: string }

const PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/
const PACKAGE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/
const REVERSE_DNS = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/
const URL_SCHEME = /^[a-z][a-z0-9+.-]{0,31}$/
const GITHUB_NAME = /^[A-Za-z0-9_.-]{1,100}$/
const KEYCHAIN_SERVICE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/

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

function optionalString(record: object, key: string, pattern?: RegExp): string | null {
  return field(record, key) === undefined || field(record, key) === null
    ? null
    : requireString(record, key, pattern)
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
    keychainName: requireString(value, 'keychainName', PATH_SEGMENT),
    claudeManagedCredentialsService: optionalString(
      value,
      'claudeManagedCredentialsService',
      KEYCHAIN_SERVICE
    )
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
  const homepage = optionalString(value, 'homepage')
  if (homepage !== null && !homepage.startsWith('https://')) {
    throw new Error('product identity: "homepage" must be an https:// URL')
  }
  const stablyServices = field(value, 'stablyServices')
  if (stablyServices !== undefined && typeof stablyServices !== 'boolean') {
    throw new Error('product identity: "stablyServices" must be a boolean')
  }
  const userDataName = requireString(value, 'userDataName', PATH_SEGMENT)
  return {
    displayName: requireString(value, 'displayName', PATH_SEGMENT),
    appId: requireString(value, 'appId', REVERSE_DNS),
    packageName: optionalString(value, 'packageName', PACKAGE_NAME) ?? userDataName.toLowerCase(),
    cliName: requireString(value, 'cliName', PATH_SEGMENT),
    userDataName,
    keychainName: requireString(value, 'keychainName', PATH_SEGMENT),
    protocols: [...protocols],
    homepage,
    updateFeed: parseUpdateFeed(field(value, 'updateFeed')),
    copyright: requireString(value, 'copyright'),
    credits: requireString(value, 'credits'),
    stablyServices: stablyServices ?? true,
    computerUseDisplayName: optionalString(value, 'computerUseDisplayName', PATH_SEGMENT),
    claudeManagedCredentialsService: optionalString(
      value,
      'claudeManagedCredentialsService',
      KEYCHAIN_SERVICE
    ),
    legacyProfile: parseLegacyProfile(field(value, 'legacyProfile'))
  }
}

function readJsonFile(path: string): unknown {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if (Reflect.get(Object(error), 'code') === 'ENOENT') {
      return undefined
    }
    throw error
  }
  return JSON.parse(text)
}

/** Reads `<resourcesPath>/product-identity.json`; null when the build ships none. */
export function readProductIdentity(resourcesPath: string): ProductIdentity | null {
  const value = readJsonFile(join(resourcesPath, PRODUCT_IDENTITY_RESOURCE))
  return value === undefined ? null : parseProductIdentity(value)
}

let cached: ProductIdentity | null | undefined

function isPackagedElectron(resourcesPath: unknown): resourcesPath is string {
  // Why not app.isPackaged: plain-Node hosts (CLI, orcad) import this without Electron.
  return (
    typeof resourcesPath === 'string' &&
    resourcesPath.length > 0 &&
    !process.defaultApp &&
    process.versions.electron !== undefined
  )
}

/** The packaged build's identity; null for upstream builds, dev and unpackaged runs. */
export function getProductIdentity(): ProductIdentity | null {
  if (cached === undefined) {
    const resourcesPath: unknown = process.resourcesPath
    const e2ePath = process.env[PRODUCT_IDENTITY_E2E_ENV]
    if (isPackagedElectron(resourcesPath)) {
      cached = readProductIdentity(resourcesPath)
    } else if (e2ePath && process.env.ORCA_E2E_USER_DATA_DIR) {
      const value = readJsonFile(e2ePath)
      cached = value === undefined ? null : parseProductIdentity(value)
    } else {
      cached = null
    }
  }
  return cached
}

/** The Orca release/commit this product build is based on, when packaging recorded it. */
export function getProductUpstream(): ProductUpstream | null {
  const resourcesPath: unknown = process.resourcesPath
  if (!getProductIdentity() || !isPackagedElectron(resourcesPath)) {
    return null
  }
  try {
    const value = readJsonFile(join(resourcesPath, PRODUCT_UPSTREAM_RESOURCE))
    if (typeof value !== 'object' || value === null) {
      return null
    }
    const sha = field(value, 'sha')
    const tag = field(value, 'tag')
    return typeof sha === 'string' && sha.length > 0
      ? { sha, tag: typeof tag === 'string' && tag.length > 0 ? tag : null }
      : null
  } catch {
    return null
  }
}

/** URL schemes this build registers with the OS. */
export function productUrlSchemes(): readonly string[] {
  return getProductIdentity()?.protocols ?? ['orca']
}
