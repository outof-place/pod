import '../unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest, RpcResponse } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { Repo } from '../../../../shared/repo-types'
import {
  setPodSshRemoteBrowse,
  type PodSshRemoteBrowse,
  type SshRemoteDirListing
} from '../../../pod/ssh/pod-ssh-remote-browse'
import { POD_RUNTIME_CAPABILITIES } from '../../../../shared/pod-runtime-capabilities'
import { POD_SSH_REMOTE_PROJECT_METHODS } from './pod-ssh-remote-projects'

const remoteRepo: Repo = {
  id: 'repo-1',
  path: '/home/me/src/app',
  displayName: 'app',
  badgeColor: '#000000',
  addedAt: 1,
  kind: 'git',
  connectionId: 'ssh-1',
  executionHostId: 'ssh:ssh-1',
  externalWorktreeVisibilityLegacy: false,
  projectHostSetupMethod: 'imported-existing-folder'
}

const addSshRepo = vi.fn<OrcaRuntimeService['addSshRepo']>(async () => remoteRepo)
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these handlers read only the runtime id and addSshRepo.
const runtime = {
  getRuntimeId: () => 'test-runtime',
  addSshRepo
} as unknown as OrcaRuntimeService

const listing: SshRemoteDirListing = {
  entries: [
    { name: 'src', isDirectory: true },
    { name: '.profile', isDirectory: false }
  ],
  resolvedPath: '/home/me',
  pathFlavor: 'posix'
}

function installBrowse(browse?: PodSshRemoteBrowse) {
  const fn = vi.fn<PodSshRemoteBrowse>(browse ?? (async () => listing))
  setPodSshRemoteBrowse(fn)
  return fn
}

function dispatch(
  method: string,
  params?: unknown,
  options?: { pairedDeviceId?: string }
): Promise<RpcResponse> {
  const request: RpcRequest = { id: 'req-1', authToken: 'tok', method, params }
  return new RpcDispatcher({ runtime, methods: POD_SSH_REMOTE_PROJECT_METHODS }).dispatch(
    request,
    options
  )
}

afterEach(() => {
  setPodSshRemoteBrowse(null)
  vi.clearAllMocks()
})

describe('Pod SSH remote project RPC methods', () => {
  it('is advertised, so a client offers a remote folder only where it works', () => {
    expect(POD_RUNTIME_CAPABILITIES).toContain('pod.ssh.remote-projects.v1')
  })

  it('declares host-admin on every method', () => {
    expect(
      POD_SSH_REMOTE_PROJECT_METHODS.map((method) => [method.name, method.permission])
    ).toEqual([
      ['ssh.browseDir', 'host-admin'],
      ['repo.addRemote', 'host-admin']
    ])
  })

  it("lists a folder on the host through the desktop's browser", async () => {
    const browse = installBrowse()

    const response = await dispatch('ssh.browseDir', { targetId: 'ssh-1', dirPath: '~' })

    expect(browse).toHaveBeenCalledWith('ssh-1', '~')
    expect(response).toMatchObject({ ok: true, result: listing })
  })

  it('surfaces a failed listing with its reason', async () => {
    installBrowse(async () => {
      throw new Error('cd: /nope: No such file or directory')
    })

    await expect(
      dispatch('ssh.browseDir', { targetId: 'ssh-1', dirPath: '/nope' })
    ).resolves.toMatchObject({
      ok: false,
      error: { message: 'cd: /nope: No such file or directory' }
    })
  })

  it('answers runtime_unavailable on a host whose SSH layer never registered', async () => {
    await expect(
      dispatch('ssh.browseDir', { targetId: 'ssh-1', dirPath: '~' })
    ).resolves.toMatchObject({ ok: false, error: { message: 'runtime_unavailable' } })
  })

  it.each([
    ['ssh.browseDir', { targetId: '', dirPath: '~' }],
    ['ssh.browseDir', { targetId: 'ssh-1', dirPath: '' }],
    ['ssh.browseDir', { targetId: 'ssh-1', dirPath: '~', extra: 1 }],
    ['repo.addRemote', { targetId: 'ssh-1' }],
    ['repo.addRemote', { targetId: 'ssh-1', remotePath: '~/app', kind: 'svn' }]
  ])('refuses malformed %s params %j', async (method, params) => {
    const browse = installBrowse()

    const response = await dispatch(method, params)

    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(browse).not.toHaveBeenCalled()
    expect(addSshRepo).not.toHaveBeenCalled()
  })

  it('registers the folder as the desktop does, git unless asked for a folder', async () => {
    await expect(
      dispatch('repo.addRemote', { targetId: 'ssh-1', remotePath: '~/src/app' })
    ).resolves.toMatchObject({
      ok: true,
      result: { repo: { id: 'repo-1', connectionId: 'ssh-1' } }
    })
    await dispatch('repo.addRemote', {
      targetId: 'ssh-1',
      remotePath: '~/notes',
      displayName: ' Notes ',
      kind: 'folder'
    })

    expect(addSshRepo.mock.calls).toEqual([
      [{ connectionId: 'ssh-1', remotePath: '~/src/app', kind: 'git' }],
      [{ connectionId: 'ssh-1', remotePath: '~/notes', displayName: 'Notes', kind: 'folder' }]
    ])
  })

  it('surfaces a refused registration with its reason', async () => {
    addSshRepo.mockRejectedValueOnce(new Error('Not a valid git repository: ~/notes'))

    await expect(
      dispatch('repo.addRemote', { targetId: 'ssh-1', remotePath: '~/notes' })
    ).resolves.toMatchObject({
      ok: false,
      error: { message: 'Not a valid git repository: ~/notes' }
    })
  })

  it("keeps the host's folders away from paired devices and SSH hosts' CLIs", async () => {
    const browse = installBrowse()
    const bridge = new RpcDispatcher({
      runtime,
      methods: POD_SSH_REMOTE_PROJECT_METHODS,
      callerScope: { kind: 'ssh-bridge', targetId: 'ssh-1', remoteCliControl: true }
    })
    const calls: [string, unknown][] = [
      ['ssh.browseDir', { targetId: 'ssh-1', dirPath: '~' }],
      ['repo.addRemote', { targetId: 'ssh-1', remotePath: '~/src/app' }]
    ]
    for (const [method, params] of calls) {
      const paired = await dispatch(method, params, { pairedDeviceId: 'phone-1' })
      expect(paired, method).toMatchObject({ ok: false, error: { code: 'forbidden' } })
      const remote = await bridge.dispatch({ id: 'req-1', authToken: 'tok', method, params })
      expect(remote, method).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    }
    expect(browse).not.toHaveBeenCalled()
    expect(addSshRepo).not.toHaveBeenCalled()
  })
})
