import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  getDistroPluginPolicy,
  isDistroPluginIdentity
} from '../../shared/distro/distro-plugin-policy'
import {
  normalizePluginConsents,
  normalizePluginIdList
} from '../../shared/plugins/plugin-consent-state'

// One-shot marker: Pod turns the plugin system on for a profile once; a user who turns it off
// afterwards keeps it off.
export const POD_PLUGIN_DEFAULTS_MARKER = 'pod-plugin-defaults.json'

type SettingsStore = {
  getSettings(): {
    pluginSystemEnabled?: boolean
    disabledPlugins?: unknown
    pluginConsents?: unknown
  }
  updateSettings(updates: { pluginSystemEnabled: boolean }): unknown
}

/** Returns true when it turned the plugin system on. */
export function enablePluginSystemOnce(store: SettingsStore, userDataPath: string): boolean {
  if (!getDistroPluginPolicy()?.enablePluginSystem) {
    return false
  }
  const marker = join(userDataPath, POD_PLUGIN_DEFAULTS_MARKER)
  if (existsSync(marker)) {
    return false
  }
  const turnedOn = store.getSettings().pluginSystemEnabled !== true
  if (turnedOn) {
    store.updateSettings({ pluginSystemEnabled: true })
  }
  writeFileSync(marker, `${JSON.stringify({ pluginSystemEnabledAt: Date.now(), turnedOn })}\n`)
  return turnedOn
}

type ConsentTarget = { pluginKey: string; consentFingerprint: string }

/**
 * The product's own bundled plugins need no review dialog: Pod ships and signs them with the app.
 * Approves each distro plugin whose current fingerprint has no consent yet, unless the user
 * disabled it; Orca's own and third-party plugins still go through consent.
 */
export async function approveDistroBundledPlugins(input: {
  pluginKeys: readonly string[]
  store: SettingsStore
  findPlugin: (pluginKey: string) => ConsentTarget | null
  approve: (target: ConsentTarget) => Promise<void>
}): Promise<string[]> {
  const settings = input.store.getSettings()
  const disabled = new Set(normalizePluginIdList(settings.disabledPlugins))
  const consents = normalizePluginConsents(settings.pluginConsents)
  const approved: string[] = []
  for (const pluginKey of input.pluginKeys) {
    if (!isDistroPluginIdentity(pluginKey) || disabled.has(pluginKey)) {
      continue
    }
    const plugin = input.findPlugin(pluginKey)
    if (!plugin || consents[pluginKey] === plugin.consentFingerprint) {
      continue
    }
    await input.approve(plugin)
    approved.push(pluginKey)
  }
  return approved
}
