import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setAppEnvironment } from '../../shared/app-environment'

const harness = vi.hoisted(() => ({
  prepareDaemonReplacement: vi.fn(),
  launchDaemonChild: vi.fn(),
  holdDaemonAdoptionLease: vi.fn(),
  darwinDaemonHostForSpawn: vi.fn(),
  sweepDeadDaemonLaunchdJobs: vi.fn(),
  jobs: { paths: vi.fn(), writePlist: vi.fn(), bootout: vi.fn(), signal: vi.fn() }
}))

vi.mock('./client', () => ({
  DaemonClient: class {
    ensureConnectedWithin(): Promise<void> {
      return Promise.reject(new Error('no daemon answering'))
    }
    disconnect(): void {}
  }
}))
vi.mock('./daemon-endpoint-adoption', () => ({
  DaemonEndpointOwnershipError: class extends Error {},
  holdDaemonAdoptionLease: harness.holdDaemonAdoptionLease,
  reconcileDaemonPidOwnership: vi.fn()
}))
vi.mock('./daemon-launched-child', () => ({
  DaemonEndpointUnavailableError: class extends Error {},
  daemonChildHasExited: () => false,
  launchDaemonChild: harness.launchDaemonChild,
  terminateLaunchedDaemonChild: vi.fn()
}))
vi.mock('./daemon-launch-paths', () => ({
  getDaemonEntryPath: () => '/Applications/Pod.app/daemon-entry.js',
  probeDaemonSocket: vi.fn(async () => false)
}))
vi.mock('./daemon-replacement-preflight', () => ({
  prepareDaemonReplacement: harness.prepareDaemonReplacement
}))
vi.mock('./daemon-host-darwin-spawn', () => ({
  darwinDaemonHostForSpawn: harness.darwinDaemonHostForSpawn
}))
vi.mock('./daemon-host-relocation', () => ({
  materializeRelocatedDaemonHost: () => null,
  pruneDaemonHostStaging: () => {}
}))
vi.mock('./daemon-launchd-jobs-darwin', () => ({
  createDarwinDaemonLaunchdJobs: () => harness.jobs,
  daemonLaunchdJobsDir: (runtimeDir: string) => join(runtimeDir, 'launchd'),
  sweepDeadDaemonLaunchdJobs: harness.sweepDeadDaemonLaunchdJobs
}))
vi.mock('./daemon-launchd-launch', () => ({ isLaunchdDaemonLaunchEnabled: () => true }))
vi.mock('./daemon-socket-endpoint-path', () => ({ ensureDaemonSocketDir: vi.fn() }))
vi.mock('./daemon-protocol-cleanup', () => ({ cleanupDaemonForProtocol: vi.fn() }))

const { createOutOfProcessLauncher } = await import('./daemon-out-of-process-launcher')

const originalPlatform = process.platform
let tempDir: string
let runtimeDir: string

const clone = {
  entryPath: '/data/daemon-host.noindex/1.0/Pod Runtime/daemon-entry.js',
  execPath: '/data/daemon-host.noindex/1.0/Pod Runtime/Contents/MacOS/Pod'
}

async function launch(policy: { macosLaunchdJob?: boolean }): Promise<unknown> {
  return createOutOfProcessLauncher(runtimeDir, policy)(
    join(tempDir, 'daemon.sock'),
    join(tempDir, 'daemon.token')
  )
}

beforeEach(() => {
  tempDir = mkdtempSync(join(os.tmpdir(), 'daemon-launcher-launchd-'))
  runtimeDir = join(tempDir, 'userData', 'daemon')
  mkdirSync(runtimeDir, { recursive: true })
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  setAppEnvironment({
    getPath: () => join(tempDir, 'userData'),
    getAppPath: () => '/Applications/Pod.app/Contents/Resources/app.asar',
    getVersion: () => '1.0.0',
    isPackaged: () => true,
    onWillQuit: () => {},
    exit: () => {},
    getAppMetrics: () => []
  })
  harness.prepareDaemonReplacement.mockResolvedValue(null)
  harness.darwinDaemonHostForSpawn.mockResolvedValue(clone)
  harness.sweepDeadDaemonLaunchdJobs.mockResolvedValue([])
  harness.launchDaemonChild.mockResolvedValue({
    child: new EventEmitter(),
    identity: { pid: 4242, startedAtMs: 1 }
  })
  harness.holdDaemonAdoptionLease.mockResolvedValue({ shutdown: async () => {} })
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  vi.clearAllMocks()
  rmSync(tempDir, { recursive: true, force: true })
})

describe('the launcher of a GUI daemon on macOS', () => {
  it('keeps a daemon that owns live sessions and starts no job beside it', async () => {
    const preserved = { adopted: true, shutdown: async () => {} }
    harness.prepareDaemonReplacement.mockResolvedValue(preserved)
    expect(await launch({ macosLaunchdJob: true })).toBe(preserved)
    expect(harness.launchDaemonChild).not.toHaveBeenCalled()
    expect(harness.sweepDeadDaemonLaunchdJobs).not.toHaveBeenCalled()
  })

  it('starts a new daemon as a job from the clone, after the sweep', async () => {
    await launch({ macosLaunchdJob: true })
    expect(harness.sweepDeadDaemonLaunchdJobs).toHaveBeenCalledWith(
      join(tempDir, 'userData'),
      join(runtimeDir, 'launchd'),
      harness.jobs
    )
    expect(harness.sweepDeadDaemonLaunchdJobs.mock.invocationCallOrder[0]).toBeLessThan(
      harness.launchDaemonChild.mock.invocationCallOrder[0] ?? 0
    )
    const [options, jobs] = harness.launchDaemonChild.mock.calls[0] ?? []
    expect(jobs).toBe(harness.jobs)
    expect(options).toMatchObject({
      forkEntryPath: clone.entryPath,
      relocatedExecPath: clone.execPath
    })
  })

  it('forks without a clone: a job never runs from the app bundle', async () => {
    harness.darwinDaemonHostForSpawn.mockResolvedValue(null)
    await launch({ macosLaunchdJob: true })
    expect(harness.launchDaemonChild.mock.calls[0]?.[1]).toBeUndefined()
    expect(harness.sweepDeadDaemonLaunchdJobs).not.toHaveBeenCalled()
  })

  it('forks a plain serve', async () => {
    await launch({ macosLaunchdJob: false })
    expect(harness.launchDaemonChild.mock.calls[0]?.[1]).toBeUndefined()
  })
})
