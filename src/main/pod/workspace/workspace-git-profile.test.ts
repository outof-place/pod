import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PodWorkspaceGitProfile } from '../../../shared/pod-workspace-tidy-types'
import { createWorkspaceGitExec } from './workspace-git-exec'
import { createWorkspaceGitProfile } from './workspace-git-profile'
import { createWorkspaceJournal } from './workspace-journal'
import { createWorkspacePlanStore } from './workspace-plan-store'
import { createRealGitFixture, type RealGitFixture } from './workspace-real-git-test-fixture'

describe('workspace git profile (real git)', () => {
  let fx: RealGitFixture
  let repo: string

  beforeEach(async () => {
    fx = await createRealGitFixture('pod-ws-profile-')
    ;({ repo } = await fx.cloneWithOrigin('app'))
    // Present agents mean Pod never writes or loads launchd jobs from a test.
    const agents = join(fx.home, 'Library', 'LaunchAgents')
    mkdirSync(agents, { recursive: true })
    for (const schedule of ['hourly', 'daily', 'weekly']) {
      writeFileSync(join(agents, `org.git-scm.git.${schedule}.plist`), '')
    }
  })

  afterEach(() => fx.dispose())

  const profile = () =>
    createWorkspaceGitProfile({
      git: createWorkspaceGitExec(),
      home: fx.home,
      journal: createWorkspaceJournal(join(fx.root, 'journal.json')),
      plans: createWorkspacePlanStore(),
      getRepo: (id) => (id === 'repo-1' ? fx.repoRecord(repo) : undefined)
    })

  const actions = (plan: PodWorkspaceGitProfile) =>
    Object.fromEntries(plan.rows.map((row) => [row.key, `${row.source}:${row.action}`]))
  const local = (key: string) => fx.git(repo, 'config', '--local', key).then((out) => out.trim())

  it("layers Pod's keys on Orca's, applies by plan id and undoes exactly what it wrote", async () => {
    const service = profile()
    const before = await service.plan('repo-1')
    expect(before.trackedFiles).toBe(1)
    expect(actions(before)).toMatchObject({
      'checkout.workers': 'orca:set',
      'fetch.writeCommitGraph': 'orca:set',
      // A one-file repo gets neither the watcher nor index v4.
      'core.fsmonitor': 'orca:skip',
      'index.version': 'orca:skip',
      'checkout.thresholdForParallelism': 'pod:set',
      'maintenance.strategy': 'pod:set',
      'feature.manyFiles': 'pod:opt-in'
    })
    expect(Object.fromEntries(before.optIns.map((optIn) => [optIn.id, optIn.available]))).toEqual({
      reftable: true,
      'many-files': true,
      bitmaps: true,
      backfill: false
    })

    const applied = await service.apply(before.planId)
    expect(applied.tune?.orcaKeys).toEqual(
      expect.arrayContaining(['checkout.workers', 'fetch.writeCommitGraph'])
    )
    expect(applied.tune?.podKeys).toContain('maintenance.strategy')
    expect(applied.tune?.registeredMaintenance).toBe(true)
    expect(await local('checkout.workers')).toBe('0')
    expect(await local('checkout.thresholdForParallelism')).toBe('4000')
    expect(await fx.git(repo, 'config', '--global', '--get-all', 'maintenance.repo')).toContain(
      repo
    )
    // One apply per plan.
    await expect(service.apply(before.planId)).rejects.toThrow(/expired/)

    const after = await service.plan('repo-1')
    expect(after.pending).toBe(0)
    expect(after.maintenanceRegistered).toBe(true)
    expect(after.tunes.map((tune) => tune.id)).toEqual([applied.tune?.id])

    // A value the user edits afterwards survives the undo.
    await fx.git(repo, 'config', '--local', 'fetch.writeCommitGraph', 'false')
    const undone = await service.undo(after.planId, applied.tune?.id ?? '')
    expect(undone.removed).toEqual(
      expect.arrayContaining(['checkout.workers', 'maintenance.strategy', 'maintenance'])
    )
    expect(await local('fetch.writeCommitGraph')).toBe('false')
    await expect(local('checkout.workers')).rejects.toThrow()
    await expect(local('checkout.thresholdForParallelism')).rejects.toThrow()
    await expect(local('pod.workspaceConfig')).rejects.toThrow()
    await expect(local('maintenance.auto')).rejects.toThrow()
    expect(
      await fx.git(repo, 'config', '--global', '--get-all', 'maintenance.repo').catch(() => '')
    ).not.toContain(repo)
    expect((await service.plan('repo-1')).tunes).toEqual([])
  })

  it('leaves keys the user set in global config alone', async () => {
    await fx.git(repo, 'config', '--global', 'checkout.workers', '4')
    const service = profile()
    const plan = await service.plan('repo-1')
    expect(actions(plan)['checkout.workers']).toBe('orca:user')
    const applied = await service.apply(plan.planId)
    expect(applied.tune?.orcaKeys).not.toContain('checkout.workers')
    await expect(local('checkout.workers')).rejects.toThrow()
  })

  it('refuses a plan the repository moved past', async () => {
    const service = profile()
    const plan = await service.plan('repo-1')
    await fx.git(repo, 'config', '--local', 'checkout.thresholdForParallelism', '100')
    await expect(service.apply(plan.planId)).rejects.toThrow(/changed since you looked/)
    expect(await local('checkout.thresholdForParallelism')).toBe('100')
  })

  it('converts refs to reftable only when ticked, and back on undo', async () => {
    const service = profile()
    const applied = await service.apply((await service.plan('repo-1')).planId, ['reftable'])
    expect(applied.tune?.optIns).toEqual(['reftable'])
    expect((await fx.git(repo, 'rev-parse', '--show-ref-format')).trim()).toBe('reftable')
    await service.undo((await service.plan('repo-1')).planId, applied.tune?.id ?? '')
    expect((await fx.git(repo, 'rev-parse', '--show-ref-format')).trim()).toBe('files')
  })

  it('offers no reftable conversion while linked worktrees exist', async () => {
    await fx.git(repo, 'worktree', 'add', '-q', '-b', 'side', join(fx.root, 'side'))
    const service = profile()
    const plan = await service.plan('repo-1')
    expect(plan.optIns.find((optIn) => optIn.id === 'reftable')?.available).toBe(false)
    await expect(service.apply(plan.planId, ['reftable'])).rejects.toThrow(/linked worktrees/)
    expect((await fx.git(repo, 'rev-parse', '--show-ref-format')).trim()).toBe('files')
  })
  it('offers a backfill in a blobless clone, sized by its missing blobs, without fetching them', async () => {
    const { origin } = await fx.cloneWithOrigin('wide')
    const seed = join(fx.root, 'wide-seed')
    for (const name of ['a', 'b', 'c']) {
      await fx.commit(seed, `${name}.txt`, `blob ${name}`)
    }
    await fx.git(seed, 'push', '-q', origin, 'HEAD:main')
    await fx.git(origin, 'config', 'uploadpack.allowFilter', 'true')
    const blobless = join(fx.root, 'blobless')
    await fx.git(
      fx.root,
      'clone',
      '-q',
      '--filter=blob:none',
      '--no-checkout',
      `file://${origin}`,
      blobless
    )
    repo = blobless
    const service = profile()
    const backfill = async () =>
      (await service.plan('repo-1')).optIns.find((optIn) => optIn.id === 'backfill')
    expect((await backfill())?.note).toMatch(/Counting/)
    await vi.waitFor(async () => expect((await backfill())?.estimate).toBeDefined())
    // Four blobs in history (README and three files), none of them downloaded.
    expect((await backfill())?.estimate?.missingBlobs).toBe(4)
    expect(
      await fx
        .git(blobless, 'rev-list', '--objects', '--missing=print', 'HEAD')
        .then((out) => out.split('\n').filter((line) => line.startsWith('?')).length)
    ).toBe(4)
  })
})
