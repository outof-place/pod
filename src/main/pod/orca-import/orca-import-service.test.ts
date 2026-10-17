import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { PodOrcaImportPreview } from '../../../shared/pod-orca-import-types'
import type { Repo } from '../../../shared/repo-types'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import { getOrcaProfileStateDatabaseFile } from '../../../shared/profile-state-storage-paths'
import { openProfileStateDatabase } from '../../persistence/profile-state/profile-state-database'
import { importProfileStateJson } from '../../persistence/profile-state/profile-state-documents'
import type { OrcaImportResolution } from './orca-import-location'
import { censusOf, writeSyntheticOrcaProfile } from './orca-import-profile.test-support'
import { ORCA_IMPORT_RECORD_FILE } from './orca-import-record'
import { OrcaImportService } from './orca-import-service'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

const RUNNING_PID = 4242

const EMPTY_META: WorktreeMeta = {
  displayName: '',
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 0
}

type FakePod = {
  repos: Repo[]
  meta: Record<string, WorktreeMeta>
  settings: GlobalSettings
  keybindingsPath: string
}

function orcaState(work: string): Record<string, unknown> {
  return {
    repos: [
      { id: 'o1', path: join(work, 'app'), displayName: 'App', badgeColor: '#22c55e', addedAt: 1 },
      { id: 'o2', path: join(work, 'lib'), displayName: 'Lib', badgeColor: '#737373', addedAt: 1 }
    ],
    worktreeMeta: {
      [`o1::${join(work, 'app-feature')}`]: {
        displayName: 'Feature',
        comment: 'wip',
        isPinned: true
      },
      [`o2::${join(work, 'lib-fix')}`]: { displayName: 'Fix', comment: 'lib fix' }
    },
    settings: {
      terminalFontSize: 17,
      terminalCustomThemes: [
        {
          id: 'manual:dusk',
          name: 'Dusk',
          source: 'manual',
          mode: 'dark',
          terminal: { background: '#101010', foreground: '#e0e0e0', red: '#ff5555' },
          importedAt: '2026-10-01T00:00:00.000Z'
        }
      ],
      terminalThemeDark: 'custom:manual:dusk'
    }
  }
}

