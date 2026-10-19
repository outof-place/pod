// Test support for the app module: a throwaway simulator home, git worktrees of one repo with a
// recipe, a scripted fingerprint command, a device that keeps its apps in memory, and leases written
// into the real registry file. Builds and Metro run as real (tiny) shell and node processes.
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { simLeaseKey, type SimHolder } from '../../../../shared/pod-sim/sim-holder'
import {
  SimRegistryFile,
  type SimRegistryFile as Registry
} from '../../../../shared/pod-sim/sim-registry'
import { simRunProcess } from '../adapters/sim-command-run'
import { claimSimPodHome, simPodHome, type SimPodHome } from '../adapters/sim-pod-home'
import { createSimProcessFacts } from '../adapters/sim-process-facts'
import { createSimRegistryFileStore } from '../adapters/sim-registry-file-store'
import type { SimOpOutcome, SimRuntime } from '../pool/sim-pool-ports'
import type { SimAppDevice } from './sim-app-device'
import { probeSimMetro } from './sim-app-metro-http'
import { createSimApps, type SimApps, type SimAppsOptions } from './sim-app-readiness'
import type { SimShell } from './sim-app-shell'

export const BUNDLE = 'com.example.podsim'
export const DEVICE = '0A0A0A0A-0000-4000-8000-00000000000A'

export type Sandbox = {
  dir: string
  home: SimPodHome
  repo: string
  external: string
  cleanup(): Promise<void>
}

export async function sandbox(): Promise<Sandbox> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'pod-sim-apps-')))
  const home = simPodHome({ POD_SIM_HOME: join(dir, 'pod-sim-home') })
  // The home is Pod's only on macOS; elsewhere only the pure parts are tested.
  if (process.platform === 'darwin') {
    const claimed = await claimSimPodHome(home)
    if (!claimed.ok) {
      throw new Error(claimed.message)
    }
  }
  const repo = join(dir, 'repo')
  await mkdir(join(repo, '.git'), { recursive: true })
  return {
    dir,
    home,
    repo,
    external: join(dir, 'external-clients'),
    cleanup: () => rm(dir, { recursive: true, force: true })
  }
}

export type RecipeOptions = Readonly<{
  file?: 'pod.yaml' | 'orca.yaml'
  // YAML lines under `simulators.apps.app` beyond bundleId and path.
  app?: string
  raw?: string
}>

export function recipeYaml(options: RecipeOptions = {}): string {
  const lines = [
    'simulators:',
    '  apps:',
    '    app:',
    `      bundleId: ${BUNDLE}`,
    '      path: apps/app',
    ...(options.app ? options.app.split('\n').map((line) => `      ${line}`) : [])
  ]
  return options.raw ?? `${lines.join('\n')}\n`
}

/** A worktree of `sandbox.repo` (the main checkout when `name` is null) with its app folder. */
export async function worktree(
  box: Sandbox,
  name: string | null,
  recipe: RecipeOptions | null = {}
): Promise<string> {
  const root = name === null ? box.repo : join(box.dir, name)
  await mkdir(join(root, 'apps', 'app'), { recursive: true })
  await writeFile(join(root, 'apps', 'app', 'package.json'), '{"name":"app"}\n')
  if (name !== null) {
    const gitDir = join(box.repo, '.git', 'worktrees', name)
    await mkdir(gitDir, { recursive: true })
    await writeFile(join(gitDir, 'commondir'), '../..\n')
    await writeFile(join(root, '.git'), `gitdir: ${gitDir}\n`)
  }
  if (recipe) {
    await writeFile(join(root, recipe.file ?? 'orca.yaml'), recipeYaml(recipe))
  }
  return root
}

/** A fingerprint command: prints @expo/fingerprint JSON whose hash the test sets per app folder. */
export function scriptedFingerprints() {
  const hashes = new Map<string, string>()
  const calls: string[] = []
  const shell: SimShell = async (_command, options) => {
    calls.push(options.cwd)
    const hash = hashes.get(options.cwd) ?? 'f00d'
    return {
      ok: true,
      code: 0,
      stdout: JSON.stringify({
        sources: [{ type: 'file', filePath: 'package.json', reasons: ['x'], hash: 'h' }],
        hash
      }),
      stderr: ''
    }
  }
  return { shell, hashes, calls }
}

