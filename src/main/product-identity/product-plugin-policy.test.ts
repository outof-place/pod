import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as LockfileStoreModule from '../plugins/plugin-install-lockfile-store'
import type * as ProductIdentityModule from './product-identity'
import type { ProductIdentity } from './product-identity'
import { podIdentityWithoutStablyServices } from './product-identity.test-fixture'

const mocks = vi.hoisted(() => {
  const identity: { current: ProductIdentity | null } = { current: null }
  return { identity, gitExecFileAsync: vi.fn() }
})

vi.mock('./product-identity', async (importOriginal) => ({
  ...(await importOriginal<typeof ProductIdentityModule>()),
  getProductIdentity: () => mocks.identity.current
}))
vi.mock('../git/runner', () => ({ gitExecFileAsync: mocks.gitExecFileAsync }))
vi.mock('../plugins/plugin-install-lockfile-store', async (importOriginal) => ({
  ...(await importOriginal<typeof LockfileStoreModule>()),
  readPluginLockfile: async () => ({
    plugins: {
      'outof-place.pod-acc': { source: { kind: 'bundled', bundleId: 'outof-place.pod-acc' } },
      'community.notes': { source: { kind: 'marketplace' } },
      'community.theme': { source: { kind: 'git' } }
    }
  })
}))

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkoutPluginGitSource } from '../plugins/plugin-git-repository'
import { PluginMarketplaceService } from '../plugins/plugin-marketplace-service'
import { installStagedPluginTree } from '../plugins/plugin-install-staging'
import {
  assertThirdPartyPluginsAllowed,
  bindThirdPartyPluginSettings,
  withoutBlockedThirdPartyPlugins
} from './product-plugin-policy'

const INSTALLED = [
  { pluginKey: 'outof-place.pod-acc' },
  { pluginKey: 'community.notes' },
  { pluginKey: 'community.theme' },
  // An unreadable install has no key and no provenance.
  { pluginKey: undefined }
]

describe('third-party plugins in a product without Stably services', () => {
  afterEach(() => {
    mocks.identity.current = null
    bindThirdPartyPluginSettings(() => null)
    mocks.gitExecFileAsync.mockReset()
  })

  it('changes nothing for upstream Orca', async () => {
    expect(() => assertThirdPartyPluginsAllowed()).not.toThrow()
    await expect(withoutBlockedThirdPartyPlugins(INSTALLED, '/plugins')).resolves.toBe(INSTALLED)
  })

  it('discovers only bundled installs until the user opts in', async () => {
    mocks.identity.current = podIdentityWithoutStablyServices()
    await expect(withoutBlockedThirdPartyPlugins(INSTALLED, '/plugins')).resolves.toEqual([
      { pluginKey: 'outof-place.pod-acc' }
    ])

    bindThirdPartyPluginSettings(() => ({ thirdPartyPluginsEnabled: true }))
    await expect(withoutBlockedThirdPartyPlugins(INSTALLED, '/plugins')).resolves.toBe(INSTALLED)
  })

  it('never clones the official marketplace while only bundled plugins are allowed', async () => {
    mocks.identity.current = podIdentityWithoutStablyServices()
    const marketplace = new PluginMarketplaceService({
      pluginsDataDir: mkdtempSync(join(tmpdir(), 'pod-marketplace-'))
    })

    const official = await marketplace.seedOfficialSource()

    expect(mocks.gitExecFileAsync).not.toHaveBeenCalled()
    expect(official.error).toContain('Third-party plugins are off in Pod.')
  })

  it('refuses marketplace fetches and every non-bundled install before any work', async () => {
    mocks.identity.current = podIdentityWithoutStablyServices()
    const message = 'Third-party plugins are off in Pod. Turn them on in Settings > Plugins.'

    await expect(
      checkoutPluginGitSource({
        url: 'https://github.com/stablyai/orca-plugins.git',
        ref: 'main',
        destination: '/tmp/never',
        workingDirectory: '/tmp'
      })
    ).rejects.toThrow(message)
    expect(mocks.gitExecFileAsync).not.toHaveBeenCalled()
    await expect(
      installStagedPluginTree({
        pluginsDir: '/plugins',
        stagingDir: '/tmp/never',
        hostVersion: '1',
        source: { kind: 'local-path', path: '/tmp/never' },
        resolvedCommit: null
      })
    ).resolves.toEqual({ ok: false, error: message })
  })
})
