import '../unused-default-rpc-methods.test-fixture'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcAnyMethodDeclaration, RpcResponse } from '../core'
import type { RpcCallerScope } from '../rpc-caller-scope'
import { OWNER_RPC_CALLER_SCOPE } from '../rpc-caller-scope'
import { DESKTOP_RPC_CALLER, LOCAL_CLI_RPC_CALLER } from '../rpc-caller-identity'
import type { RpcDispatchStreamingOptions } from '../dispatcher-stream-options'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { MOBILE_RPC_METHOD_ALLOWLIST } from '../../runtime-rpc/runtime-rpc-mobile-method-allowlist'
import { POD_RUNTIME_CAPABILITIES } from '../../../../shared/pod-runtime-capabilities'
import type {
  NestedRepoScanResult,
  ProjectGroupImportResult
} from '../../../../shared/project-group-types'
import { POD_SSH_NESTED_REPO_METHODS } from './pod-ssh-nested-repos'
import { REPO_METHODS } from './repo'

const scan: NestedRepoScanResult = {
  selectedPath: '/home/me/nest',
  selectedPathKind: 'non_git_folder',
  repos: [{ path: '/home/me/nest/api', displayName: 'api', depth: 1 }],
  truncated: false,
  timedOut: false,
  stopped: false,
  durationMs: 3,
  maxDepth: 5,
  maxRepos: 100,
  timeoutMs: 15_000
}
const imported: ProjectGroupImportResult = {
  projects: [{ path: '/home/me/nest/api', projectId: 'repo-1', status: 'imported' }],
  importedCount: 1,
  alreadyKnownCount: 0,
  failedCount: 0
}

const scanNestedReposOnSshHost = vi.fn<OrcaRuntimeService['scanNestedReposOnSshHost']>()
const importNestedReposOnSshHost = vi.fn<OrcaRuntimeService['importNestedReposOnSshHost']>()
const scanNestedRepos = vi.fn<OrcaRuntimeService['scanNestedRepos']>()
const importNestedRepos = vi.fn<OrcaRuntimeService['importNestedRepos']>()
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these handlers read only the runtime id and the four nested repo calls.
const runtime = {
  getRuntimeId: () => 'test-runtime',
  scanNestedReposOnSshHost,
  importNestedReposOnSshHost,
  scanNestedRepos,
  importNestedRepos
} as unknown as OrcaRuntimeService

const scanParams = { targetId: 'ssh-1', path: '/home/me/nest' }
const importParams = {
  targetId: 'ssh-1',
  parentPath: '/home/me/nest',
  groupName: 'nest',
  projectPaths: ['/home/me/nest/api'],
  mode: 'group'
}

function dispatch(
  method: string,
  sent: unknown,
  options?: RpcDispatchStreamingOptions,
  callerScope?: RpcCallerScope,
  methods: readonly RpcAnyMethodDeclaration[] = POD_SSH_NESTED_REPO_METHODS
): Promise<RpcResponse> {
  return new RpcDispatcher({ runtime, methods, callerScope }).dispatch(
    { id: 'req-1', authToken: 'tok', method, params: sent },
    options
  )
}

function expectNothingAsked(): void {
  expect(scanNestedReposOnSshHost).not.toHaveBeenCalled()
  expect(importNestedReposOnSshHost).not.toHaveBeenCalled()
}

beforeEach(() => {
  vi.clearAllMocks()
  scanNestedReposOnSshHost.mockResolvedValue(scan)
  importNestedReposOnSshHost.mockResolvedValue(imported)
  scanNestedRepos.mockResolvedValue(scan)
  importNestedRepos.mockResolvedValue(imported)
})

