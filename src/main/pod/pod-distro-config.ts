import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DistroPluginPolicy } from '../../shared/distro/distro-plugin-policy'
import { PRODUCT_IDENTITY_RESOURCE } from '../product-identity/product-identity'

// Why its own reader: the product identity file (product/identity.json, packaged as
// Resources/product-identity.json) also carries Pod's claude-acc keys; the generic identity
// parser ignores them, and an upstream build ships no file at all.
// Unpackaged runs (dev, e2e) read no resource; this points them at an identity file instead.
export const POD_DISTRO_IDENTITY_ENV = 'POD_DISTRO_IDENTITY_PATH'

export type PodClaudeAccConfig = {
  /** Directory under Resources holding the claude-acc payload (scripts/payload.sh output). */
  payload: string
  /** Plugin key of the bundled claude-acc plugin. */
  pluginKey: string
}

export type PodDistroConfig = {
  bundledPlugins: DistroPluginPolicy | null
  claudeAcc: PodClaudeAccConfig | null
}

const NONE: PodDistroConfig = { bundledPlugins: null, claudeAcc: null }
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const RESOURCE_DIR = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null
}

/** Throws on a malformed section: a half-read policy must not bundle or enable anything. */
export function parsePodDistroConfig(raw: unknown): PodDistroConfig {
  const root = record(raw)
  if (!root) {
    throw new Error('pod distro config: identity must be an object')
  }
  let bundledPlugins: DistroPluginPolicy | null = null
  const plugins = record(root.bundledPlugins)
  if (root.bundledPlugins !== undefined && root.bundledPlugins !== null) {
    const publishers = plugins?.publishers
    if (
      !plugins ||
      !Array.isArray(publishers) ||
      publishers.length === 0 ||
      !publishers.every((p) => typeof p === 'string' && SLUG.test(p) && p !== 'stablyai') ||
      typeof plugins.idPrefix !== 'string' ||
      !/^[a-z0-9]+-$/.test(plugins.idPrefix)
    ) {
      throw new Error(
        'pod distro config: "bundledPlugins" needs publishers (not stablyai) and an idPrefix like "pod-"'
      )
    }
    bundledPlugins = {
      publishers: publishers.filter((p): p is string => typeof p === 'string'),
      idPrefix: plugins.idPrefix,
      enablePluginSystem: plugins.enablePluginSystem === true
    }
  }
  let claudeAcc: PodClaudeAccConfig | null = null
  const acc = record(root.claudeAcc)
  if (root.claudeAcc !== undefined && root.claudeAcc !== null) {
    if (
      !acc ||
      typeof acc.payload !== 'string' ||
      !RESOURCE_DIR.test(acc.payload) ||
      typeof acc.pluginKey !== 'string'
    ) {
      throw new Error(
        'pod distro config: "claudeAcc" needs a payload resource directory and a pluginKey'
      )
    }
    claudeAcc = { payload: acc.payload, pluginKey: acc.pluginKey }
  }
  return { bundledPlugins, claudeAcc }
}

export function readPodDistroConfig(options: {
  resourcesPath: string | null
  packaged: boolean
  env: NodeJS.ProcessEnv
}): PodDistroConfig {
  const path = options.packaged
    ? options.resourcesPath
      ? join(options.resourcesPath, PRODUCT_IDENTITY_RESOURCE)
      : null
    : (options.env[POD_DISTRO_IDENTITY_ENV] ?? null)
  if (!path) {
    return NONE
  }
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if (Reflect.get(Object(error), 'code') === 'ENOENT') {
      return NONE
    }
    throw error
  }
  return parsePodDistroConfig(JSON.parse(text))
}

let cached: PodDistroConfig | undefined

/** The running build's Pod config; upstream Orca builds get an empty one. */
export function getPodDistroConfig(): PodDistroConfig {
  if (cached === undefined) {
    const resourcesPath: unknown = process.resourcesPath
    const packaged =
      typeof resourcesPath === 'string' &&
      resourcesPath.length > 0 &&
      !process.defaultApp &&
      process.versions.electron !== undefined
    try {
      cached = readPodDistroConfig({
        resourcesPath: typeof resourcesPath === 'string' ? resourcesPath : null,
        packaged,
        env: process.env
      })
    } catch (error) {
      console.warn('[pod] ignoring the distro section of the product identity:', error)
      cached = NONE
    }
  }
  return cached
}

export function resetPodDistroConfigForTests(): void {
  cached = undefined
}
