import './rpc/unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from './rpc/dispatcher'
import type { OrcaRuntimeService } from './orca-runtime'
import { TERMINAL_LIFECYCLE_METHODS } from './rpc/methods/terminal/terminal-lifecycle-methods'
import { podCodexAccountRestartLaunch, podResumeSpawnOpts } from './pod-codex-account-restart'
import type { PaneAgentResumeStartup } from './orca-runtime-headless-agent-resume'
import { POD_TERMINAL_CREATE_CODEX_ACCOUNT_RESTART_RUNTIME_CAPABILITY } from '../../shared/pod-runtime-capabilities'
import { RUNTIME_CAPABILITIES } from '../../shared/protocol-version'

const codexResume: PaneAgentResumeStartup = {
  agent: 'codex',
  providerSession: { key: 'session_id', id: 'sess-1' },
  record: null,
  command: "codex '--full-auto' 'resume' 'sess-1'",
  env: { CODEX_EXTRA: '1' },
  launchConfig: { agentArgs: '--full-auto', agentEnv: {} },
  startupCommandDelivery: 'shell-ready'
}

describe('codexAccountRestart (Pod)', () => {
  it('resumes the pane in the selected account when the runtime knows its session', async () => {
    const resolvePodPaneAgentRestart = vi.fn().mockResolvedValue(codexResume)
    const launch = await podCodexAccountRestartLaunch(
      { resolvePodPaneAgentRestart },
      {
        codexAccountRestart: true,
        worktree: 'id:wt-1',
        tabId: 'tab-1',
        leafId: 'leaf-1'
      }
    )
    expect(resolvePodPaneAgentRestart).toHaveBeenCalledWith('id:wt-1', 'tab-1', 'leaf-1')
    expect(launch).toEqual({
      codexAccountRestart: true,
      command: codexResume.command,
      launchAgent: 'codex',
      resumeProviderSession: codexResume.providerSession,
      env: codexResume.env,
      launchConfig: codexResume.launchConfig,
      startupCommandDelivery: 'shell-ready'
    })
  })

  it("keeps the caller's launch without a Codex session, and does nothing without the flag", async () => {
    const claude = vi.fn().mockResolvedValue({ ...codexResume, agent: 'claude' })
    const failing = vi.fn().mockRejectedValue(new Error('terminal_not_found'))
    const pane = { worktree: 'id:wt-1', tabId: 'tab-1', leafId: 'leaf-1' }
    for (const resolvePodPaneAgentRestart of [vi.fn().mockResolvedValue(null), claude, failing]) {
      await expect(
        podCodexAccountRestartLaunch(
          { resolvePodPaneAgentRestart },
          { codexAccountRestart: true, ...pane }
        )
      ).resolves.toEqual({ codexAccountRestart: true })
    }
    const unused = vi.fn()
    await expect(
      podCodexAccountRestartLaunch({ resolvePodPaneAgentRestart: unused }, pane)
    ).resolves.toEqual({})
    await expect(
      podCodexAccountRestartLaunch(
        { resolvePodPaneAgentRestart: unused },
        { codexAccountRestart: true }
      )
    ).resolves.toEqual({ codexAccountRestart: true })
    expect(unused).not.toHaveBeenCalled()
  })

  it('hands the spawn the session and the flag only when asked', () => {
    const session = codexResume.providerSession
    expect(podResumeSpawnOpts({ resumeProviderSession: session })).toEqual({
      resumeProviderSession: session
    })
    expect(
      podResumeSpawnOpts({
        resumeProviderSession: session,
        codexAccountRestart: true
      })
    ).toEqual({
      resumeProviderSession: session,
      codexAccountRestart: true
    })
  })

  it('reaches the runtime create from terminal.create, and hosts advertise it', async () => {
    const createTerminal = vi.fn().mockResolvedValue({ handle: 'h-2' })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler only calls these members.
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      resolvePodPaneAgentRestart: vi.fn().mockResolvedValue(codexResume),
      dedupeTerminalCreate: (
        _client: string,
        selector: string,
        _mutation: string,
        _reconcile: boolean,
        create: (selector: string, handle?: string) => Promise<unknown>
      ) => create(selector),
      createTerminal
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({
      runtime,
      methods: TERMINAL_LIFECYCLE_METHODS
    })
    const response = await dispatcher.dispatch({
      id: 'req-1',
      authToken: 'tok',
      method: 'terminal.create',
      params: {
        worktree: 'id:wt-1',
        tabId: 'tab-1',
        leafId: 'leaf-1',
        command: 'codex',
        launchAgent: 'codex',
        codexAccountRestart: true
      }
    })
    expect(response.ok).toBe(true)
    expect(createTerminal.mock.calls[0]?.[1]).toMatchObject({
      codexAccountRestart: true,
      command: codexResume.command,
      resumeProviderSession: codexResume.providerSession,
      tabId: 'tab-1',
      leafId: 'leaf-1'
    })
    expect(RUNTIME_CAPABILITIES).toContain(
      POD_TERMINAL_CREATE_CODEX_ACCOUNT_RESTART_RUNTIME_CAPABILITY
    )
  })
})
