/**
 * Plugins a downstream product (a "distro" of Orca, e.g. Pod) ships in its own bundle, under its own
 * publisher. Unset in upstream Orca, so every check here is a no-op there; main sets it once at
 * startup from the product identity.
 */

export const DISTRO_PLUGIN_INDEX_FILENAME = 'distro-plugins.json'
/** Resources folder of the product's bundled plugins, beside Orca's `plugins/launch`. */
export const DISTRO_PLUGIN_ROOT_SEGMENTS = ['plugins', 'distro'] as const

export type DistroPluginPolicy = {
  /** Publishers whose `<publisher>.<idPrefix>*` plugins the product may bundle. */
  publishers: readonly string[]
  idPrefix: string
  /** Turn the plugin system on once for a fresh profile, so the bundled plugins run. */
  enablePluginSystem: boolean
}

let policy: DistroPluginPolicy | null = null

export function setDistroPluginPolicy(next: DistroPluginPolicy | null): void {
  policy = next ? { ...next, publishers: [...next.publishers] } : null
}

export function getDistroPluginPolicy(): DistroPluginPolicy | null {
  return policy
}

export function isDistroPluginIdentity(pluginKey: string): boolean {
  if (!policy) {
    return false
  }
  const separator = pluginKey.indexOf('.')
  if (separator <= 0) {
    return false
  }
  const publisher = pluginKey.slice(0, separator)
  const id = pluginKey.slice(separator + 1)
  return (
    policy.publishers.includes(publisher) &&
    id.startsWith(policy.idPrefix) &&
    id.length > policy.idPrefix.length
  )
}
