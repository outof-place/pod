import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createWorkspaceGitExec } from './workspace-git-exec'
import { createWorkspaceGitProfile } from './workspace-git-profile'
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

  const profile = () => createWorkspaceGitProfile({ git: createWorkspaceGitExec(), home: fx.home })

  it('applies, records and reverts exactly what it wrote', async () => {
    const service = profile()
    const before = await service.plan(repo)
    expect(before?.pending).toBeGreaterThan(0)
    expect(before?.trackedFiles).toBe(1)

    const written = await service.apply(repo)
    expect(written.map((row) => row.key)).toEqual(
      expect.arrayContaining(['core.untrackedCache', 'checkout.workers', 'maintenance.strategy'])
    )
    // A one-file repo gets neither the watcher nor index v4.
    expect(written.map((row) => row.key)).not.toContain('core.fsmonitor')
    expect((await fx.git(repo, 'config', '--local', 'checkout.workers')).trim()).toBe('0')
    expect(await fx.git(repo, 'config', '--global', '--get-all', 'maintenance.repo')).toContain(
      repo
    )

    const after = await service.plan(repo)
    expect(after?.pending).toBe(0)
    expect(after?.podRegisteredMaintenance).toBe(true)

    // A value the user edits afterwards survives the revert.
    await fx.git(repo, 'config', '--local', 'fetch.writeCommitGraph', 'false')
    const removed = await service.revert(repo, [repo])
    expect(removed).toEqual(expect.arrayContaining(['core.untrackedcache', 'maintenance.register']))
    expect((await fx.git(repo, 'config', '--local', 'fetch.writeCommitGraph')).trim()).toBe('false')
    await expect(fx.git(repo, 'config', '--local', 'checkout.workers')).rejects.toThrow()
    await expect(fx.git(repo, 'config', '--local', 'pod.workspaceConfig')).rejects.toThrow()
    await expect(fx.git(repo, 'config', '--local', 'maintenance.auto')).rejects.toThrow()
    expect(
      await fx.git(repo, 'config', '--global', '--get-all', 'maintenance.repo').catch(() => '')
    ).not.toContain(repo)
  })

  it('leaves keys the user set in global config alone', async () => {
    await fx.git(repo, 'config', '--global', 'checkout.workers', '4')
    const written = await profile().apply(repo)
    expect(written.map((row) => row.key)).not.toContain('checkout.workers')
    await expect(fx.git(repo, 'config', '--local', 'checkout.workers')).rejects.toThrow()
  })
})
