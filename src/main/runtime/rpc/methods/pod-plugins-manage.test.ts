import '../unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcResponse } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { setPodPluginManage, type PodPluginManage } from '../../../pod/plugins/pod-plugin-manage'
import { POD_RUNTIME_CAPABILITIES } from '../../../../shared/pod-runtime-capabilities'
import { POD_PLUGIN_MARKETPLACE_SOURCE_ID } from '../../../../shared/rpc-contract/pod-plugins-manage-params'
import { PLUGIN_MARKETPLACE_SOURCE_ID_PATTERN } from '../../../plugins/plugin-marketplace-store'
import { POD_PLUGIN_MANAGE_METHODS } from './pod-plugins-manage'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the methods read only the runtime id.
const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService

const SOURCE_ID = 'a'.repeat(32)
const COMMIT = 'b'.repeat(40)
const PLUGIN_KEY = 'orca-samples.demo'
const INSTALLED = {
  ok: true as const,
  pluginKey: PLUGIN_KEY,
  version: '1.0.0',
  contentHash: 'hash',
  consentFingerprint: 'fingerprint',
  resolvedCommit: null
}

function dispatch(
  method: string,
  params?: unknown,
  options?: { pairedDeviceId?: string }
): Promise<RpcResponse> {
  return new RpcDispatcher({ runtime, methods: POD_PLUGIN_MANAGE_METHODS }).dispatch(
    { id: 'req-1', authToken: 'tok', method, params },
    options
  )
}

function fakeManage(): PodPluginManage & { calls: string[] } {
  const calls: string[] = []
  const record =
    <T>(name: string, value: T) =>
    async (...args: unknown[]): Promise<T> => {
      calls.push(`${name} ${JSON.stringify(args)}`)
      return value
    }
  return {
    calls,
    install: record('install', INSTALLED),
    remove: record('remove', []),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each method only records its call; the RPC passes the result through untouched.
    marketplace: {
      listSources: record('listSources', []),
      addSource: record('addSource', { id: SOURCE_ID }),
      removeSource: record('removeSource', []),
      refresh: record('refresh', []),
      listPlugins: record('listPlugins', []),
      preview: record('preview', { pluginKey: PLUGIN_KEY }),
      install: record('marketplaceInstall', INSTALLED),
      previewUpdate: record('previewUpdate', { pluginKey: PLUGIN_KEY }),
      rollback: record('rollback', INSTALLED)
    } as unknown as PodPluginManage['marketplace']
  }
}

afterEach(() => {
  setPodPluginManage(null)
})

describe('plugins.install, remove and the marketplace over RPC', () => {
  it('is advertised, so a client offers them only where they work', () => {
    expect(POD_RUNTIME_CAPABILITIES).toContain('pod.plugins.manage.v1')
  })

  it('declares host-admin on every method: each one writes code into the plugins folder', () => {
    expect(POD_PLUGIN_MANAGE_METHODS.every((method) => method.permission === 'host-admin')).toBe(
      true
    )
  })

  it("keeps the marketplace source id the store's own", () => {
    expect(POD_PLUGIN_MARKETPLACE_SOURCE_ID.source).toBe(PLUGIN_MARKETPLACE_SOURCE_ID_PATTERN.source)
  })

  it('installs from a folder or a Git URL at a ref, and refuses what plugins:install refuses', async () => {
    const manage = fakeManage()
    setPodPluginManage(manage)

    await expect(
      dispatch('plugins.install', { kind: 'local-path', path: '/tmp/plugin' })
    ).resolves.toMatchObject({ ok: true, result: { ok: true, pluginKey: PLUGIN_KEY } })
    await expect(
      dispatch('plugins.install', { kind: 'git', url: 'https://example.com/p.git', ref: 'main' })
    ).resolves.toMatchObject({ ok: true })
    for (const params of [
      { kind: 'git', url: 'https://example.com/p.git' },
      { kind: 'git', url: 'ext::sh -c calc', ref: 'main' },
      { kind: 'local-path', path: '' }
    ]) {
      await expect(dispatch('plugins.install', params)).resolves.toMatchObject({
        ok: false,
        error: { code: 'invalid_argument' }
      })
    }
    expect(manage.calls).toEqual([
      'install [{"kind":"local-path","path":"/tmp/plugin"}]',
      'install [{"kind":"git","url":"https://example.com/p.git","ref":"main"}]'
    ])
  })

  it('removes by qualified key only', async () => {
    const manage = fakeManage()
    setPodPluginManage(manage)

    await expect(dispatch('plugins.remove', { pluginKey: PLUGIN_KEY })).resolves.toMatchObject({
      ok: true
    })
    await expect(dispatch('plugins.remove', { pluginKey: 'demo' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_argument' }
    })
    expect(manage.calls).toEqual([`remove ["${PLUGIN_KEY}"]`])
  })

  it('passes the marketplace calls through with what the preview showed', async () => {
    const manage = fakeManage()
    setPodPluginManage(manage)
    const listing = { marketplaceSourceId: SOURCE_ID, pluginKey: PLUGIN_KEY }

    for (const [method, params] of [
      ['plugins.listMarketplaces', undefined],
      ['plugins.addMarketplace', { kind: 'git', url: 'https://example.com/m.git', ref: 'main' }],
      ['plugins.removeMarketplace', { sourceId: SOURCE_ID }],
      ['plugins.refreshMarketplaces', {}],
      ['plugins.listMarketplacePlugins', undefined],
      ['plugins.previewMarketplacePlugin', listing],
      [
        'plugins.installMarketplacePlugin',
        { ...listing, marketplaceCommit: COMMIT, resolvedCommit: COMMIT }
      ],
      ['plugins.previewMarketplaceUpdate', { pluginKey: PLUGIN_KEY }],
      ['plugins.rollbackMarketplacePlugin', { pluginKey: PLUGIN_KEY }]
    ] as const) {
      await expect(dispatch(method, params), method).resolves.toMatchObject({ ok: true })
    }
    expect(manage.calls.map((call) => call.split(' ')[0])).toEqual([
      'listSources',
      'addSource',
      'removeSource',
      'refresh',
      'listPlugins',
      'preview',
      'marketplaceInstall',
      'previewUpdate',
      'rollback'
    ])
    await expect(
      dispatch('plugins.installMarketplacePlugin', { ...listing, marketplaceCommit: COMMIT })
    ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
  })

  it('refuses paired devices before anything is written', async () => {
    const manage = fakeManage()
    setPodPluginManage(manage)

    await expect(
      dispatch('plugins.install', { kind: 'local-path', path: '/tmp/plugin' }, { pairedDeviceId: 'phone-1' })
    ).resolves.toMatchObject({ ok: false, error: { code: 'forbidden' } })
    await expect(
      dispatch('plugins.remove', { pluginKey: PLUGIN_KEY }, { pairedDeviceId: 'phone-1' })
    ).resolves.toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(manage.calls).toEqual([])
  })

  it('answers runtime_unavailable before the plugin service starts', async () => {
    await expect(dispatch('plugins.listMarketplaces')).resolves.toMatchObject({
      ok: false,
      error: { code: 'runtime_unavailable' }
    })
  })
})