describe('Pod SSH nested repo RPC methods', () => {
  it('is advertised, so a client scans a host only where it works', () => {
    expect(POD_RUNTIME_CAPABILITIES).toContain('pod.ssh.nested-scan.v1')
  })

  it('declares host-admin on both and stays off the paired-mobile allowlist', () => {
    expect(POD_SSH_NESTED_REPO_METHODS.map((method) => [method.name, method.permission])).toEqual([
      ['projectGroup.scanNestedRemote', 'host-admin'],
      ['projectGroup.importNestedRemote', 'host-admin']
    ])
    expect(MOBILE_RPC_METHOD_ALLOWLIST.has('projectGroup.scanNestedRemote')).toBe(false)
    expect(MOBILE_RPC_METHOD_ALLOWLIST.has('projectGroup.importNestedRemote')).toBe(false)
  })

  it("scans and imports for PodNative's unary call, its local stream and the desktop", async () => {
    for (const options of [
      undefined,
      {
        caller: LOCAL_CLI_RPC_CALLER,
        callerScope: OWNER_RPC_CALLER_SCOPE,
        clientKind: 'runtime' as const,
        connectionId: 'stream-1'
      },
      { caller: DESKTOP_RPC_CALLER }
    ]) {
      await expect(
        dispatch('projectGroup.scanNestedRemote', scanParams, options)
      ).resolves.toMatchObject({
        ok: true,
        result: scan
      })
      await expect(
        dispatch('projectGroup.importNestedRemote', importParams, options)
      ).resolves.toMatchObject({
        ok: true,
        result: imported
      })
    }
    expect(scanNestedReposOnSshHost.mock.calls).toEqual(
      Array.from({ length: 3 }, () => ['ssh-1', '/home/me/nest'])
    )
    expect(importNestedReposOnSshHost.mock.calls[0]).toEqual([
      {
        connectionId: 'ssh-1',
        parentPath: '/home/me/nest',
        groupName: 'nest',
        projectPaths: ['/home/me/nest/api'],
        mode: 'group'
      }
    ])
  })

  it('takes an absent group name as the folder name, as the IPC does', async () => {
    const { groupName: _groupName, ...rest } = importParams
    await dispatch('projectGroup.importNestedRemote', { ...rest, mode: 'separate' })
    expect(importNestedReposOnSshHost.mock.calls[0]?.[0]).toMatchObject({
      groupName: '',
      mode: 'separate'
    })
  })

  it("refuses an SSH host's orca CLI, with remote control on or off, before the handler", async () => {
    for (const remoteCliControl of [true, false]) {
      const scope: RpcCallerScope = { kind: 'ssh-bridge', targetId: 'ssh-2', remoteCliControl }
      await expect(
        dispatch('projectGroup.scanNestedRemote', scanParams, undefined, scope)
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'forbidden' }
      })
      await expect(
        dispatch('projectGroup.importNestedRemote', importParams, undefined, scope)
      ).resolves.toMatchObject({ ok: false, error: { code: 'forbidden' } })
    }
    expectNothingAsked()
  })

  it('refuses a paired device, even one granted desktop control at pairing, and the phone', async () => {
    for (const grants of [[], ['desktop-control']] as const) {
      await expect(
        dispatch(
          'projectGroup.scanNestedRemote',
          scanParams,
          { pairedDeviceId: 'device-1' },
          {
            kind: 'runtime-paired',
            grants
          }
        )
      ).resolves.toMatchObject({ ok: false, error: { code: 'forbidden' } })
    }
    await expect(
      dispatch(
        'projectGroup.importNestedRemote',
        importParams,
        { pairedDeviceId: 'phone-1', clientKind: 'mobile' },
        {
          kind: 'mobile'
        }
      )
    ).resolves.toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expectNothingAsked()
  })

  it('refuses params beyond one folder on one named host', async () => {
    for (const sent of [
      undefined,
      {},
      { path: '/home/me/nest' },
      { targetId: 'ssh-1' },
      { ...scanParams, connectionId: 'ssh-2' },
      { ...scanParams, options: { maxRepos: 500 } },
      { ...scanParams, targetId: '' },
      { ...scanParams, path: 42 }
    ]) {
      await expect(
        dispatch('projectGroup.scanNestedRemote', sent),
        JSON.stringify(sent)
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'invalid_argument' }
      })
    }
    for (const sent of [
      { ...importParams, scanId: 'scan-1' },
      { ...importParams, mode: 'merge' },
      { ...importParams, projectPaths: Array.from({ length: 501 }, () => '/home/me/nest/api') }
    ]) {
      await expect(
        dispatch('projectGroup.importNestedRemote', sent),
        JSON.stringify(sent).slice(0, 80)
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'invalid_argument' }
      })
    }
    expectNothingAsked()
  })

  it('leaves projectGroup.scanNested and importNested local: a connectionId there never reaches a host', async () => {
    await dispatch(
      'projectGroup.scanNested',
      { path: '/Users/me/nest', connectionId: 'ssh-1' },
      undefined,
      undefined,
      REPO_METHODS
    )
    await dispatch(
      'projectGroup.importNested',
      { parentPath: '/Users/me/nest', projectPaths: [], mode: 'group', connectionId: 'ssh-1' },
      undefined,
      undefined,
      REPO_METHODS
    )
    expect(scanNestedRepos).toHaveBeenCalledWith('/Users/me/nest')
    expect(importNestedRepos.mock.calls[0]?.[0]).not.toHaveProperty('connectionId')
    expectNothingAsked()
  })
})
