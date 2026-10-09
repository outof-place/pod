import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DISTRO_PLUGIN_INDEX_FILENAME,
  setDistroPluginPolicy
} from '../../shared/distro/distro-plugin-policy'
import { parsePluginManifest } from '../../shared/plugins/plugin-manifest'
import { hashPluginTree } from './plugin-content-hash'
import { readPluginLockfile } from './plugin-install'
import { bootstrapBundledPlugins, BUNDLED_PLUGIN_INDEX_FILENAME } from './plugin-bundled-bootstrap'
import { PluginBundledBootstrapCoordinator } from './plugin-bundled-bootstrap-coordinator'

// The committed resources, as a Pod build ships them.
const DISTRO = join(process.cwd(), 'resources', 'plugins', 'distro')
const LAUNCH = join(process.cwd(), 'resources', 'plugins', 'launch')
const POD_ACC = 'outof-place.pod-acc'
const POLICY = { publishers: ['outof-place'], idPrefix: 'pod-', enablePluginSystem: true }

const roots: string[] = []
afterEach(async () => {
  setDistroPluginPolicy(null)
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Pod bundled claude-acc plugin', () => {
  it('ships under its distro identity with the hash its index pins', async () => {
    const index = JSON.parse(await readFile(join(DISTRO, DISTRO_PLUGIN_INDEX_FILENAME), 'utf8'))
    expect(index.plugins.map((p: { pluginKey: string }) => p.pluginKey)).toEqual([POD_ACC])
    const hashed = await hashPluginTree(join(DISTRO, index.plugins[0].path))
    expect(hashed.ok && hashed.hash).toBe(index.plugins[0].contentHash)
    const parsed = parsePluginManifest(
      JSON.parse(await readFile(join(DISTRO, POD_ACC, 'orca-plugin.json'), 'utf8'))
    )
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(`${parsed.manifest.publisher}.${parsed.manifest.id}`).toBe(POD_ACC)
      expect(parsed.manifest.contributes.statusBarItems.map((item) => item.id)).toEqual([
        'account',
        'memory',
        'awake'
      ])
      expect(parsed.manifest.capabilities.map((c) => c.kind)).toContain('panelMessaging')
    }
    // Orca's own index stays upstream's
    const upstream = JSON.parse(await readFile(join(LAUNCH, BUNDLED_PLUGIN_INDEX_FILENAME), 'utf8'))
    expect(
      upstream.plugins.every((p: { pluginKey: string }) => p.pluginKey.startsWith('stablyai.'))
    ).toBe(true)
  })

  it('installs through the bundled bootstrap only when the product policy admits it', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'pod-bundled-user-data-'))
    roots.push(userDataPath)
    const request = {
      root: DISTRO,
      userDataPath,
      hostVersion: '1.4.300',
      indexFilename: DISTRO_PLUGIN_INDEX_FILENAME
    }
    await expect(bootstrapBundledPlugins(request)).rejects.toThrow(/official identity/)
    setDistroPluginPolicy(POLICY)
    await expect(bootstrapBundledPlugins(request)).resolves.toMatchObject({
      installed: [POD_ACC],
      errors: []
    })
    const lock = await readPluginLockfile(join(userDataPath, 'plugins'))
    expect(lock.plugins[POD_ACC]?.source).toEqual({ kind: 'bundled', bundleId: POD_ACC })
    await expect(bootstrapBundledPlugins(request)).resolves.toMatchObject({ unchanged: [POD_ACC] })
  })

  it('the coordinator merges the distro index into every result list and reports its plugins', async () => {
    const calls: (string | undefined)[] = []
    const bootstrap = vi.fn(async (options: { root: string; indexFilename?: string }) => {
      calls.push(options.indexFilename && `${options.root}/${options.indexFilename}`)
      return options.indexFilename
        ? { installed: [POD_ACC], unchanged: [], skipped: ['outof-place.pod-other-os'], errors: [] }
        : { installed: [], unchanged: ['stablyai.orca-theme'], skipped: [], errors: [] }
    })
    const order: string[] = []
    const coordinator = new PluginBundledBootstrapCoordinator({
      root: 'resources',
      userDataPath: 'user-data',
      hostVersion: '1.4.0',
      isEnabled: () => true,
      refreshPlugins: async () => {
        order.push('refresh')
      },
      bootstrap,
      distro: () => ({ root: 'distro', indexFilename: DISTRO_PLUGIN_INDEX_FILENAME }),
      onDistroPlugins: async (keys) => {
        order.push(`distro:${keys.join(',')}`)
      }
    })
    await expect(coordinator.request()).resolves.toEqual({
      installed: [POD_ACC],
      unchanged: ['stablyai.orca-theme'],
      skipped: ['outof-place.pod-other-os'],
      errors: []
    })
    expect(calls).toEqual([undefined, `distro/${DISTRO_PLUGIN_INDEX_FILENAME}`])
    expect(order).toEqual(['refresh', `distro:${POD_ACC}`])
  })

  it('a missing distro index bundles nothing extra', async () => {
    const enoent = Object.assign(new Error('missing'), { code: 'ENOENT' })
    const onDistroPlugins = vi.fn()
    const coordinator = new PluginBundledBootstrapCoordinator({
      root: 'resources',
      userDataPath: 'user-data',
      hostVersion: '1.4.0',
      isEnabled: () => true,
      refreshPlugins: async () => {},
      bootstrap: vi.fn(async (options: { indexFilename?: string }) => {
        if (options.indexFilename) {
          throw enoent
        }
        return { installed: [], unchanged: [], skipped: [], errors: [] }
      }),
      distro: () => ({ root: 'distro', indexFilename: DISTRO_PLUGIN_INDEX_FILENAME }),
      onDistroPlugins
    })
    await expect(coordinator.request()).resolves.toEqual({
      installed: [],
      unchanged: [],
      skipped: [],
      errors: []
    })
    expect(onDistroPlugins).not.toHaveBeenCalled()
  })
})
