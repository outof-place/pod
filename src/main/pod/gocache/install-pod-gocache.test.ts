import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import { AUTOMATED_LAUNCH_ENV } from '../acc/acc-lifecycle'
import type { PodGoCacheLifecycleInput } from './pod-gocache-lifecycle'

// Why: the lifecycle's harness and HOME guards are only as good as the values this wiring hands it.

const lifecycle = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock('electron', () => ({
  app: {
    getPath: (name: string) =>
      name === 'home' ? '/private/tmp/harness-home' : '/private/tmp/harness-home/userData'
  }
}))
vi.mock('@orca/process-host', () => ({ runProcess: vi.fn() }))
vi.mock('../../product-identity/product-identity', () => ({
  getProductIdentity: () => ({ appId: 'codes.pod.app', userDataName: 'Pod' })
}))
vi.mock('../../startup/first-window-deferral', () => ({
  runAfterFirstWindowShown: (start: () => void) => start()
}))
vi.mock('../../startup/hydrate-shell-path', () => ({
  hydrateShellPath: async () => ({
    ok: true,
    segments: ['/opt/homebrew/bin'],
    failureReason: 'none'
  })
}))
vi.mock('../../startup/main-process-state', () => ({ mainProcessState: { isServeMode: false } }))
vi.mock('../acc/acc-supervisor', () => ({ appBundlePath: () => '/Applications/Pod.app' }))
vi.mock('../instance/pod-instance', () => ({ accountHome: () => '/Users/account' }))
vi.mock('../ui-host/pod-ui-host-launch', () => ({ isPodHeadlessUiHost: () => false }))
vi.mock('./pod-gocache-lifecycle', () => ({ runPodGoCacheLifecycle: lifecycle.run }))

const realPlatform = process.platform
const realResourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
const store = { getSettings: () => getDefaultSettings('/Users/account') }

async function startedWith(): Promise<PodGoCacheLifecycleInput> {
  vi.resetModules()
  const { installPodGoCache } = await import('./install-pod-gocache')
  installPodGoCache(store)
  await vi.waitFor(() => expect(lifecycle.run).toHaveBeenCalledTimes(1))
  return lifecycle.run.mock.calls[0]![0]
}

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin' })
  // Electron's; plain Node has none
  Object.defineProperty(process, 'resourcesPath', {
    value: '/Applications/Pod.app/Contents/Resources',
    configurable: true
  })
  for (const name of AUTOMATED_LAUNCH_ENV) {
    vi.stubEnv(name, undefined)
  }
  vi.stubEnv('PATH', '/usr/bin:/bin')
  lifecycle.run.mockReset()
  lifecycle.run.mockResolvedValue({
    status: 'skipped',
    decision: { action: 'skip', reason: 'disabled' }
  })
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform })
  if (realResourcesPath) {
    Object.defineProperty(process, 'resourcesPath', realResourcesPath)
  } else {
    Reflect.deleteProperty(process, 'resourcesPath')
  }
  vi.unstubAllEnvs()
})

describe('installPodGoCache', () => {
  it("hands the lifecycle this process's HOME and the account's home separately", async () => {
    const input = await startedWith()

    expect(input).toMatchObject({
      home: '/private/tmp/harness-home',
      accountHome: '/Users/account',
      defaultUserDataPath: '/Users/account/Library/Application Support/Pod',
      bundledHelper: '/Applications/Pod.app/Contents/Resources/bin/pod-gocache',
      automatedBy: null
    })
  })

  it('names the harness variable that launched Pod', async () => {
    vi.stubEnv('POD_E2E_HEADLESS', '1')

    expect(await startedWith()).toMatchObject({ automatedBy: 'POD_E2E_HEADLESS' })
  })

  it("looks for go on the login shell's PATH first", async () => {
    const input = await startedWith()

    expect(input.goEnv.PATH).toBe('/opt/homebrew/bin:/usr/bin:/bin')
  })
})
