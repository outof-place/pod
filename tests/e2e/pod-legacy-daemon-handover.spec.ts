import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { expect, test, type TestInfo } from '@playwright/test'
import { createLegacyDaemonAdapters } from '../../src/main/daemon/daemon-legacy-adapters'
import type { DaemonPtyAdapter } from '../../src/main/daemon/daemon-pty-adapter'
import { probeDaemonSocket } from '../../src/main/daemon/daemon-launch-paths'
import { moveLegacyDaemons } from '../../src/main/product-identity/legacy-daemon-handover'
import {
  watchMovedDaemons,
  type DaemonLoss
} from '../../src/main/product-identity/legacy-daemon-loss-watch'
import {
  cleanupDaemonGenerationFixtures,
  createDaemonGenerationRuntime,
  launchDaemonGeneration,
  pingGenerationCanary,
  spawnGenerationCanary,
  type DaemonGeneration,
  type GenerationCanary
} from './helpers/daemon-generation-safety-fixtures'
import { waitForCondition } from './helpers/daemon-generation-processes'

// Orca 1.4.223's protocol: older than this build's, so the product reaches it as a legacy daemon.
const LEGACY_PROTOCOL = 41
// The daemon's endpoint watchdog polls every 30 s and needs two misses before it calls the name lost.
const OWNERSHIP_LOSS_MS = 65_000
const RESTORE_SCRIPT = path.join(process.cwd(), 'product/scripts/restore-orca-terminals.mjs')

type Attached = { adapter: DaemonPtyAdapter; output(): string }

async function attachFromDiscovery(
  daemonDir: string,
  historyDir: string,
  canary: GenerationCanary
): Promise<Attached> {
  const adapters = await createLegacyDaemonAdapters(daemonDir, historyDir)
  expect(adapters.map((adapter) => adapter.protocolVersion)).toEqual([LEGACY_PROTOCOL])
  const [adapter] = adapters
  let output = ''
  adapter.onData((event) => {
    if (event.id === canary.sessionId) {
      output += event.data
    }
  })
  // Why attach-only: how the app reattaches restored panes, and the one request a daemon that
  // lost its endpoint name still serves.
  const attached = await adapter.spawn({
    sessionId: canary.sessionId,
    attachOnly: true,
    cols: 100,
    rows: 30,
    cwd: path.dirname(daemonDir)
  })
  // Same process incarnation: the terminal survived the move.
  expect(attached.isReattach).toBe(true)
  expect(attached.pid).toBe(canary.rootIdentity.pid)
  return { adapter, output: () => output }
}

async function ping(attached: Attached, canary: GenerationCanary, nonce: string): Promise<void> {
  const label = `${canary.generation.label}-${canary.role}`
  attached.adapter.write(canary.sessionId, `PING ${label} ${nonce}\r`)
  await waitForCondition(`${label} ${nonce} reply`, () =>
    attached.output().includes(`ORCA_GENERATION_CANARY_ACK ${label} ${nonce}`)
  )
}

function restore(podUserData: string): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [RESTORE_SCRIPT, podUserData], { encoding: 'utf8' })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

function handOver(orcaUserData: string, podUserData: string): void {
  const result = moveLegacyDaemons({
    legacyUserData: orcaUserData,
    productUserData: podUserData,
    attachableDaemonProtocols: [LEGACY_PROTOCOL],
    legacyAppPid: null
  })
  expect(result).toMatchObject({ status: 'moved', skipped: [] })
  writeFileSync(
    path.join(podUserData, 'product-profile-migration.json'),
    JSON.stringify({
      from: orcaUserData,
      daemonHandover: { decision: 'moved', moved: result.status === 'moved' ? result.moved : [] }
    })
  )
}