function setup(options: { running?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pod-orca-import-service-'))
  directories.push(root)
  const work = join(root, 'work')
  for (const name of ['app', 'app-feature', 'lib', 'lib-fix']) {
    mkdirSync(join(work, name, '.git'), { recursive: true })
  }
  const orca = join(root, 'orca')
  writeSyntheticOrcaProfile(orca, {
    state: orcaState(work),
    withDaemonFiles: true,
    ...(options.running ? { runningPid: RUNNING_PID } : {})
  })
  const podUserData = join(root, 'Pod')
  const defaults = getDefaultSettings(join(root, 'home'))
  const pod: FakePod = {
    repos: [],
    meta: {},
    settings: { ...defaults },
    keybindingsPath: join(root, 'home', '.pod', 'keybindings.json')
  }
  let next = 0
  const resolution: { value: OrcaImportResolution } = {
    value: {
      kind: 'source',
      location: { userData: orca, legacyHome: null, sharesPodHome: false, own: false }
    }
  }
  const service = new OrcaImportService({
    resolve: () => resolution.value,
    podUserData,
    getAllWorktreeMeta: () => pod.meta,
    defaultSettings: () => defaults,
    isProcessAlive: (pid) => pid === RUNNING_PID,
    now: () => new Date('2026-10-17T03:00:00.000Z'),
    ports: {
      getRepos: () => pod.repos,
      getSettings: () => pod.settings,
      addRepo: async (path, kind, _hostId, displayName) => {
        const existing = pod.repos.find((repo) => repo.path === path)
        if (existing) {
          return existing
        }
        const repo: Repo = {
          id: `p${++next}`,
          path,
          kind,
          displayName,
          badgeColor: '#737373',
          addedAt: 2
        }
        pod.repos.push(repo)
        return repo
      },
      updateRepo: async (selector, updates) => {
        const repo = pod.repos.find((candidate) => `id:${candidate.id}` === selector)
        if (!repo) {
          throw new Error('repo_not_found')
        }
        Object.assign(repo, updates)
        return repo
      },
      updateWorktreeMeta: async (selector, updates) => {
        const id = selector.slice('id:'.length)
        pod.meta[id] = { ...EMPTY_META, ...pod.meta[id], ...updates }
      },
      writeSettings: async (values) => {
        pod.settings = { ...pod.settings, ...values }
        return pod.settings
      },
      keybindings: { path: () => pod.keybindingsPath, reload: () => {} },
      platform: 'darwin'
    }
  })
  return { root, work, orca, podUserData, pod, service, resolution }
}

function ready(preview: PodOrcaImportPreview): Extract<PodOrcaImportPreview, { status: 'ready' }> {
  if (preview.status !== 'ready') {
    throw new Error(`preview ${preview.status}`)
  }
  return preview
}

describe('OrcaImportService', () => {
  it('previews, applies the picked items, and leaves Orca’s folder byte for byte', async () => {
    const { work, orca, podUserData, pod, service } = setup()
    const before = censusOf(orca)
    expect(service.detect()).toEqual({ found: true, orcaRunning: false, lastImportAt: null })

    const preview = ready(service.preview())
    const selected = preview.items.filter((item) => item.selected).map((item) => item.id)
    expect(selected).toEqual(
      expect.arrayContaining([
        `repo:${join(work, 'app')}`,
        `worktree:${join(work, 'app-feature')}`,
        'setting:terminalFontSize',
        'theme:manual:dusk'
      ])
    )
    const picked = selected.filter(
      (id) => id !== `repo:${join(work, 'lib')}` && id !== `worktree:${join(work, 'lib-fix')}`
    )
    const applied = await service.apply(preview.previewId, picked, true)

    expect(applied.status).toBe('applied')
    expect(
      pod.repos.map((repo) => [repo.path, repo.badgeColor, repo.importedExternalWorktreePaths])
    ).toEqual([[join(work, 'app'), '#22c55e', [join(work, 'app-feature')]]])
    expect(pod.meta[`p1::${join(work, 'app-feature')}`]).toMatchObject({
      displayName: 'Feature',
      comment: 'wip',
      isPinned: true
    })
    expect(pod.settings.terminalFontSize).toBe(17)
    expect(pod.settings.terminalThemeDark).toBe('custom:manual:dusk')
    expect(pod.settings.terminalCustomThemes?.map((theme) => theme.id)).toEqual(['manual:dusk'])
    expect(censusOf(orca)).toEqual(before)
    expect(
      JSON.parse(readFileSync(join(podUserData, ORCA_IMPORT_RECORD_FILE), 'utf8')).imports
    ).toHaveLength(1)

    // A second run offers only what the first left out.
    const again = ready(service.preview())
    expect(
      again.items
        .filter((item) => item.selected)
        .map((item) => item.id)
        .sort()
    ).toEqual([`repo:${join(work, 'lib')}`, `worktree:${join(work, 'lib-fix')}`].sort())
    expect(again.lastImportAt).toBe('2026-10-17T03:00:00.000Z')
    expect(censusOf(orca)).toEqual(before)
  })

  it('brings a picked worktree’s new project along', async () => {
    const { work, pod, service } = setup()
    const preview = ready(service.preview())
    const result = await service.apply(
      preview.previewId,
      [`worktree:${join(work, 'lib-fix')}`],
      true
    )
    expect(result.status).toBe('applied')
    expect(pod.repos.map((repo) => repo.path)).toEqual([join(work, 'lib')])
  })

  it('previews while Orca runs but applies only once it has quit', async () => {
    const { orca, service } = setup({ running: true })
    const before = censusOf(orca)
    const preview = ready(service.preview())
    expect(preview.source.orcaRunning).toBe(true)
    await expect(
      service.apply(
        preview.previewId,
        preview.items.map((item) => item.id),
        true
      )
    ).resolves.toEqual({
      status: 'orca-running',
      pid: RUNNING_PID
    })
    expect(censusOf(orca)).toEqual(before)
  })

  it('asks for a new preview when Orca’s profile changed or the preview is unknown', async () => {
    const { orca, service } = setup()
    const preview = ready(service.preview())
    const opened = openProfileStateDatabase(
      getOrcaProfileStateDatabaseFile('local-default', orca),
      'local-default'
    )
    importProfileStateJson(opened.db, JSON.stringify({ settings: { terminalFontSize: 20 } }))
    opened.db.close()
    await expect(
      service.apply(preview.previewId, ['setting:terminalFontSize'], true)
    ).resolves.toEqual({
      status: 'stale-preview'
    })
    await expect(service.apply('unknown', [], true)).resolves.toEqual({ status: 'stale-preview' })
  })

  it('applies in the user’s own Pod only from Pod’s window', async () => {
    const { orca, pod, service, resolution } = setup()
    resolution.value = {
      kind: 'source',
      location: { userData: orca, legacyHome: null, sharesPodHome: false, own: true }
    }
    const preview = ready(service.preview())
    const ids = preview.items.filter((item) => item.selected).map((item) => item.id)
    await expect(service.apply(preview.previewId, ids, false)).resolves.toEqual({
      status: 'refused',
      reason: 'apply-needs-pods-window'
    })
    expect(pod.repos).toEqual([])
    await expect(service.apply(preview.previewId, ids, true)).resolves.toMatchObject({
      status: 'applied'
    })
  })

  it('reads nothing when the location is refused', async () => {
    const { service, resolution } = setup()
    resolution.value = { kind: 'refused', reason: 'not-the-users-pod' }
    expect(service.detect()).toEqual({ found: false, refused: 'not-the-users-pod' })
    expect(service.preview()).toEqual({ status: 'refused', reason: 'not-the-users-pod' })
    await expect(service.apply('x', [], true)).resolves.toEqual({
      status: 'refused',
      reason: 'not-the-users-pod'
    })
  })

  it('imports Orca’s shortcuts into Pod’s own file once decouple separates them', async () => {
    const { root, pod, service, resolution, orca } = setup()
    const orcaHome = join(root, 'orca-home')
    mkdirSync(orcaHome, { recursive: true })
    writeFileSync(
      join(orcaHome, 'keybindings.json'),
      JSON.stringify({ version: 1, keybindings: { 'worktree.quickOpen': 'Mod+Shift+P' } })
    )
    resolution.value = {
      kind: 'source',
      location: { userData: orca, legacyHome: orcaHome, sharesPodHome: false, own: false }
    }
    const before = censusOf(orcaHome)

    const preview = ready(service.preview())
    const result = await service.apply(preview.previewId, ['keybinding:worktree.quickOpen'], true)

    expect(result).toMatchObject({
      status: 'applied',
      results: [{ id: 'keybinding:worktree.quickOpen', outcome: 'imported' }]
    })
    expect(readFileSync(pod.keybindingsPath, 'utf8')).toContain('Mod+Shift+P')
    expect(censusOf(orcaHome)).toEqual(before)
  })
})
