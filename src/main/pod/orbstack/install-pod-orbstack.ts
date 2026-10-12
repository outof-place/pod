import { homedir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { spawnProcess } from '@orca/process-host'
import type { Repo } from '../../../shared/repo-types'
import { probeClaudeCliVersion } from '../../claude/claude-hook-event-versions'
import { resolveClaudeCommand } from '../../codex-cli/command'
import { getMainHttpClient } from '../../network/http-client'
import { createClaudeReleaseCache, sandboxClaudePlatform } from './pod-orbstack-claude-release'
import { isPodOrbstackEnabled } from './pod-orbstack-flag'
import { createPodOrbstackMachines } from './pod-orbstack-machines'
import { loadPodOrbstackRecipe } from './pod-orbstack-recipe'
import { PodOrbstackRegistry } from './pod-orbstack-registry'
import { restartPodOrbstack } from './pod-orbstack-restart'
import {
  countMachineCreates,
  createPodOrbstackChurn,
  orbstackBootMarker
} from './pod-orbstack-churn'
import { createPodOrbstackService, setPodOrbstackService } from './pod-orbstack-service'
import { createSandboxRelays } from './pod-orbstack-relay'
import {
  createClaudeOAuthSandboxCredentials,
  sandboxClaudeLoginAllowed
} from './pod-orbstack-anthropic-oauth'
import { setPodSandboxAnthropicCredentials } from './pod-orbstack-anthropic-route'
import { createSandboxAccess } from './pod-orbstack-sandbox-access'
import { createPodOrbstackTemplates } from './pod-orbstack-templates'
import { createPodOrbstackEvents } from './pod-orbstack-events'
import {
  CGROUP_FILES,
  createPodOrbstackDiskSizes,
  createPodOrbstackStats
} from './pod-orbstack-stats'
import { createStatsReaders } from './pod-orbstack-stats-readers'
import { readPodOrbstackStatus } from './pod-orbstack-status'
import {
  setPodOrbstackTerminalResolver,
  setPodSandboxRelayStarter
} from './pod-orbstack-terminal-override'
import {
  createOrbstackToolRunner,
  resolveOrbstackE2eAnthropic,
  resolveOrbstackHomeOverride,
  resolveOrbstackSkipAgentInstall,
  resolveOrbstackTemplatesEnabled,
  resolveOrbstackToolPaths,
  type OrbstackToolPaths
} from './pod-orbstack-tools'

let installed = false
// Why late: the template refresh is background work; it must not compete with Pod's own startup.
const PREWARM_DELAY_MS = 60_000

/** Idempotent. Backs the orbstack.* RPC methods and the terminal resolver; nothing runs until asked. */
export function installPodOrbstack(store: { getRepos(): Repo[] }): void {
  if (installed) {
    return
  }
  installed = true
  const enabled = isPodOrbstackEnabled()
  const dataDir = join(app.getPath('userData'), 'pod-orbstack')
  const events = createPodOrbstackEvents()
  // Late-bound: registry and template saves drop the status cache and reach subscribers.
  let changed = (): void => events.changed()
  const registry = new PodOrbstackRegistry(join(dataDir, 'registry.json'), () => changed())
  // Re-resolved per use: OrbStack can be installed or moved while Pod runs.
  const paths = (): OrbstackToolPaths => resolveOrbstackToolPaths()
  const home = resolveOrbstackHomeOverride()
  const churn = createPodOrbstackChurn({
    file: join(dataDir, 'churn.json'),
    bootMarker: () => orbstackBootMarker(home ?? homedir())
  })
  const run = countMachineCreates(createOrbstackToolRunner(paths, home), churn)
  const releases = createClaudeReleaseCache({
    root: join(dataDir, 'claude-releases'),
    fetcher: (url, init) => getMainHttpClient().fetch(url, init),
    platform: () => sandboxClaudePlatform()
  })
  const relays = createSandboxRelays({
    spawnAgent: (machine, args) =>
      spawnProcess({
        program: paths().orb ?? 'orb',
        args: ['-m', machine, '-u', 'root', 'python3', ...args],
        ...(home ? { env: { ...process.env, HOME: home } } : {})
      }),
    log: (message) => console.warn(`[pod-orbstack] ${message}`),
    onRow: (row) => events.relay(row)
  })
  // Memory only: a restart mints fresh tokens and CAs on the next launch; quitting drops them all.
  const e2eAnthropic = resolveOrbstackE2eAnthropic()
  // Sandboxed agents can use the Mac's own Claude Code login (opt-in), never refreshed. The switch
  // is read per launch and request; POD_SANDBOX_ANTHROPIC=off is a hard off; E2E runs never get it.
  if (e2eAnthropic) {
    setPodSandboxAnthropicCredentials(e2eAnthropic.credentials)
  } else if (!process.env.ORCA_E2E_USER_DATA_DIR) {
    setPodSandboxAnthropicCredentials(
      createClaudeOAuthSandboxCredentials({ allowed: () => sandboxClaudeLoginAllowed(registry) })
    )
  }
  const access = createSandboxAccess({
    relays,
    upstream: e2eAnthropic?.upstream,
    log: (message) => console.warn(`[pod-orbstack] ${message}`),
    onRow: (row) => events.relay(row)
  })
  app.on('will-quit', () => relays.stopAll())
  const log = (message: string): void => console.warn(`[pod-orbstack] ${message}`)
  const templates = createPodOrbstackTemplates({
    run,
    file: join(dataDir, 'templates.json'),
    log,
    onChange: () => changed()
  })
  const templatesAllowed = resolveOrbstackTemplatesEnabled()
  const diskSizes = createPodOrbstackDiskSizes({ run })
  const machines = createPodOrbstackMachines({
    paths,
    run,
    registry,
    home,
    loadRecipe: () => loadPodOrbstackRecipe(join(dataDir, 'recipe.json')),
    onRecipeCreate: () => churn.count(),
    onSandboxCreated: (name) => access.created(name),
    onSandboxRemoved: (name) => access.forget(name),
    ...(templatesAllowed ? { templates } : {}),
    log,
    onProgress: (worktreeId, kind, step) => events.progress(worktreeId, kind, step),
    prepareClaudeRelease: resolveOrbstackSkipAgentInstall()
      ? async () => null
      : async () => releases.prepare(await probeClaudeCliVersion(resolveClaudeCommand()))
  })
  const readers = createStatsReaders({
    spawn: (machine, args) =>
      spawnProcess({
        program: paths().orb ?? 'orb',
        args: ['-m', machine, ...args],
        ...(home ? { env: { ...process.env, HOME: home } } : {})
      }),
    files: CGROUP_FILES,
    timeoutMs: 3_000,
    idleMs: 15_000
  })
  app.on('will-quit', () => readers.closeAll())
  const stats = createPodOrbstackStats({
    run,
    podMachines: () => registry.machines().map((entry) => entry.name),
    busyMachines: () => machines.busyMachines(),
    diskSizes,
    readers
  })
  const service = createPodOrbstackService({
    enabled,
    getRepos: () => store.getRepos(),
    machines,
    registry,
    readStatus: ({ containers }) =>
      readPodOrbstackStatus({
        paths: paths(),
        run,
        registry,
        templates: templates.list(),
        templatesEnabled: templatesAllowed && templates.enabled(),
        diskSizes,
        containers,
        busyWorktreeIds: machines.busyWorktreeIds(),
        churn: churn.snapshot()
      }),
    readStats: (names) => stats.read(names),
    ...(templatesAllowed ? { setTemplates: (on: boolean) => templates.setEnabled(on) } : {}),
    restart: () =>
      restartPodOrbstack({
        run,
        busyWorktreeIds: () => machines.busyWorktreeIds(),
        beforeStop: () => readers.closeAll()
      }),
    onChanged: () => events.changed(),
    subscribe: (emit) => events.subscribe(emit)
  })
  changed = () => {
    service.invalidate()
    stats.invalidate()
  }
  setPodOrbstackService(service)
  if (!enabled) {
    return
  }
  setTimeout(() => {
    machines.prewarm().catch((error) => log(`template refresh failed: ${String(error)}`))
  }, PREWARM_DELAY_MS).unref()
  setPodSandboxRelayStarter((machine, hookServer) => {
    try {
      return access.start(machine, hookServer)
    } catch (error) {
      console.warn('[pod-orbstack] could not start the sandbox relay:', error)
      return null
    }
  })
  setPodOrbstackTerminalResolver((worktreeId) => {
    const entry = registry.findByWorktree(worktreeId)
    const machine = entry?.state === 'ready' ? entry.name : null
    const sandboxEntry = registry.findByWorktree(worktreeId, 'sandbox')
    const sandbox =
      sandboxEntry?.state === 'ready' && sandboxEntry.networkIsolated
        ? { machine: sandboxEntry.name, agentsByDefault: registry.isSandboxAgents(worktreeId) }
        : null
    const dockerPinned = registry.isDockerPinned(worktreeId)
    if (!machine && !sandbox && !dockerPinned) {
      return null
    }
    const orbPath = machine || sandbox ? paths().orb : null
    return {
      orbPath: orbPath ?? '',
      machine: orbPath ? machine : null,
      dockerPinned,
      orbHome: home,
      sandbox: orbPath ? sandbox : null
    }
  })
}
