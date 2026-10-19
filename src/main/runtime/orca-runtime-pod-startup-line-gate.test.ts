import './orca-runtime-test-lifecycle.spec'
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  OrcaRuntimeService,
  addWorktree,
  computeWorktreePathMock,
  electronMocks,
  ensurePathWithinWorkspaceMock,
  getActiveMultiplexerMock,
  listWorktrees,
  muxRequestMock,
  registerSshGitProvider,
  unregisterSshGitProvider
} from './orca-runtime-test-mocks.spec'
import type { WorktreeMeta } from './orca-runtime-test-mocks.spec'
import {
  TEST_REPO_ID,
  TEST_WORKTREE_ID,
  isLocalBranchCatalogQuery,
  isOriginMainBaseRefProbe,
  makeWorktreeMeta,
  store
} from './orca-runtime-test-fixtures.spec'
import { createWorktreeWithStartupAgent } from '../agent-launch/startup-agent-worktree-create'
import { stageStartupCommand } from '../../shared/startup-command-staging'
import { RELAY_STARTUP_LINE_REFUSAL_METHOD } from './pod-startup-line-gate'

// Pod: a startup line the PTY host will not type is refused before any tab or PTY exists
// (`agent_prompt_needs_paste`); where staging works, nothing changes.

const LONG_MULTI_LINE_PROMPT = `Review this.\n${'Check every file. '.repeat(60)}\nThen report.`

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pod-line-gate-runtime-'))
  vi.stubEnv('TMPDIR', tmp)
})

afterEach(() => {
  vi.unstubAllEnvs()
  chmodSync(tmp, 0o700)
  rmSync(tmp, { recursive: true, force: true })
})

function makeRuntime(terminalDefaultShell: string) {
  const metaById: Record<string, WorktreeMeta> = {}
  const runtime = new OrcaRuntimeService({
    ...store,
    getSettings: () => ({
      ...store.getSettings(),
      terminalDefaultShell,
      disabledTuiAgents: [],
      agentCmdOverrides: {},
      agentDefaultArgs: {}
    }),
    getAllWorktreeMeta: () => metaById,
    getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
    setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
      metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
      return metaById[worktreeId]
    }
  } as never)
  const spawn = vi.fn().mockResolvedValue({ id: 'pty-gate' })
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  return { runtime, spawn }
}

function attachWindow(runtime: InstanceType<typeof OrcaRuntimeService>) {
  const send = vi.fn()
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
  electronMocks.BrowserWindow.fromId.mockReturnValue({
    isDestroyed: () => false,
    webContents: { send }
  })
  return send
}

function prepareWorktreeCreate(name: string) {
  const path = `/tmp/workspaces/${name}`
  computeWorktreePathMock.mockReturnValue(path)
  ensurePathWithinWorkspaceMock.mockReturnValue(path)
  vi.mocked(listWorktrees).mockResolvedValue([
    { path, head: 'abc', branch: name, isBare: false, isMainWorktree: false }
  ])
  vi.mocked(addWorktree).mockClear()
}

const needsPaste = (reason: string) => ({
  code: 'agent_prompt_needs_paste',
  message: 'agent_prompt_needs_paste',
  data: { reason }
})

const describePosix = process.platform === 'win32' ? describe.skip : describe

