import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PluginKillList } from '../../shared/plugins/plugin-kill-list'
import type * as ProductIdentityModule from '../product-identity/product-identity'
import type { ProductIdentity } from '../product-identity/product-identity'
import { podIdentityWithoutStablyServices } from '../product-identity/product-identity.test-fixture'
import { PluginKillListService } from './plugin-kill-list-service'

const identity = vi.hoisted((): { current: ProductIdentity | null } => ({ current: null }))

vi.mock('../product-identity/product-identity', async (importOriginal) => ({
  ...(await importOriginal<typeof ProductIdentityModule>()),
  getProductIdentity: () => identity.current
}))

const roots: string[] = []
const cachedList: PluginKillList = {
  version: 1,
  generatedAt: '2026-07-12T20:00:00Z',
  plugins: [{ pluginKey: 'community.unsafe', reason: 'Malware advisory' }]
}

afterEach(async () => {
  identity.current = null
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('plugin kill list without Stably services', () => {
  it('keeps enforcing the cached list without fetching onorca.dev', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-kill-list-stably-'))
    roots.push(root)
    await new PluginKillListService({
      pluginsDataDir: root,
      fetcher: async () => cachedList
    }).refresh()

    identity.current = podIdentityWithoutStablyServices()
    const fetcher = vi.fn(async () => cachedList)
    const service = new PluginKillListService({ pluginsDataDir: root, fetcher })

    await expect(service.refresh()).resolves.toEqual(cachedList)
    expect(fetcher).not.toHaveBeenCalled()
    expect(service.reason('community.unsafe')).toBe('Malware advisory')
  })
})
