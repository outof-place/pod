import './mock-descendant-sweep'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  beginPtyHandlerTest,
  endPtyHandlerTest,
  type MockDispatcher
} from './pty-handler-test-harness'
import type { PtyHandler } from './pty-handler'
import { ENV_DECOUPLED, ENV_SPELLINGS } from '../shared/pod-legacy-env-names'

const mocks = vi.hoisted(() => ({
  mockPtySpawn: vi.fn(),
  mockCreateShellPromptReadinessProbe: vi.fn(),
  mockPtyInstance: {
    pid: process.pid,
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    clear: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn()
  }
}))
vi.mock('node-pty', () => ({ spawn: mocks.mockPtySpawn }))
vi.mock('../main/shell-prompt-readiness-probe', () => ({
  createShellPromptReadinessProbe: mocks.mockCreateShellPromptReadinessProbe
}))
vi.mock('../main/pty/posix-pty-process-groups', () => ({
  forceKillPosixPtyProcessGroups: vi.fn((_pid: number, fallback: () => void) => fallback())
}))

// Fork-only (Pod): a relay that inherits a Pod pane's ORCA_ env would hand it to new terminals,
// where the dual-read hook clients take it for this Pod's (pod-decouple).
const current = (name: string): string => `${ENV_SPELLINGS.current}${name}`
const legacy = (name: string): string => `${ENV_SPELLINGS.legacy}${name}`

describe.runIf(ENV_DECOUPLED)('an SSH terminal under an inherited ORCA_ env', () => {
  let dispatcher: MockDispatcher
  let handler: PtyHandler
  let originalPlatform: PropertyDescriptor | undefined

  beforeEach(() => {
    ;({ dispatcher, handler, originalPlatform } = beginPtyHandlerTest(mocks))
  })
  afterEach(async () => {
    await endPtyHandlerTest(handler, originalPlatform)
    vi.unstubAllEnvs()
  })

  // The twin of a name the request sets is the request's value, never the inherited one.
  it('gets none of its renamed names, except twins of the ones the request sets', async () => {
    vi.stubEnv(legacy('AGENT_HOOK_ENDPOINT'), '/live-pod/agent-hooks/endpoint.env')
    vi.stubEnv(legacy('PANE_KEY'), 'tab-9:live-pane')
    vi.stubEnv(legacy('AGENT_LAUNCH_TOKEN'), 'live-launch')
    await dispatcher.callRequest('pty.spawn', {
      cols: 80,
      rows: 24,
      env: { [current('PANE_KEY')]: 'tab-1:own', [legacy('TAB_ID')]: 'explicit-legacy' }
    })
    const env = mocks.mockPtySpawn.mock.calls.at(-1)?.[2].env
    expect(env).not.toHaveProperty(legacy('AGENT_HOOK_ENDPOINT'))
    expect(env).not.toHaveProperty(legacy('AGENT_LAUNCH_TOKEN'))
    expect(env).toMatchObject({
      [current('PANE_KEY')]: 'tab-1:own',
      [legacy('PANE_KEY')]: 'tab-1:own',
      [legacy('TAB_ID')]: 'explicit-legacy'
    })
  })
})