describePosix('refusing a startup line before any tab or PTY', () => {
  it('session.tabs.createTerminal, headless: no PTY and no tab for a multi-line command ksh cannot take', async () => {
    const { runtime, spawn } = makeRuntime('/bin/ksh')
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    await expect(
      runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        command: `echo 'one\ntwo'`
      })
    ).rejects.toMatchObject(needsPaste('multi-line'))
    expect(spawn).not.toHaveBeenCalled()
    expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs).toEqual([])
  })

  it('session.tabs.createTerminal, window: the renderer is never asked for a tab', async () => {
    const { runtime, spawn } = makeRuntime('/bin/ksh')
    const send = attachWindow(runtime)

    await expect(
      runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        command: 'a'.repeat(600)
      })
    ).rejects.toMatchObject(needsPaste('line-too-long'))
    expect(send).not.toHaveBeenCalledWith('terminal:requestTabCreate', expect.anything())
    expect(spawn).not.toHaveBeenCalled()
  })

  it('session.tabs.createTerminal with an agent prompt: refused when its script cannot be written', async () => {
    const { runtime, spawn } = makeRuntime('/bin/zsh')
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
    chmodSync(tmp, 0o500)

    await expect(
      runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        agent: 'claude',
        agentPrompt: 'one\ntwo'
      })
    ).rejects.toMatchObject(needsPaste('multi-line'))
    expect(spawn).not.toHaveBeenCalled()
    expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs).toEqual([])
  })

  it('terminal.create: no PTY for a long command ksh cannot take', async () => {
    const { runtime, spawn } = makeRuntime('/bin/ksh')

    await expect(
      runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, { command: 'a'.repeat(600) })
    ).rejects.toMatchObject(needsPaste('line-too-long'))
    expect(spawn).not.toHaveBeenCalled()
  })

  it('worktree.create: refused before the worktree exists', async () => {
    const { runtime, spawn } = makeRuntime('/bin/zsh')
    prepareWorktreeCreate('pod-gate-refused')
    chmodSync(tmp, 0o500)

    await expect(
      createWorktreeWithStartupAgent(runtime, {
        repoSelector: `id:${TEST_REPO_ID}`,
        name: 'pod-gate-refused',
        startupAgent: 'claude',
        startupPrompt: 'one\ntwo'
      })
    ).rejects.toMatchObject(needsPaste('multi-line'))
    expect(addWorktree).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })
})

describePosix('terminal.split: refused before the split pane exists', () => {
  it('no second PTY for a multi-line command ksh cannot take', async () => {
    const { runtime, spawn } = makeRuntime('/bin/ksh')
    const created = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {})
    expect(spawn).toHaveBeenCalledTimes(1)

    await expect(
      runtime.splitTerminal(created.handle, { command: `echo 'one\ntwo'` })
    ).rejects.toMatchObject(needsPaste('multi-line'))
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('no second PTY for an agent-less long command when the script cannot be written', async () => {
    const { runtime, spawn } = makeRuntime('/bin/zsh')
    const created = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {})
    chmodSync(tmp, 0o500)

    await expect(
      runtime.splitTerminal(created.handle, { command: 'a'.repeat(600) })
    ).rejects.toMatchObject(needsPaste('line-too-long'))
    expect(spawn).toHaveBeenCalledTimes(1)
  })
})

describePosix('where staging works, nothing changes', () => {
  it('worktree.create in zsh: a long multi-line prompt spawns, and its host stages it', async () => {
    const { runtime, spawn } = makeRuntime('/bin/zsh')
    prepareWorktreeCreate('pod-gate-staged')

    await createWorktreeWithStartupAgent(runtime, {
      repoSelector: `id:${TEST_REPO_ID}`,
      name: 'pod-gate-staged',
      startupAgent: 'claude',
      startupPrompt: LONG_MULTI_LINE_PROMPT
    })

    expect(spawn).toHaveBeenCalledTimes(1)
    const { command, launchAgent } = spawn.mock.calls[0][0]
    expect(command).toContain('Then report.')
    expect(launchAgent).toBe('claude')
    expect(readdirSync(tmp).filter((name) => name.startsWith('orca-launch-'))).toEqual([])
    const staged = stageStartupCommand({
      command,
      shellPath: '/bin/zsh',
      orcaBuiltLine: true,
      refuseUnstaged: true,
      directory: tmp
    })
    expect(staged.delivery).toBe('staged')
    expect(readFileSync(staged.scriptPath!, 'utf8')).toContain(`\n${command}\n`)
  })

  it('an automation in an existing workspace: the same prompt spawns', async () => {
    const { runtime, spawn } = makeRuntime('/bin/zsh')

    await runtime.launchAgentTerminal(`id:${TEST_WORKTREE_ID}`, {
      agent: 'claude',
      prompt: LONG_MULTI_LINE_PROMPT
    })

    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn.mock.calls[0][0].command).toContain('Then report.')
  })

  it('session.tabs.createTerminal in zsh: a long multi-line command spawns as is', async () => {
    const { runtime, spawn } = makeRuntime('/bin/zsh')
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
    const command = `echo '${LONG_MULTI_LINE_PROMPT}'`

    await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, { command })

    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ command }))
  })
})