export type FakeDevice = SimAppDevice & {
  name: string
  installs: string[]
  launches: (readonly string[])[]
  running: Set<string>
  apps: Set<string>
  // Launches that stop at the dev launcher (its manifest request timed out): no JS on Metro.
  launcherOnly: number
  // Set: each launch on Metro also loads the bundle as React Native does, giving up on a request
  // silent this long ("Could not connect to development server", 60 s on a device).
  bundleTimeoutMs: number | null
  // The latest such launch's screen once its bundle request ends.
  loaded: Promise<'app' | 'redBox'> | null
}

export function fakeDevice(): FakeDevice {
  const ok: SimOpOutcome = { ok: true }
  const device: FakeDevice = {
    name: 'Fake-iPhone',
    launcherOnly: 0,
    bundleTimeoutMs: null,
    loaded: null,
    installs: [],
    launches: [],
    running: new Set(),
    apps: new Set(),
    appInstalled: async (_udid, bundleId) => device.apps.has(bundleId),
    install: async (_udid, path) => {
      device.installs.push(path)
      device.apps.add(BUNDLE)
      return ok
    },
    uninstall: async (_udid, bundleId) => {
      device.apps.delete(bundleId)
      device.running.delete(bundleId)
      return ok
    },
    launch: async (_udid, bundleId, args) => {
      device.launches.push(args)
      device.running.add(bundleId)
      const metro = args[args.indexOf('--initialUrl') + 1]
      if (args.includes('--initialUrl') && metro) {
        // The app's JS reaches the stand-in Metro, which lists it as its inspector would.
        const connect = device.launcherOnly > 0 ? 'disconnect' : 'connect'
        device.launcherOnly = Math.max(0, device.launcherOnly - 1)
        await fetch(`${metro}/fake/${connect}?appId=${bundleId}&deviceName=${device.name}`)
        if (connect === 'connect' && device.bundleTimeoutMs !== null) {
          device.loaded = fetch(`${metro}/index.bundle?platform=ios&dev=true`, {
            signal: AbortSignal.timeout(device.bundleTimeoutMs)
          })
            .then((res) => res.text())
            .then(
              () => 'app' as const,
              () => 'redBox' as const
            )
        }
      }
      return ok
    },
    appRunning: async (_udid, bundleId) => device.running.has(bundleId),
    deviceName: async () => device.name
  }
  return device
}

export async function thisRuntime(profile = 'pod-sim-apps-test'): Promise<SimRuntime> {
  const start = await createSimProcessFacts().startOf(process.pid)
  if (start === 'unknown' || !start.found) {
    throw new Error('cannot read this process’s start')
  }
  return { pid: process.pid, startedAt: start.startedAt, profile }
}

export function appsFor(
  box: Sandbox,
  self: SimRuntime,
  overrides: Partial<SimAppsOptions> & Pick<SimAppsOptions, 'device'>
): SimApps {
  const claim = () => claimSimPodHome(box.home)
  return createSimApps({
    home: box.home,
    claim,
    store: createSimRegistryFileStore({ home: box.home, claim }),
    self,
    processes: createSimProcessFacts(),
    runtimeState: async () => 'live',
    claudeAcc: null,
    run: simRunProcess,
    userHome: box.dir,
    ...overrides
  })
}

const holder = (n: number): SimHolder => ({
  kind: 'process',
  id: `process:${90000 + n}:1760600000`,
  pid: 90000 + n,
  startedAt: 1_760_600_000
})

/**
 * A lease in the registry: `[worktree, app, buildId?]` waits in the queue (for a slot, or for that
 * build); `holds` names the device an active lease holds; `waitingFor: 'device'` is a waiter the
 * pool is readying a device for.
 */
