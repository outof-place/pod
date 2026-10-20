import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../../persistence'
import {
  getPodSshNestedRepos,
  importPodSshNestedRepos,
  scanPodSshNestedRepos,
  setPodSshNestedRepos
} from './pod-ssh-nested-repos'
import { installPodSshNestedRepos } from './install-pod-ssh-nested-repos'
import { scanNestedRepos } from '../../project-groups/nested-repo-discovery'
import { getRepoExecutionHostId } from '../../../shared/execution-host'
import type * as gitRepoModule from '../../git/repo'
import type * as fsPromisesModule from 'node:fs/promises'

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  listTargets: vi.fn(),
  readDir: vi.fn(),
  readFile: vi.fn(),
  stat: vi.fn(),
  isGitRepoAsync: vi.fn(),
  listWorktrees: vi.fn(),
  notify: vi.fn(),
  localReaddir: vi.fn(),
  localStat: vi.fn(),
  localReadFile: vi.fn(),
  localMkdir: vi.fn()
}))

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }))
vi.mock('../../ssh/ssh-target-registry', () => ({
  getSshConnectionManager: () => ({ getState: mocks.getState }),
  listRegisteredSshTargets: mocks.listTargets
}))
vi.mock('../../providers/ssh-filesystem-dispatch', () => ({
  getSshFilesystemProvider: () => ({
    readDir: mocks.readDir,
    readFile: mocks.readFile,
    stat: mocks.stat
  })
}))
vi.mock('../../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: () => ({
    isGitRepoAsync: mocks.isGitRepoAsync,
    listWorktrees: mocks.listWorktrees
  })
}))
vi.mock('../../ipc/ssh', () => ({
  getActiveMultiplexer: () => ({ notify: mocks.notify, request: vi.fn() })
}))
vi.mock('../../repo-icon-autodetect', () => ({ detectRepoIconAndUpstream: async () => ({}) }))
vi.mock('../../git/repo', async (importOriginal) => ({
  ...(await importOriginal<typeof gitRepoModule>()),
  isGitRepo: () => false
}))
vi.mock('../../ipc/registered-worktree-roots-cache', () => ({
  invalidateAuthorizedRootsCache: vi.fn()
}))
vi.mock('../../ipc/repos/repo-added-telemetry', () => ({ emitRepoAdded: vi.fn() }))
// Why: an SSH scan or import must never read this Mac's disk; any local call fails the test.
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof fsPromisesModule>()
  return {
    ...original,
    default: original,
    readdir: mocks.localReaddir,
    stat: mocks.localStat,
    readFile: mocks.localReadFile,
    mkdir: mocks.localMkdir
  }
})

const repos: { id: string; path: string; connectionId?: string }[] = []
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the import reads only these store members.
const store = {
  getRepos: () => repos,
  addRepo: vi.fn((repo: { id: string; path: string; connectionId?: string }) => repos.push(repo)),
  createProjectGroup: vi.fn((input: { name: string }) => ({ id: 'group-1', name: input.name })),
  moveProjectToGroup: vi.fn(),
  deleteProjectGroup: vi.fn(),
  getSettings: () => ({}),
  getProjects: () => []
} as unknown as Store

function dir(name: string) {
  return { name, isDirectory: true, isSymlink: false }
}

beforeEach(() => {
  repos.length = 0
  mocks.listTargets.mockReturnValue([{ id: 'ssh-1', label: 'box' }])
  mocks.getState.mockReturnValue({ status: 'connected' })
  mocks.readDir.mockImplementation(async (path: string) =>
    path === '/home/me/nest'
      ? [dir('api'), dir('web'), { name: 'notes.md', isDirectory: false, isSymlink: false }]
      : []
  )
  mocks.readFile.mockRejectedValue(new Error('no file'))
  mocks.stat.mockImplementation(async (path: string) => {
    if (path === '/home/me/nest/api/.git' || path === '/home/me/nest/web/.git') {
      return { type: 'directory' }
    }
    throw new Error('missing')
  })
  mocks.isGitRepoAsync.mockImplementation(async (path: string) => ({
    isRepo: path !== '/home/me/nest'
  }))
  mocks.listWorktrees.mockResolvedValue([])
  installPodSshNestedRepos(store)
})

afterEach(() => {
  setPodSshNestedRepos(null)
  vi.clearAllMocks()
})

