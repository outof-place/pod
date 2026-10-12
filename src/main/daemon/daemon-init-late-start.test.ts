import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  checkDaemonHealthMock,
  localFallbackProvider,
  setLocalPtyProviderMock,
  rebindLocalProviderListenersMock,
  importFresh,
  installDefaultNetConnectStub,
  moduleFactories
} = await vi.hoisted(async () =>
  (await import('./daemon-init-test-harness')).createDaemonInitMocks()
)

vi.mock('fs', () => moduleFactories.fs())
vi.mock('child_process', async (importOriginal) =>
  moduleFactories.childProcess(await importOriginal<Record<string, unknown>>())
)
vi.mock('net', () => moduleFactories.net())
vi.mock('./daemon-health', () => moduleFactories.daemonHealth())
vi.mock('./daemon-pid-identity', () => moduleFactories.daemonPidIdentity())
vi.mock('./daemon-tcc-attribution', () => moduleFactories.daemonTccAttribution())
vi.mock('./daemon-bundle-staleness', () => moduleFactories.daemonBundleStaleness())
vi.mock('./daemon-stale-kill', () => moduleFactories.daemonStaleKill())
vi.mock('./daemon-process-start-time', () => moduleFactories.daemonProcessStartTime())
vi.mock('./daemon-pid-file-parse', () => moduleFactories.daemonPidFileParse())
vi.mock('./client', () => moduleFactories.client())
vi.mock('./daemon-lifecycle-event', () => moduleFactories.daemonLifecycleEvent())
vi.mock('./daemon-adoption-telemetry-event', () => moduleFactories.daemonAdoptionTelemetryEvent())
vi.mock('./daemon-spawner', () => moduleFactories.daemonSpawner())
vi.mock('./daemon-pty-adapter', () => moduleFactories.daemonPtyAdapter())
vi.mock('../ipc/pty', () => moduleFactories.ipcPty())

// Fork-only (Pod): a daemon that comes up after startup fell back to local PTYs.
describe('daemon-init: late start', () => {
  beforeEach(() => {
    installDefaultNetConnectStub()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it("takes fresh terminals once it answers, and leaves the fallback's terminals local", async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider(undefined, { late: true })

    const { DegradedDaemonPtyProvider } = await import('./degraded-daemon-pty-provider')
    const late = mod.getDaemonProvider()
    if (!(late instanceof DegradedDaemonPtyProvider)) {
      throw new Error('a late daemon installs behind the local fallback')
    }
    expect(setLocalPtyProviderMock).toHaveBeenCalledWith(late)
    expect(rebindLocalProviderListenersMock).toHaveBeenCalled()
    // The health probe answered, so fresh spawns already go to the daemon.
    expect(checkDaemonHealthMock).toHaveBeenCalled()
    expect(late.routesFreshSpawnsToLocalProvider).toBeUndefined()
    expect(late.fallback).toBe(localFallbackProvider)
    // A PTY the fallback spawned before the daemon came up stays on the fallback.
    late.write('local-before-daemon', 'echo hi\r')
    expect(localFallbackProvider.write).toHaveBeenCalledWith('local-before-daemon', 'echo hi\r')
  })

  it('keeps fresh terminals local while the late daemon fails its health probe', async () => {
    checkDaemonHealthMock.mockResolvedValueOnce('unhealthy')
    const mod = await importFresh()
    await mod.initDaemonPtyProvider(undefined, { late: true })

    const { DegradedDaemonPtyProvider } = await import('./degraded-daemon-pty-provider')
    const late = mod.getDaemonProvider()
    if (!(late instanceof DegradedDaemonPtyProvider)) {
      throw new Error('a late daemon installs behind the local fallback')
    }
    expect(late.routesFreshSpawnsToLocalProvider).toBe(true)
  })

  it('installs a plain daemon provider when startup did not fall back', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()
    const { DegradedDaemonPtyProvider } = await import('./degraded-daemon-pty-provider')
    expect(mod.getDaemonProvider()).not.toBeInstanceOf(DegradedDaemonPtyProvider)
  })
})