export type TestLease =
  | readonly [worktreeRoot: string, appId: string, buildId?: string]
  | Readonly<{
      worktreeRoot: string
      appId: string
      holds?: string
      waitingFor?: 'slot' | 'device' | 'brake'
    }>

/** Writes the registry with one live lease per entry. */
export async function writeLeases(
  home: SimPodHome,
  self: SimRuntime,
  leases: readonly TestLease[]
): Promise<void> {
  const registry: Registry = SimRegistryFile.parse({
    version: 1,
    updatedAt: Date.now(),
    devices: [],
    leases: leases.map((entry, n) => {
      const lease = Array.isArray(entry)
        ? { worktreeRoot: entry[0], appId: entry[1], buildId: entry[2] }
        : { buildId: undefined, ...entry }
      const { worktreeRoot, appId, buildId } = lease
      const holds = 'holds' in lease ? lease.holds : undefined
      const waitingFor = 'waitingFor' in lease ? lease.waitingFor : undefined
      return {
        leaseId: `sl_test${n}`,
        key: simLeaseKey(holder(n).id, worktreeRoot),
        state: holds ? 'active' : 'waiting',
        holder: holder(n),
        worktreeRoot,
        app: { id: appId, bundleId: BUNDLE },
        since: Date.now(),
        lastActivity: Date.now(),
        ...(holds
          ? { udid: holds }
          : {
              queue: {
                position: n + 1,
                since: Date.now(),
                waitingFor: buildId ? 'build' : (waitingFor ?? 'slot'),
                ...(buildId ? { buildId } : {})
              }
            }),
        servedBy: { pid: self.pid, startedAt: self.startedAt }
      }
    })
  })
  await writeFile(home.registry, JSON.stringify(registry))
}

/** A shell command that leaves a simulator .app of BUNDLE at `out` and counts itself in `counter`. */
export function fakeBuildCommand(out: string, counter: string, extra = ''): string {
  const plist = `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${BUNDLE}</string></dict></plist>`
  return [
    `echo built >> '${counter}'`,
    "echo '› Compiling app'",
    extra,
    `mkdir -p '${out}'`,
    `printf '%s' '${plist}' > '${out}/Info.plist'`,
    "echo '› Build Succeeded'"
  ]
    .filter((part) => part !== '')
    .join(' && ')
}

export const NODE = process.env.ORCA_TEST_NODE_EXECUTABLE || 'node'
export const FAKE_METRO = join(__dirname, '__fixtures__', 'fake-metro.cjs')

/** A free TCP port whose first worktree ports look free too. */
export async function freeBase(): Promise<number> {
  for (;;) {
    const base = 20_000 + Math.floor(Math.random() * 20_000)
    const answers = await Promise.all(
      [base, base + 300, base + 301, base + 302].map((port) => probeSimMetro(port, '/nowhere', 300))
    )
    if (answers.every((answer) => answer === 'none')) {
      return base
    }
  }
}

/** Recipe lines for a Metro the stand-in plays; `env` prefixes its command (`FAKE_METRO_*=`). */
export function metroRecipe(base: number, env = ''): string {
  return [
    'fingerprint: fp',
    'metro:',
    `  port: ${base}`,
    `  command: ${JSON.stringify(`${env}'${NODE}' '${FAKE_METRO}' {port}`)}`
  ].join('\n')
}

/** BUNDLE's dev client of fingerprint f00d, in Pod's cache already. */
export async function cacheClient(box: Sandbox): Promise<string> {
  const client = join(box.home.root, 'clients', BUNDLE, 'f00d.app')
  await mkdir(client, { recursive: true })
  await writeFile(
    join(client, 'Info.plist'),
    `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${BUNDLE}</string></dict></plist>`
  )
  return client
}

/** Resolves once `predicate` holds, polling every 25 ms, or rejects after `ms`. */
export async function eventually<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  ms = 10_000
): Promise<T> {
  const deadline = performance.now() + ms
  for (;;) {
    const value = await read()
    if (predicate(value)) {
      return value
    }
    if (performance.now() > deadline) {
      throw new Error(`not within ${ms} ms: ${JSON.stringify(value)}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}
