import { lstatSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { NativeOpenPath } from '../../../shared/native-process-info'
import { claudeProjectKey, createWorkspaceAdopt } from './workspace-adopt'
import { adoptWarnings } from './workspace-adopt-checks'
import { createWorkspaceGitExec } from './workspace-git-exec'
import { createWorkspaceJournal } from './workspace-journal'
import { createWorkspacePlanStore } from './workspace-plan-store'
import type { ProcessCwdReader } from './workspace-process-cwds'
import { createRealGitFixture, type RealGitFixture } from './workspace-real-git-test-fixture'

describe('workspace adopt plan checks (real git)', () => {
  let fx: RealGitFixture
  let repo: string
  let open: NativeOpenPath[]

  const processes: ProcessCwdReader = {
    listPids: () => [],
    readCwd: () => null,
    readNames: async (pids) => new Map(pids.map((pid) => [pid, `proc-${pid}`])),
    openPathsUnder: (folders) =>
      open.filter((hit) => folders.some((folder) => hit.path.startsWith(`${folder}/`)))
  }

  beforeEach(async () => {
    fx = await createRealGitFixture('pod-ws-checks-')
    ;({ repo } = await fx.cloneWithOrigin('app'))
    await fx.git(repo, 'remote', 'set-url', 'origin', 'git@github.com:acme/webapp.git')
    mkdirSync(join(fx.root, 'pod'))
    open = []
  })

  afterEach(() => fx.dispose())

  const adopt = () => {
    const row = fx.repoRecord(repo)
    return createWorkspaceAdopt({
      git: createWorkspaceGitExec(),
      journal: createWorkspaceJournal(join(fx.root, 'journal.json')),
      plans: createWorkspacePlanStore(),
      processes,
      getRepo: () => row,
      store: {
        getAllWorktreeMeta: () => ({}),
        migrateWorktreeIdentity: () => undefined,
        updateRepo: (_id, updates) => Object.assign(row, updates)
      },
      root: () => join(fx.root, 'pod'),
      home: fx.home,
      historyRoot: join(fx.root, 'terminal-history')
    })
  }

  it('lists files held open inside and moves only once the user ticked them', async () => {
    open = [
      { pid: 4242, path: join(repo, 'README.md') },
      { pid: 4243, path: join(fx.root, 'elsewhere.txt') }
    ]
    const service = adopt()
    const plan = await service.plan('repo-1')
    expect(plan.blockers).toEqual(['files-open'])
    expect(plan.openFiles).toEqual([
      { pid: 4242, name: 'proc-4242', path: join(repo, 'README.md') }
    ])
    await expect(service.apply(plan.planId)).rejects.toThrow(/files-open/)
    expect(lstatSync(repo).isDirectory()).toBe(true)
    // The same plan still applies: open files are checked afresh, not by fingerprint.
    open = [{ pid: 4244, path: join(repo, 'README.md') }]
    await service.apply(plan.planId, ['files-open'])
    expect(lstatSync(repo).isSymbolicLink()).toBe(true)
  })

  it('warns that a Compose project named after the folder gets a new name', async () => {
    writeFileSync(join(repo, 'compose.yaml'), 'services:\n  db:\n    image: postgres\n')
    const to = join(fx.root, 'pod', 'acme', 'webapp')
    expect(await adoptWarnings(repo, to, [])).toEqual([
      { kind: 'compose-project', file: 'compose.yaml', from: 'app', to: 'webapp' }
    ])
    writeFileSync(join(repo, '.env'), 'COMPOSE_PROJECT_NAME=app\n')
    expect(await adoptWarnings(repo, to, [])).toEqual([])
    // Same folder name: nothing to warn about.
    expect(await adoptWarnings(repo, join(fx.root, 'pod', 'acme', 'app'), [])).toEqual([])
  })

  it('warns that Claude Code asks for trust again where it has a project folder', async () => {
    const claude = join(fx.home, '.claude', 'projects', claudeProjectKey(repo))
    mkdirSync(claude, { recursive: true })
    const plan = await adopt().plan('repo-1')
    expect(plan.warnings).toEqual([{ kind: 'claude-trust', count: 1 }])
  })
})
