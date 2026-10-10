import { describe, expect, it } from 'vitest'
import {
  parseGitVersion,
  planPodGitProfile,
  type PodGitProfileCurrent,
  type PodGitProfileFacts
} from './pod-workspace-git-profile'

const LARGE: PodGitProfileFacts = {
  gitVersion: [2, 56, 0],
  trackedFiles: 35_108,
  packCount: 4_345,
  partialClone: true,
  fsmonitorSupported: true,
  geometricMaintenance: true
}

function byKey(rows: ReturnType<typeof planPodGitProfile>) {
  return Object.fromEntries(rows.map((row) => [row.key, `${row.action}:${row.reason}`]))
}

describe('planPodGitProfile', () => {
  it('sets every key on a large blobless clone that has none', () => {
    expect(byKey(planPodGitProfile(LARGE, {}))).toEqual({
      'core.untrackedCache': 'set:always',
      'core.fsmonitor': 'set:large-repo',
      'index.version': 'set:large-repo',
      'checkout.workers': 'set:always',
      'checkout.thresholdForParallelism': 'set:always',
      'fetch.writeCommitGraph': 'set:always',
      'maintenance.strategy': 'set:always',
      'maintenance.prefetch.enabled': 'set:always',
      'maintenance.geometric-repack.schedule': 'set:pack-churn'
    })
  })

  it('keeps small repos off the file watcher and index v4, and repacks them daily', () => {
    const rows = byKey(
      planPodGitProfile({ ...LARGE, trackedFiles: 400, packCount: 3, partialClone: false }, {})
    )
    expect(rows['core.fsmonitor']).toBe('skip:small-repo')
    expect(rows['index.version']).toBe('skip:small-repo')
    expect(rows['maintenance.geometric-repack.schedule']).toBe('skip:few-packs')
    expect(rows['core.untrackedCache']).toBe('set:always')
  })

  it('never overrides a value the user set, in any scope', () => {
    const current: PodGitProfileCurrent = {
      'core.fsmonitor': { local: 'false', other: false, recorded: null },
      'checkout.workers': { local: null, other: true, recorded: null },
      'core.untrackedcache': { local: 'true', other: false, recorded: null }
    }
    const rows = byKey(planPodGitProfile(LARGE, current))
    expect(rows['core.fsmonitor']).toBe('user:user-value')
    expect(rows['checkout.workers']).toBe('user:user-value')
    // The same value the profile wants is kept, but still counts as the user's.
    expect(rows['core.untrackedCache']).toBe('keep:user-value')
  })

  it('reports its own earlier writes as already set', () => {
    const current: PodGitProfileCurrent = {
      'core.untrackedcache': { local: 'true', other: false, recorded: 'true' }
    }
    expect(byKey(planPodGitProfile(LARGE, current))['core.untrackedCache']).toBe('keep:already-set')
  })

  it('degrades with an old git or a folder the watcher refuses', () => {
    const rows = byKey(
      planPodGitProfile(
        {
          ...LARGE,
          gitVersion: [2, 30, 1],
          fsmonitorSupported: false,
          geometricMaintenance: false
        },
        {}
      )
    )
    expect(rows['core.fsmonitor']).toBe('skip:fsmonitor-unsupported')
    expect(rows['checkout.workers']).toBe('skip:git-too-old')
    expect(rows['maintenance.strategy']).toBe('skip:no-geometric-maintenance')
  })
})

describe('parseGitVersion', () => {
  it('reads Apple and Homebrew builds', () => {
    expect(parseGitVersion('git version 2.54.0 (Apple Git-157)\n')).toEqual([2, 54, 0])
    expect(parseGitVersion('git version 2.56.0\n')).toEqual([2, 56, 0])
    expect(parseGitVersion('nonsense')).toBeNull()
  })
})
