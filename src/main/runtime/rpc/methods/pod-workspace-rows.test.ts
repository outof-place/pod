import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { RuntimeClientSettingsController } from '../../runtime-client-settings'
import { RuntimeRepositorySparsePresets } from '../../runtime-repository-sparse-presets'
import { RuntimeRepositorySettingsController } from '../../runtime-repository-settings-controller'
import { POD_WORKSPACE_ROW_METHODS } from './pod-workspace-rows'
import { RepoUpdate } from '../../../../shared/rpc-contract/repo-params'
import { RUNTIME_CAPABILITIES } from '../../../../shared/protocol-version'
import { POD_WORKSPACE_ROWS_RUNTIME_CAPABILITY } from '../../../../shared/pod-runtime-capabilities'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import type { SparsePreset } from '../../../../shared/worktree/create-types'
import type { Repo } from '../../../../shared/repo-types'

const REPO: Repo = {
  id: 'repo-1',
  path: '/srv/repo',
  displayName: 'repo',
  badgeColor: '#000000',
  addedAt: 0
}

function preset(id: string): SparsePreset {
  return { id, repoId: REPO.id, name: id, directories: ['src'], createdAt: 1, updatedAt: 1 }
}

function setup(initial: Pick<GlobalSettings, 'hostSettingOverrides'>) {
  let settings: GlobalSettings = { ...createGlobalSettingsFixture(), ...initial }
  const updateSettings = vi.fn((updates: Partial<GlobalSettings>) => {
    settings = { ...settings, ...updates }
  })
  const clientSettings = new RuntimeClientSettingsController({
    getSettings: () => settings,
    updateSettings
  })
  const presets = [preset('frontend'), preset('docs')]
  const removeSparsePreset = vi.fn((repoId: string, presetId: string) => {
    presets.splice(
      presets.findIndex((entry) => entry.repoId === repoId && entry.id === presetId),
      1
    )
  })
  const sparse = new RuntimeRepositorySparsePresets({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: remove() reads only these two store members.
    getStore: () => ({ getSparsePresets: () => [...presets], removeSparsePreset }) as never,
    resolveRepo: async () => REPO
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the dispatcher only calls these members.
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    setClientHostDisplayLabel: clientSettings.setHostDisplayLabel.bind(clientSettings),
    removeSparsePreset: sparse.remove.bind(sparse)
  } as unknown as OrcaRuntimeService
  const dispatcher = new RpcDispatcher({ runtime, methods: POD_WORKSPACE_ROW_METHODS })
  const call = (method: string, params: unknown) =>
    dispatcher.dispatch({ id: 'req-1', authToken: 'tok', method, params })
  return {
    call,
    settings: () => settings,
    updateSettings,
    presets,
    removeSparsePreset
  }
}

describe('host.setDisplayLabel (Pod)', () => {
  it.each(['local', 'ssh:build-box', 'runtime:env-1'])(
    'renames %s and leaves its other overrides alone',
    async (hostId) => {
      const rows = setup({
        hostSettingOverrides: {
          [hostId]: { defaultWorktreeLocation: '/srv/worktrees' },
          'ssh:other': { displayLabel: 'Other' }
        }
      })

      const response = await rows.call('host.setDisplayLabel', {
        hostId,
        displayLabel: '  Build host  '
      })

      expect(response).toMatchObject({
        ok: true,
        // Same projection as settings.get: labels only, never the host's folders.
        result: {
          hostSettingOverrides: {
            [hostId]: { displayLabel: 'Build host' },
            'ssh:other': { displayLabel: 'Other' }
          }
        }
      })
      expect(JSON.stringify(response)).not.toContain('/srv/worktrees')
      expect(rows.settings().hostSettingOverrides).toEqual({
        [hostId]: { defaultWorktreeLocation: '/srv/worktrees', displayLabel: 'Build host' },
        'ssh:other': { displayLabel: 'Other' }
      })
      expect(rows.updateSettings).toHaveBeenCalledWith(expect.anything(), {
        notifyListeners: true
      })
    }
  )

  it.each([null, '   '])('clears the rename for %j', async (displayLabel) => {
    const rows = setup({
      hostSettingOverrides: {
        'ssh:build-box': { displayLabel: 'Build host', defaultWorktreeLocation: '/srv/wt' },
        local: { displayLabel: 'Laptop' }
      }
    })

    await rows.call('host.setDisplayLabel', { hostId: 'ssh:build-box', displayLabel })
    expect(rows.settings().hostSettingOverrides).toEqual({
      'ssh:build-box': { defaultWorktreeLocation: '/srv/wt' },
      local: { displayLabel: 'Laptop' }
    })

    const response = await rows.call('host.setDisplayLabel', { hostId: 'local', displayLabel })
    expect(response).toMatchObject({ ok: true, result: { hostSettingOverrides: {} } })
    // A host with nothing left drops out of the map.
    expect(rows.settings().hostSettingOverrides).toEqual({
      'ssh:build-box': { defaultWorktreeLocation: '/srv/wt' }
    })
  })

  it.each([
    { hostId: 'ssh:', displayLabel: 'x' },
    { hostId: 'nowhere', displayLabel: 'x' },
    { hostId: 'local' },
    { hostId: 'local', displayLabel: 'x'.repeat(257) },
    { hostId: 'local', displayLabel: 'x', extra: true }
  ])('refuses %j', async (params) => {
    const rows = setup({ hostSettingOverrides: {} })
    const response = await rows.call('host.setDisplayLabel', params)
    expect(response.ok).toBe(false)
    expect(rows.updateSettings).not.toHaveBeenCalled()
  })

  it('is a settings write, and Pod hosts say they serve it', () => {
    const method = POD_WORKSPACE_ROW_METHODS.find((entry) => entry.name === 'host.setDisplayLabel')
    expect(method?.permission).toBe('settings-write')
    expect(RUNTIME_CAPABILITIES).toContain(POD_WORKSPACE_ROWS_RUNTIME_CAPABILITY)
  })
})

describe('repo.removeSparsePreset (Pod)', () => {
  it('removes the preset from its repo', async () => {
    const rows = setup({ hostSettingOverrides: {} })
    const response = await rows.call('repo.removeSparsePreset', {
      repo: 'id:repo-1',
      presetId: 'docs'
    })
    expect(response).toMatchObject({ ok: true, result: { removed: true } })
    expect(rows.removeSparsePreset).toHaveBeenCalledWith('repo-1', 'docs')
    expect(rows.presets.map((entry) => entry.id)).toEqual(['frontend'])
  })

  it('answers removed: false for a preset the repo does not have', async () => {
    const rows = setup({ hostSettingOverrides: {} })
    const response = await rows.call('repo.removeSparsePreset', {
      repo: 'id:repo-1',
      presetId: 'gone'
    })
    expect(response).toMatchObject({ ok: true, result: { removed: false } })
    expect(rows.removeSparsePreset).not.toHaveBeenCalled()
  })

  it('refuses a request without a preset id', async () => {
    const rows = setup({ hostSettingOverrides: {} })
    const response = await rows.call('repo.removeSparsePreset', { repo: 'id:repo-1' })
    expect(response.ok).toBe(false)
    expect(rows.removeSparsePreset).not.toHaveBeenCalled()
  })

  it('refuses a preset id longer than 256 characters', async () => {
    const rows = setup({ hostSettingOverrides: {} })
    const response = await rows.call('repo.removeSparsePreset', {
      repo: 'id:repo-1',
      presetId: 'p'.repeat(257)
    })
    expect(response.ok).toBe(false)
    expect(rows.removeSparsePreset).not.toHaveBeenCalled()
  })
})

describe('repo.update worktreeBaseRef: null (Pod)', () => {
  function controller() {
    const updateRepo = vi.fn((_id: string, updates: Partial<Repo>) => ({ ...REPO, ...updates }))
    const settings = new RuntimeRepositorySettingsController({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: update() without worktreeBasePath reads only updateRepo.
      getStore: () => ({ updateRepo }) as never,
      resolveRepo: async () => ({ ...REPO, worktreeBaseRef: 'origin/develop' }),
      forgetTerminalTopology: () => {},
      invalidateResolvedWorktrees: () => {},
      invalidateWorktreeScan: () => {},
      notifyReposChanged: () => {}
    })
    return { settings, updateRepo }
  }

  it('clears the base ref when a client sends null', async () => {
    const parsed = RepoUpdate.parse({ repo: 'id:repo-1', updates: { worktreeBaseRef: null } })
    expect(Object.keys(parsed.updates)).toEqual(['worktreeBaseRef'])

    const { settings, updateRepo } = controller()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the same cast repo.update's handler makes.
    await settings.update(parsed.repo, parsed.updates as Parameters<typeof settings.update>[1])
    const sent = updateRepo.mock.calls[0]?.[1]
    expect(sent && 'worktreeBaseRef' in sent).toBe(true)
    expect(sent?.worktreeBaseRef).toBeUndefined()
  })

  it('keeps the base ref when the update leaves it out', async () => {
    const parsed = RepoUpdate.parse({ repo: 'id:repo-1', updates: { displayName: 'Renamed' } })
    const { settings, updateRepo } = controller()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the same cast repo.update's handler makes.
    await settings.update(parsed.repo, parsed.updates as Parameters<typeof settings.update>[1])
    expect(updateRepo.mock.calls[0]?.[1]).toEqual({ displayName: 'Renamed' })
    expect(Object.keys(updateRepo.mock.calls[0]?.[1] ?? {})).not.toContain('worktreeBaseRef')
  })
})
