import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { Repo } from '../../../shared/repo-types'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import { buildOrcaImportPlan, type OrcaImportPlanInput } from './orca-import-plan'
import type { OrcaImportFsProbe } from './orca-import-plan-repos'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

const defaults = getDefaultSettings('/home/test')

function repo(id: string, path: string, extra: Partial<Repo> = {}): Repo {
  return {
    id,
    path,
    displayName: path.split('/').at(-1) ?? id,
    badgeColor: '#737373',
    addedAt: 1,
    ...extra
  }
}

function meta(extra: Partial<WorktreeMeta>): WorktreeMeta {
  return {
    displayName: '',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...extra
  }
}

const onDisk = new Set(['/work/app', '/work/app-feature', '/work/lib', '/work/notes'])
const fs: OrcaImportFsProbe = {
  isDirectory: (path) => onDisk.has(path),
  isGitCheckout: (path) => path !== '/work/notes'
}

function plan(
  orca: Record<string, unknown>,
  pod: Partial<OrcaImportPlanInput['pod']> = {},
  keybindings: OrcaImportPlanInput['keybindings'] = null
) {
  return buildOrcaImportPlan({
    orca: new Map(Object.entries(orca)),
    pod: { repos: [], worktreeMeta: {}, settings: { ...defaults }, defaults, ...pod },
    keybindings,
    fs,
    platform: 'darwin'
  })
}

function states(result: ReturnType<typeof plan>): Record<string, string> {
  return Object.fromEntries(result.items.map((item) => [item.id, item.state]))
}

describe('buildOrcaImportPlan: projects and worktrees', () => {
  it('offers local projects on disk and their worktrees, and names what it skips', () => {
    const result = plan({
      repos: [
        repo('o1', '/work/app', {
          symlinkPaths: ['.env'],
          hookSettings: { mode: 'auto', scripts: { setup: 'make', archive: '' } }
        }),
        repo('o2', '/work/gone'),
        repo('o3', '/srv/remote', { connectionId: 'ssh-1' }),
        repo('o4', '/work/notes', { kind: 'folder' })
      ],
      worktreeMeta: {
        'o1::/work/app-feature': meta({ displayName: 'Feature', comment: 'wip', isPinned: true }),
        'o1::/work/app-deleted': meta({ displayName: 'Old' }),
        'o2::/work/gone-wt': meta({ displayName: 'x' })
      }
    })

    expect(states(result)).toEqual({
      'repo:/work/app': 'new',
      'repo:/work/gone': 'missing',
      'repo:/srv/remote': 'unsupported',
      'repo:/work/notes': 'new',
      'worktree:/work/app-feature': 'new',
      'worktree:/work/app-deleted': 'missing'
    })
    expect(result.actions.get('repo:/work/app')).toEqual({
      kind: 'repo',
      path: '/work/app',
      repoKind: 'git',
      displayName: 'app',
      fields: { badgeColor: '#737373', symlinkPaths: ['.env'] }
    })
    expect(result.actions.get('worktree:/work/app-feature')).toMatchObject({
      kind: 'worktree',
      repoItemId: 'repo:/work/app',
      isMain: false,
      fields: { displayName: 'Feature', comment: 'wip', isPinned: true }
    })
    expect(result.leftBehind).toContainEqual({ kind: 'hookSettings', count: 1 })
  })

  it('fills only what Pod leaves empty on a project Pod already has', () => {
    const result = plan(
      {
        repos: [repo('o1', '/work/app')],
        worktreeMeta: {
          'o1::/work/app-feature': meta({
            displayName: 'Orca name',
            comment: 'from orca',
            linkedPR: 12
          }),
          'o1::/work/app': meta({ comment: 'main notes' })
        }
      },
      {
        repos: [repo('p1', '/work/app', { importedExternalWorktreePaths: ['/work/app-feature'] })],
        worktreeMeta: { 'p1::/work/app-feature': meta({ displayName: 'Pod name' }) }
      }
    )

    expect(states(result)).toMatchObject({
      'repo:/work/app': 'present',
      'worktree:/work/app-feature': 'update',
      'worktree:/work/app': 'new'
    })
    expect(result.actions.get('worktree:/work/app-feature')).toMatchObject({
      fields: { comment: 'from orca', linkedPR: 12 }
    })
    expect(result.actions.get('worktree:/work/app')).toMatchObject({
      isMain: true,
      fields: { comment: 'main notes' }
    })
  })

  it('has nothing to do on a second run over what the first imported', () => {
    const result = plan(
      {
        repos: [repo('o1', '/work/app')],
        worktreeMeta: { 'o1::/work/app-feature': meta({ comment: 'wip' }) }
      },
      {
        repos: [repo('p1', '/work/app', { importedExternalWorktreePaths: ['/work/app-feature'] })],
        worktreeMeta: { 'p1::/work/app-feature': meta({ comment: 'wip' }) }
      }
    )
    expect(result.actions.size).toBe(0)
    expect(states(result)).toEqual({
      'repo:/work/app': 'present',
      'worktree:/work/app-feature': 'present'
    })
  })
})