function expectNoLocalRead(): void {
  expect(mocks.localReaddir).not.toHaveBeenCalled()
  expect(mocks.localStat).not.toHaveBeenCalled()
  expect(mocks.localReadFile).not.toHaveBeenCalled()
  expect(mocks.localMkdir).not.toHaveBeenCalled()
}

describe('installPodSshNestedRepos', () => {
  it("scans the host's folder through its SSH filesystem only", async () => {
    const scan = await scanPodSshNestedRepos('ssh-1', '/home/me/nest')

    expect(scan.selectedPathKind).toBe('non_git_folder')
    expect(scan.repos.map((repo) => repo.path)).toEqual(['/home/me/nest/api', '/home/me/nest/web'])
    expect(mocks.getState).toHaveBeenCalledWith('ssh-1')
    expect(mocks.readDir).toHaveBeenCalledWith('/home/me/nest')
    expectNoLocalRead()
  })

  it('imports the chosen repositories as projects on that host', async () => {
    const result = await importPodSshNestedRepos({
      connectionId: 'ssh-1',
      parentPath: '/home/me/nest',
      groupName: 'nest',
      projectPaths: ['/home/me/nest/api'],
      mode: 'group'
    })

    expect(result.importedCount).toBe(1)
    expect(result.group?.id).toBe('group-1')
    expect(repos).toMatchObject([{ path: '/home/me/nest/api', connectionId: 'ssh-1' }])
    // The host's partition, never this Mac's.
    expect(getRepoExecutionHostId(repos[0] ?? {})).toBe('ssh:ssh-1')
    expect(mocks.notify).toHaveBeenCalledWith('session.registerRoot', {
      rootPath: '/home/me/nest/api'
    })
    expectNoLocalRead()
  })

  it('refuses a host that is not connected, or not configured, before reading anything', async () => {
    mocks.getState.mockReturnValue({ status: 'reconnecting' })
    await expect(scanPodSshNestedRepos('ssh-1', '/home/me/nest')).rejects.toMatchObject({
      code: 'ssh_not_connected'
    })
    await expect(
      importPodSshNestedRepos({
        connectionId: 'ssh-1',
        parentPath: '/home/me/nest',
        groupName: '',
        projectPaths: ['/home/me/nest/api'],
        mode: 'separate'
      })
    ).rejects.toMatchObject({ code: 'ssh_not_connected' })
    mocks.getState.mockReturnValue({ status: 'connected' })
    await expect(scanPodSshNestedRepos('ssh-9', '/home/me/nest')).rejects.toThrow(
      'selector_not_found'
    )

    expect(mocks.readDir).not.toHaveBeenCalled()
    expect(mocks.stat).not.toHaveBeenCalled()
    expect(mocks.isGitRepoAsync).not.toHaveBeenCalled()
    expect(store.addRepo).not.toHaveBeenCalled()
    expectNoLocalRead()
  })

  it('refuses a path that is not POSIX absolute, or climbs, before asking the host', async () => {
    for (const path of ['~/nest', 'nest', '/home/me/../root', '/home/me/nest\0x', 'C:/Users/me']) {
      await expect(scanPodSshNestedRepos('ssh-1', path)).rejects.toThrow(
        'Project path must be an absolute path on the SSH host'
      )
    }
    await expect(
      importPodSshNestedRepos({
        connectionId: 'ssh-1',
        parentPath: '/home/me/nest',
        groupName: '',
        projectPaths: ['/home/me/nest/../../etc'],
        mode: 'separate'
      })
    ).rejects.toThrow('Project path must be an absolute path on the SSH host')

    expect(mocks.getState).not.toHaveBeenCalled()
    expect(mocks.readDir).not.toHaveBeenCalled()
  })

  it("the local-disk spies see a local scan (so their silence above isn't a missed mock)", async () => {
    mocks.localReaddir.mockResolvedValue([])
    mocks.localStat.mockRejectedValue(new Error('missing'))
    mocks.localReadFile.mockRejectedValue(new Error('missing'))
    await scanNestedRepos({ path: '/Users/me/nest' })
    expect(mocks.localReaddir).toHaveBeenCalledWith('/Users/me/nest', { withFileTypes: true })
  })

  it('answers runtime_unavailable where the SSH layer never registered', async () => {
    setPodSshNestedRepos(null)
    expect(getPodSshNestedRepos()).toBeNull()
    await expect(scanPodSshNestedRepos('ssh-1', '/home/me/nest')).rejects.toThrow(
      'runtime_unavailable'
    )
  })
})
