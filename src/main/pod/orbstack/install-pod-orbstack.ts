import { join } from 'node:path'
import { app } from 'electron'
import { spawnProcess } from '../../../shared/child-process/run-process'
import type { Repo } from '../../../shared/repo-types'
import { probeClaudeCliVersion } from '../../claude/claude-hook-event-versions'
import { resolveClaudeCommand } from '../../codex-cli/command'
import { getMainHttpClient } from '../../network/http-client'
import { createClaudeReleaseCache, sandboxClaudePlatform } from './pod-orbstack-claude-release'
import { isPodOrbstackEnabled } from './pod-orbstack-flag'
import { createPodOrbstackMachines } from './pod-orbstack-machines'
import { loadPodOrbstackRecipe } from './pod-orbstack-recipe'
import { PodOrbstackRegistry } from './pod-orbstack-registry'
import { createPodOrbstackService, setPodOrbstackService } from './pod-orbstack-service'
import { createSandboxRelays } from './pod-orbstack-relay'
import { createClaudeOAuthSandboxCredentials } from './pod-orbstack-anthropic-oauth'
import { setPodSandboxAnthropicCredentials } from './pod-orbstack-anthropic-route'
import { createSandboxAccess } from './pod-orbstack-sandbox-access'
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
  resolveOrbstackToolPaths,
  type OrbstackToolPaths
} from './pod-orbstack-tools'

let installed = false

/** Idempotent. Backs the orbstack.* RPC methods and the terminal resolver; nothing runs until asked. */
export function installPodOrbstack(store: { getRepos(): Repo[] }): void {
  if (installed) {
    return
  }
  installed = true
  const enabled = isPodOrbstackEnabled()
  const dataDir = join(app.getPath('userData'), 'pod-orbstack')
  const registry = new PodOrbstackRegistry(join(dataDir, 'registry.json'))
  // Re-resolved per use: OrbStack can be installed or moved while Pod runs.
  const paths = (): OrbstackToolPaths => resolveOrbstackToolPaths()
  const home = resolveOrbstackHomeOverride()
  const run = createOrbstackToolRunner(paths, home)
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
    log: (message) => console.warn(`[pod-orbstack] ${message}`)
  })
  // Memory only: a restart mints fresh tokens and CAs on the next launch; quitting drops them all.
  const e2eAnthropic = resolveOrbstackE2eAnthropic()
  // The user chose OAuth for sandboxed agents: the Mac's own Claude Code login, never refreshed.
  // POD_SANDBOX_ANTHROPIC=off keeps the route closed; E2E runs never get a real login.
  if (e2eAnthropic) {
    setPodSandboxAnthropicCredentials(e2eAnthropic.credentials)
  } else if (!process.env.ORCA_E2E_USER_DATA_DIR && process.env.POD_SANDBOX_ANTHROPIC !== 'off') {
    setPodSandboxAnthropicCredentials(createClaudeOAuthSandboxCredentials())
  }
  const access = createSandboxAccess({
    relays,
    upstream: e2eAnthropic?.upstream,
    log: (message) => console.warn(`[pod-orbstack] ${message}`)
  })
  app.on('will-quit', () => relays.stopAll())
  const machines = createPodOrbstackMachines({
    paths,
    run,
    registry,
    home,
    loadRecipe: () => loadPodOrbstackRecipe(join(dataDir, 'recipe.json')),
    onSandboxCreated: (name) => access.created(name),
    onSandboxRemoved: (name) => access.forget(name),
    prepareClaudeRelease: resolveOrbstackSkipAgentInstall()
      ? async () => null
      : async () => releases.prepare(await probeClaudeCliVersion(resolveClaudeCommand()))
  })
  setPodOrbstackService(
    createPodOrbstackService({
      enabled,
      getRepos: () => store.getRepos(),
      machines,
      registry,
      readStatus: () =>
        readPodOrbstackStatus({
          paths: paths(),
          run,
          registry,
          busyWorktreeIds: machines.busyWorktreeIds()
        })
    })
  )
  if (!enabled) {
    return
  }
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