test('moves a live legacy daemon to the product, back, and leaves Orca a fresh one', async (// oxlint-disable-next-line no-empty-pattern -- Playwright requires the fixture argument before testInfo.
{}, testInfo: TestInfo) => {
  test.setTimeout(240_000)
  const runtime = await createDaemonGenerationRuntime(testInfo)
  const generations: DaemonGeneration[] = []
  const canaries: GenerationCanary[] = []
  const attachments: Attached[] = []
  const orcaUserData = runtime.userDataDir
  const podUserData = path.join(runtime.rootDir, 'pod-user-data')
  const historyDir = path.join(runtime.rootDir, 'history')
  mkdirSync(podUserData)
  try {
    const legacy = await launchDaemonGeneration({
      runtime,
      label: 'orca',
      protocolVersion: LEGACY_PROTOCOL
    })
    generations.push(legacy)
    // What Orca's own launcher records; the fixture daemon writes none.
    writeFileSync(
      path.join(runtime.daemonDir, `daemon-v${LEGACY_PROTOCOL}.pid`),
      JSON.stringify({ pid: legacy.identity.pid })
    )
    const canary = await spawnGenerationCanary({ runtime, generation: legacy, role: 'live' })
    canaries.push(canary)
    await pingGenerationCanary(canary, 'before-move')
    // Orca quits: its client lets go, the daemon and the terminal keep running.
    await canary.adapter.disconnectOnly()

    // The handover: Orca-side discovery finds nothing, the product reattaches and talks.
    handOver(orcaUserData, podUserData)
    await expect(probeDaemonSocket(legacy.socketPath)).resolves.toBe(false)
    await expect(createLegacyDaemonAdapters(runtime.daemonDir, historyDir)).resolves.toEqual([])
    const pod = await attachFromDiscovery(path.join(podUserData, 'daemon'), historyDir, canary)
    attachments.push(pod)
    await ping(pod, canary, 'in-pod')

    // Rollback refuses while the product runs, then puts the endpoint back for Orca.
    symlinkSync(`host.local-${process.pid}`, path.join(podUserData, 'SingletonLock'))
    expect(restore(podUserData)).toMatchObject({ status: 2 })
    rmSync(path.join(podUserData, 'SingletonLock'))
    await pod.adapter.disconnectOnly()
    expect(restore(podUserData)).toMatchObject({ status: 0 })
    const orcaAgain = await attachFromDiscovery(runtime.daemonDir, historyDir, canary)
    attachments.push(orcaAgain)
    await ping(orcaAgain, canary, 'back-in-orca')
    await orcaAgain.adapter.disconnectOnly()

    // Hand over again and outlast the watchdog: attach keeps working once the name is lost.
    handOver(orcaUserData, podUserData)
    const podAgain = await attachFromDiscovery(path.join(podUserData, 'daemon'), historyDir, canary)
    attachments.push(podAgain)
    await new Promise((resolve) => setTimeout(resolve, OWNERSHIP_LOSS_MS))
    expect(legacy.logEvents().some((event) => event.event === 'endpoint-ownership-lost')).toBe(true)
    await ping(podAgain, canary, 'after-ownership-loss')

    // Orca's next launch finds its path free and publishes a fresh daemon there.
    const fresh = await launchDaemonGeneration({
      runtime,
      label: 'orca-fresh',
      protocolVersion: LEGACY_PROTOCOL
    })
    generations.push(fresh)
    expect(fresh.identity.pid).not.toBe(legacy.identity.pid)
    await expect(probeDaemonSocket(fresh.socketPath)).resolves.toBe(true)
    await ping(podAgain, canary, 'beside-fresh-orca-daemon')
  } catch (error) {
    runtime.retainDiagnostics(generations)
    throw error
  } finally {
    for (const attached of attachments) {
      attached.adapter.dispose()
    }
    await cleanupDaemonGenerationFixtures({ generations, canaries })
    runtime.remove()
  }
})

test('a moved daemon killed after the reattach is recorded as lost and reported once', async (// oxlint-disable-next-line no-empty-pattern -- Playwright requires the fixture argument before testInfo.
{}, testInfo: TestInfo) => {
  test.setTimeout(120_000)
  const runtime = await createDaemonGenerationRuntime(testInfo)
  const generations: DaemonGeneration[] = []
  const canaries: GenerationCanary[] = []
  const attachments: Attached[] = []
  const podUserData = path.join(runtime.rootDir, 'pod-user-data')
  const historyDir = path.join(runtime.rootDir, 'history')
  mkdirSync(podUserData)
  const losses: DaemonLoss[] = []
  let stopWatch = (): void => {}
  try {
    const legacy = await launchDaemonGeneration({
      runtime,
      label: 'orca',
      protocolVersion: LEGACY_PROTOCOL
    })
    generations.push(legacy)
    writeFileSync(
      path.join(runtime.daemonDir, `daemon-v${LEGACY_PROTOCOL}.pid`),
      JSON.stringify({ pid: legacy.identity.pid })
    )
    const canary = await spawnGenerationCanary({ runtime, generation: legacy, role: 'live' })
    canaries.push(canary)
    await canary.adapter.disconnectOnly()
    handOver(runtime.userDataDir, podUserData)
    const pod = await attachFromDiscovery(path.join(podUserData, 'daemon'), historyDir, canary)
    attachments.push(pod)
    await ping(pod, canary, 'before-kill')

    stopWatch = watchMovedDaemons({
      userData: podUserData,
      logPath: legacy.logPath,
      intervalMs: 200,
      onLost: (loss) => losses.push(loss)
    })
    expect(losses).toEqual([])
    // What took the user's moved terminals on 2026-10-10: a SIGTERM from outside the product.
    process.kill(legacy.identity.pid, 'SIGTERM')
    await waitForCondition('the loss is reported', () => losses.length > 0)
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    expect(losses).toEqual([
      expect.objectContaining({ protocol: LEGACY_PROTOCOL, pid: legacy.identity.pid })
    ])
    const marker = JSON.parse(
      readFileSync(path.join(podUserData, 'product-profile-migration.json'), 'utf8')
    )
    expect(marker.daemonHandover).toMatchObject({
      decision: 'moved',
      lost: [{ protocol: LEGACY_PROTOCOL, pid: legacy.identity.pid, reason: losses[0].reason }]
    })
  } catch (error) {
    runtime.retainDiagnostics(generations)
    throw error
  } finally {
    stopWatch()
    for (const attached of attachments) {
      attached.adapter.dispose()
    }
    await cleanupDaemonGenerationFixtures({ generations, canaries })
    runtime.remove()
  }
})
