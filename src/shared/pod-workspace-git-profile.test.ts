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
  geometricMaintenance: true
}

function byKey(rows: ReturnType<typeof planPodGitProfile>) {
  return Object.fromEntries(rows.map((row) => [row.key, `${row.action}:${row.reason}`]))
}

describe('planPodGitProfile', () => {
  it('sets the measured keys on a large blobless clone and offers the rest', () => {
    expect(byKey(planPodGitProfile(LARGE, {}))).toEqual({
      'checkout.thresholdForParallelism': 'set:measured',
      'maintenance.strategy': 'set:measured',
      'maintenance.prefetch.enabled': 'set:measured',
      'maintenance.geometric-repack.schedule': 'set:pack-churn',
      'feature.manyFiles': 'opt-in:many-files',
      'repack.writeBitmaps': 'opt-in:bitmaps'
    })
    expect(planPodGitProfile(LARGE, {}).every((row) => row.source === 'pod')).toBe(true)
  })

  it('repacks a full clone with few packs daily', () => {
    const rows = byKey(
      planPodGitProfile({ ...LARGE, trackedFiles: 400, packCount: 3, partialClone: false }, {})
    )
    expect(rows['maintenance.geometric-repack.schedule']).toBe('skip:few-packs')
    expect(rows['maintenance.strategy']).toBe('set:measured')
  })

  it('never overrides a value the user set, in any scope', () => {
    const current: PodGitProfileCurrent = {
      'checkout.thresholdforparallelism': { local: '100', other: false, recorded: null },
      'maintenance.strategy': { local: null, other: true, recorded: null },
      'feature.manyfiles': { local: 'false', other: false, recorded: null },
      'maintenance.prefetch.enabled': { local: 'false', other: false, recorded: null }
    }
    const rows = byKey(planPodGitProfile(LARGE, current))
    expect(rows['checkout.thresholdForParallelism']).toBe('user:user-value')
    expect(rows['maintenance.strategy']).toBe('user:user-value')
    expect(rows['feature.manyFiles']).toBe('user:user-value')
    // The same value the profile wants is kept, but still counts as the user's.
    expect(rows['maintenance.prefetch.enabled']).toBe('keep:user-value')
  })

  it('reports its own earlier writes as already set', () => {
    const current: PodGitProfileCurrent = {
      'maintenance.strategy': { local: 'geometric', other: false, recorded: 'geometric' },
      'repack.writebitmaps': { local: 'true', other: false, recorded: 'true' }
    }
    const rows = byKey(planPodGitProfile(LARGE, current))
    expect(rows['maintenance.strategy']).toBe('keep:already-set')
    expect(rows['repack.writeBitmaps']).toBe('keep:bitmaps')
  })

  it('degrades with an old git', () => {
    const rows = byKey(
      planPodGitProfile({ ...LARGE, gitVersion: [2, 30, 1], geometricMaintenance: false }, {})
    )
    expect(rows['checkout.thresholdForParallelism']).toBe('skip:git-too-old')
    expect(rows['maintenance.strategy']).toBe('skip:no-geometric-maintenance')
    expect(rows['maintenance.geometric-repack.schedule']).toBe('skip:no-geometric-maintenance')
  })
})

describe('parseGitVersion', () => {
  it('reads Apple and Homebrew builds', () => {
    expect(parseGitVersion('git version 2.54.0 (Apple Git-157)\n')).toEqual([2, 54, 0])
    expect(parseGitVersion('git version 2.56.0\n')).toEqual([2, 56, 0])
    expect(parseGitVersion('nonsense')).toBeNull()
  })
})
