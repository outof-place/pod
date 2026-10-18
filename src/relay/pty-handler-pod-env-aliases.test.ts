// Fork-only (Pod): the relay's spawn and revive envs carry the POD_ aliases (pod-env-aliases.ts).
import './mock-descendant-sweep'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getOpenCodeCliCapabilities } from '../shared/opencode-cli-version'
import { POD_USER_SETTABLE_ORCA_ENV_NAMES } from '../shared/pod-env-aliases'
import {
  expectPodEnvAliasesConsistent,
  podUserSettingMarkers
} from '../main/pod/decouple/pod-env-aliases.test-support'
import type { PtyHandler } from './pty-handler'
import {
  beginPtyHandlerTest,
  createMockDispatcher,
  createTestPtyHandler,
  endPtyHandlerTest,
  testPtyId,
  type MockDispatcher
} from './pty-handler-test-harness'

const mocks = vi.hoisted(() => ({
  mockPtySpawn: vi.fn(),
  mockCreateShellPromptReadinessProbe: vi.fn(),
  probe: vi.fn(),
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
vi.mock('../main/opencode/opencode-launch-capabilities', () => ({
  probeOpenCodeLaunchCapabilities: mocks.probe
}))

let dispatcher: MockDispatcher
let handler: PtyHandler
let originalPlatform: PropertyDescriptor | undefined

beforeEach(() => {
  ;({ dispatcher, handler, originalPlatform } = beginPtyHandlerTest(mocks))
  mocks.probe.mockReset()
})
afterEach(async () => {
  await endPtyHandlerTest(handler, originalPlatform)
  vi.unstubAllEnvs()
})

function spawnedEnvironment(): Record<string, string> {
  return mocks.mockPtySpawn.mock.calls.at(-1)?.[2].env
}

async function restartHandler(): Promise<void> {
  await handler.dispose({ waitForPhysicalExit: false })
  dispatcher = createMockDispatcher()
  handler = createTestPtyHandler(dispatcher)
  mocks.mockPtySpawn.mockClear()
}

it('aliases the OpenCode plugin API the relay selects, on spawn and on revive', async () => {
  const capabilities = getOpenCodeCliCapabilities('2.0.16')
  mocks.probe.mockResolvedValue(capabilities)
  await dispatcher.callRequest('pty.spawn', {
    cwd: tmpdir(),
    command: 'opencode --standalone',
    launchAgent: 'opencode',
    env: {
      ORCA_PANE_KEY: 'tab-oc:leaf',
      ORCA_OPENCODE_PLUGIN_API: 'untrusted',
      POD_OPENCODE_PLUGIN_API: 'untrusted',
      ORCA_OPENCODE_STARTUP_PROMPT_NONCE: 'nonce',
      POD_OPENCODE_STARTUP_PROMPT_NONCE: 'nonce'
    }
  })
  expect(spawnedEnvironment().POD_OPENCODE_PLUGIN_API).toBe(capabilities.pluginApi)
  expect(spawnedEnvironment()).not.toHaveProperty('POD_OPENCODE_STARTUP_PROMPT_NONCE')
  expect(spawnedEnvironment().POD_PANE_KEY).toBe('tab-oc:leaf')
  expectPodEnvAliasesConsistent(spawnedEnvironment())
  const state = await dispatcher.callRequest('pty.serialize', { ids: [testPtyId(1)] })
  await restartHandler()
  await dispatcher.callRequest('pty.revive', { state })
  expect(spawnedEnvironment().POD_OPENCODE_PLUGIN_API).toBe(capabilities.pluginApi)
  expect(spawnedEnvironment().POD_PANE_KEY).toBe('tab-oc:leaf')
  expectPodEnvAliasesConsistent(spawnedEnvironment())
})

it("drops a POD_ twin inherited from the relay host's env", async () => {
  vi.stubEnv('POD_PANE_KEY', 'parent-pane')
  await dispatcher.callRequest('pty.spawn', { cols: 80, rows: 24, env: {} })
  expect(spawnedEnvironment()).not.toHaveProperty('POD_PANE_KEY')
  expectPodEnvAliasesConsistent(spawnedEnvironment())
})

it('leaves every user setting as given, and lets a POD_ setting win', async () => {
  const markers = podUserSettingMarkers(POD_USER_SETTABLE_ORCA_ENV_NAMES)
  await dispatcher.callRequest('pty.spawn', { cols: 80, rows: 24, env: { ...markers } })
  for (const [name, value] of Object.entries(markers)) {
    expect(spawnedEnvironment()[name], name).toBe(value)
  }
  await dispatcher.callRequest('pty.spawn', {
    cols: 80,
    rows: 24,
    env: { ORCA_GITEA_TOKEN: 'orca-value', POD_GITEA_TOKEN: 'pod-value' }
  })
  expect(spawnedEnvironment().ORCA_GITEA_TOKEN).toBe('pod-value')
  expect(spawnedEnvironment().POD_GITEA_TOKEN).toBe('pod-value')
})