describe('buildOrcaImportPlan: settings, themes, quick commands', () => {
  const theme = {
    id: 'manual:dusk',
    name: 'Dusk',
    source: 'manual',
    mode: 'dark',
    terminal: { background: '#101010', foreground: '#e0e0e0', red: '#ff5555' },
    importedAt: '2026-10-01T00:00:00.000Z'
  }

  it('offers settings the user changed in Orca, never stock or unlisted ones', () => {
    const settings: Partial<GlobalSettings> = {
      ...defaults,
      appFontFamily: 'system-ui',
      terminalFontSize: 17,
      terminalCursorBlink: true,
      workspaceDir: '/Users/x/orca/workspaces',
      theme: 'light'
    }
    const result = plan({ settings }, { settings: { ...defaults, theme: 'dark' } })
    expect(states(result)).toEqual({
      'setting:terminalFontSize': 'new',
      'setting:theme': 'conflict'
    })
    expect(result.items.find((item) => item.id === 'setting:theme')).toMatchObject({
      selected: false,
      orcaValue: 'light',
      podValue: 'dark'
    })
  })

  it('merges custom themes and quick commands by id, mapping project scopes', () => {
    const result = plan(
      {
        repos: [repo('o1', '/work/app')],
        settings: {
          terminalCustomThemes: [theme],
          terminalQuickCommands: [
            { id: 'q1', label: 'Test', command: 'pnpm test', appendEnter: true },
            {
              id: 'q2',
              label: 'Deploy',
              command: 'make',
              appendEnter: true,
              scope: { type: 'repo', repoId: 'o1' }
            },
            {
              id: 'q3',
              label: 'Orphan',
              command: 'x',
              appendEnter: true,
              scope: { type: 'repo', repoId: 'nope' }
            }
          ]
        }
      },
      {
        settings: {
          ...defaults,
          terminalQuickCommands: [
            { id: 'q1', label: 'Test', command: 'pnpm test', appendEnter: true }
          ]
        }
      }
    )
    expect(states(result)).toMatchObject({
      'theme:manual:dusk': 'new',
      'quickCommand:q1': 'present',
      'quickCommand:q2': 'new',
      'quickCommand:q3': 'unsupported'
    })
    expect(result.items.find((item) => item.id === 'quickCommand:q2')).toMatchObject({
      parentId: 'repo:/work/app'
    })
  })
})

describe('buildOrcaImportPlan: keybindings', () => {
  it('shows one shared row while Pod reads Orca’s own file', () => {
    const result = plan(
      {},
      {},
      { orcaPath: '/same/keybindings.json', podPath: '/same/keybindings.json' }
    )
    expect(states(result)).toEqual({ 'keybindings:shared': 'shared' })
    expect(result.actions.size).toBe(0)
  })

  it('offers Orca’s overrides Pod has not set', () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-orca-import-keys-'))
    directories.push(root)
    const orcaPath = join(root, 'orca.json')
    const podPath = join(root, 'pod.json')
    writeFileSync(
      orcaPath,
      JSON.stringify({
        version: 1,
        keybindings: { 'worktree.quickOpen': 'Mod+Shift+P', 'terminal.search': 'Mod+F' }
      })
    )
    writeFileSync(
      podPath,
      JSON.stringify({ version: 1, keybindings: { 'terminal.search': 'Mod+F' } })
    )

    const result = plan({}, {}, { orcaPath, podPath })

    expect(states(result)).toEqual({
      'keybinding:worktree.quickOpen': 'new',
      'keybinding:terminal.search': 'present'
    })
  })
})