describePosix('an SSH workspace: refused before the remote worktree or PTY', () => {
  const remoteRepo = {
    id: TEST_REPO_ID,
    path: '/remote/repo',
    displayName: 'repo',
    badgeColor: 'blue',
    addedAt: 1,
    connectionId: 'ssh-1'
  }
  const created = {
    path: '/remote/pod-gate-ssh',
    head: 'def',
    branch: 'refs/heads/pod-gate-ssh',
    isBare: false,
    isMainWorktree: false
  }

  function makeSshRuntime() {
    const metaById: Record<string, WorktreeMeta> = {}
    const runtime = new OrcaRuntimeService({
      ...store,
      getSettings: () => ({ ...store.getSettings(), agentCmdOverrides: {}, disabledTuiAgents: [] }),
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === TEST_REPO_ID ? remoteRepo : undefined),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      }
    } as never)
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-remote-gate' })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const provider = {
      exec: vi.fn(async (args: string[]) => {
        if (args[0] === 'config') {
          return { stdout: 'Remote User\n', stderr: '' }
        }
        if (args[0] === 'branch' || isLocalBranchCatalogQuery(args)) {
          return { stdout: '', stderr: '' }
        }
        if (args[0] === 'for-each-ref' && args.includes('--format=%(refname)%00%(symref)')) {
          return { stdout: 'refs/remotes/origin/HEAD\0refs/remotes/origin/main\n', stderr: '' }
        }
        if (isOriginMainBaseRefProbe(args)) {
          return { stdout: 'main-sha\n', stderr: '' }
        }
        if (args[0] === 'fetch') {
          return { stdout: '', stderr: '' }
        }
        throw new Error(`unexpected git call: ${args.join(' ')}`)
      }),
      addWorktree: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi.fn().mockResolvedValue([created])
    }
    registerSshGitProvider('ssh-1', provider as never)
    return { runtime, spawn, provider }
  }

  afterEach(() => {
    unregisterSshGitProvider('ssh-1')
  })

  const methodNotFound = () =>
    Promise.reject(
      Object.assign(new Error(`Method not found: ${RELAY_STARTUP_LINE_REFUSAL_METHOD}`), {
        code: -32601
      })
    )

  it.each([
    ['a relay from before the check', () => ({ request: vi.fn(methodNotFound), notify: vi.fn() })],
    ['plain SSH, with no relay', () => undefined]
  ])('worktree.create with %s: no remote worktree and no PTY', async (_label, mux) => {
    const { runtime, spawn, provider } = makeSshRuntime()
    getActiveMultiplexerMock.mockReturnValue(mux())

    await expect(
      runtime.createManagedWorktree({
        repoSelector: TEST_REPO_ID,
        name: 'pod-gate-ssh',
        startupAgent: 'claude',
        startupPrompt: 'one\ntwo'
      })
    ).rejects.toMatchObject(needsPaste('multi-line'))
    expect(provider.addWorktree).not.toHaveBeenCalled()
    expect(provider.exec).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('worktree.create with a relay that stages: the long multi-line prompt spawns', async () => {
    const { runtime, spawn, provider } = makeSshRuntime()
    const request = vi.fn((method: string, params?: Record<string, unknown>) =>
      method === RELAY_STARTUP_LINE_REFUSAL_METHOD
        ? Promise.resolve({ reason: null })
        : muxRequestMock(method, params)
    )
    getActiveMultiplexerMock.mockReturnValue({ request, notify: vi.fn() })

    await runtime.createManagedWorktree({
      repoSelector: TEST_REPO_ID,
      name: 'pod-gate-ssh',
      startupAgent: 'claude',
      startupPrompt: LONG_MULTI_LINE_PROMPT
    })

    expect(request).toHaveBeenCalledWith(
      RELAY_STARTUP_LINE_REFUSAL_METHOD,
      expect.objectContaining({ launchAgent: 'claude' })
    )
    expect(provider.addWorktree).toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn.mock.calls[0][0].command).toContain('Then report.')
  })
})
