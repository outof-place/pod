// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { PodWorkspaceStatus } from '../../../../shared/pod-workspace-types'
import { PodWorkspaceHealth } from './PodWorkspaceHealth'
import { PodWorkspaceRepoList } from './PodWorkspaceRepoList'

function status(overrides: Partial<PodWorkspaceStatus> = {}): PodWorkspaceStatus {
  return {
    root: '/Users/me/pod',
    rootAliases: ['/Users/me/pod'],
    rootExists: true,
    validation: { root: '/Users/me/pod', issues: [] },
    volume: {
      pnpmStoreDir: '/Users/me/Library/pnpm/store',
      sameVolumeAsPnpmStore: true,
      caseSensitive: false,
      freeBytes: 500 * 1024 ** 3,
      totalBytes: 1024 ** 4
    },
    spotlight: { state: 'indexed', reason: null, checkedAt: 0 },
    timeMachine: {
      destination: 'none',
      excluded: ['/Users/me/pod/acme/widget/.next'],
      missing: ['/Users/me/pod/acme/widget/node_modules']
    },
    indexConnected: false,
    repos: [
      {
        repoId: 'r1',
        path: '/Users/me/pod/acme/widget',
        displayName: 'widget',
        branch: 'main',
        worktreeCount: 2,
        gitTuning: {
          untrackedCache: 'true',
          fsmonitor: null,
          indexVersion: '4',
          checkoutWorkers: null,
          orcaPerformanceConfig: '1'
        },
        index: null
      }
    ],
    outsideRepos: [{ repoId: 'r2', path: '/Users/me/src/legacy', displayName: 'legacy' }],
    migrationScript: { path: '/Users/me/.local/share/pod-migrate/migrate.sh', exists: true },
    generatedAt: 0,
    ...overrides
  }
}

afterEach(() => {
  cleanup()
})

describe('PodWorkspaceHealth', () => {
  it('shows the checks, Spotlight guidance and the exclude action', async () => {
    const onExclude = vi.fn()
    const onOpenSpotlightSettings = vi.fn()
    render(
      <PodWorkspaceHealth
        status={status()}
        excluding={false}
        onExclude={onExclude}
        onOpenSpotlightSettings={onOpenSpotlightSettings}
      />
    )
    expect(screen.getByText('Same volume')).toBeInTheDocument()
    expect(screen.getByText('Case-insensitive')).toBeInTheDocument()
    expect(screen.getByText(/Search Privacy/)).toBeInTheDocument()
    expect(
      screen.getByText(
        'Backups are not configured. Exclusions still apply once you add a backup disk.'
      )
    ).toBeInTheDocument()
    expect(screen.getByText('1 of 2 build folders excluded')).toBeInTheDocument()
    expect(screen.getByText('acme/widget/node_modules')).toBeInTheDocument()
    expect(screen.getByText('Not connected')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Exclude build folders' }))
    await userEvent.click(screen.getByRole('button', { name: 'Open Spotlight Settings' }))
    expect(onExclude).toHaveBeenCalledTimes(1)
    expect(onOpenSpotlightSettings).toHaveBeenCalledTimes(1)
  })

  it('hides the Spotlight button and the exclude action when nothing needs them', () => {
    render(
      <PodWorkspaceHealth
        status={status({
          spotlight: { state: 'excluded', reason: null, checkedAt: 0 },
          timeMachine: { destination: 'configured', excluded: ['/x/node_modules'], missing: [] }
        })}
        excluding={false}
        onExclude={vi.fn()}
        onOpenSpotlightSettings={vi.fn()}
      />
    )
    expect(screen.queryByRole('button', { name: 'Open Spotlight Settings' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Exclude build folders' })).toBeNull()
    expect(screen.getByText('Backups are configured.')).toBeInTheDocument()
  })
})

describe('PodWorkspaceRepoList', () => {
  it('lists repos under the root with tuning, and the ones outside it', () => {
    render(<PodWorkspaceRepoList status={status()} />)
    expect(screen.getAllByTestId('pod-workspace-repo-row')).toHaveLength(1)
    expect(screen.getByText('acme/widget')).toBeInTheDocument()
    expect(screen.getByText('core.untrackedCache=true')).toBeInTheDocument()
    expect(screen.getByText('index.version=4')).toBeInTheDocument()
    expect(screen.getByText('Applied by Orca')).toBeInTheDocument()
    expect(screen.getByText('Worktrees: 2')).toBeInTheDocument()
    expect(screen.getByTestId('pod-workspace-outside-list')).toHaveTextContent(
      '/Users/me/src/legacy'
    )
    expect(screen.getByText(/pod-migrate\/migrate\.sh/)).toBeInTheDocument()
  })
})
