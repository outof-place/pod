// Fork-only (Pod): code as Pod ran it before pod-decouple, built from this tree with each renamed
// env name in its ORCA_ spelling again: the daemon an update adopts, and the hook client an old
// terminal's claude still runs. TODO(pod): drop with the legacy-env overlap, after 2026-12-31.
import { execFileSync, fork, type ChildProcess } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build, type Loader, type Plugin } from 'esbuild'
import { getDaemonSocketPath, getDaemonTokenPath } from '../../../src/main/daemon/daemon-spawner'
import { recordProcessIdentity, type RecordedProcessIdentity } from './daemon-generation-processes'
import type { DaemonGenerationRuntime } from './daemon-generation-runtime-fixture'

export const SPELLINGS = { legacy: 'ORCA_', current: 'POD_' } as const // pod-decouple:keep
export const current = (name: string): string => `${SPELLINGS.current}${name}`
export const legacy = (name: string): string => `${SPELLINGS.legacy}${name}`

// Why a dynamic import: Playwright loads specs as CommonJS, and the codemod module uses import.meta.
let unrenamer: Promise<(text: string) => string> | undefined
function loadUnrenamer(): Promise<(text: string) => string> {
  unrenamer ??= import(
    pathToFileURL(path.join(process.cwd(), 'product/scripts/pod-decouple.mjs')).href
  ).then((codemod: { createEnvUnrenamer: () => (text: string) => string }) =>
    codemod.createEnvUnrenamer()
  )
  return unrenamer
}
const HOOK_CLIENT_SOURCE = path.join(
  process.cwd(),
  'native',
  'pod-agent-hook-macos',
  'src',
  'pod-agent-hook.c'
)

const LOADERS: Record<string, Loader> = {
  '.ts': 'ts',
  '.mts': 'ts',
  '.cts': 'ts',
  '.tsx': 'tsx',
  '.js': 'js',
  '.mjs': 'js',
  '.cjs': 'js'
}

const preDecoupleEnvNames: Plugin = {
  name: 'pre-decouple-env-names',
  setup(builder) {
    builder.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async (args) => {
      const loader = LOADERS[path.extname(args.path)]
      const unrename = await loadUnrenamer()
      return loader ? { contents: unrename(readFileSync(args.path, 'utf8')), loader } : undefined
    })
  }
}

/** The generation fixture's daemon entry, bundled as it was before the decouple. */
export async function buildPreDecoupleDaemonEntry(
  runtime: DaemonGenerationRuntime
): Promise<string> {
  const outfile = path.join(runtime.rootDir, 'pre-decouple-daemon-entry.cjs')
  await build({
    entryPoints: [path.join(process.cwd(), 'tests/e2e/fixtures/daemon-generation-entry.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    packages: 'external',
    external: ['node-pty'],
    logLevel: 'silent',
    plugins: [preDecoupleEnvNames]
  })
  return outfile
}

export type FixtureDaemon = {
  label: string
  child: ChildProcess
  identity: RecordedProcessIdentity
  socketPath: string
  tokenPath: string
}

/** One v45 daemon on its own endpoint. The env carries no Pod or Orca name from this runner: a
 *  hook client in a test terminal must never reach the hook server of the Pod it runs in. */
export async function launchFixtureDaemon(options: {
  runtime: DaemonGenerationRuntime
  entryPath: string
  label: string
  protocolVersion: number
  /** Env the daemon inherits on purpose, e.g. what a live Pod's pane gives a dev runtime. */
  inheritedEnv?: Record<string, string>
}): Promise<FixtureDaemon> {
  const { runtime, entryPath, label, protocolVersion } = options
  const daemonDir = path.join(runtime.rootDir, `${label}-daemon`)
  mkdirSync(daemonDir, { recursive: true, mode: 0o700 })
  const socketPath = getDaemonSocketPath(daemonDir, protocolVersion)
  const tokenPath = getDaemonTokenPath(daemonDir, protocolVersion)
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      !name.startsWith(SPELLINGS.legacy) &&
      !name.startsWith(SPELLINGS.current)
    ) {
      env[name] = value
    }
  }
  let stderr = ''
  const child = fork(
    entryPath,
    [
      '--protocol',
      String(protocolVersion),
      '--socket',
      socketPath,
      '--token',
      tokenPath,
      '--log',
      path.join(runtime.rootDir, `${label}.daemon.log`)
    ],
    {
      cwd: runtime.userDataDir,
      execPath: runtime.electronPath,
      env: {
        ...env,
        ...options.inheritedEnv,
        ELECTRON_RUN_AS_NODE: '1',
        NODE_PATH: path.join(process.cwd(), 'node_modules'),
        [legacy('USER_DATA_PATH')]: runtime.userDataDir,
        [current('USER_DATA_PATH')]: runtime.userDataDir
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    }
  )
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString('utf8')}`.slice(-16_384)
  })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} daemon startup timed out: ${stderr}`)),
      15_000
    )
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`${label} daemon exited with ${code}: ${stderr}`))
    })
    child.on('message', (message: unknown) => {
      if (Reflect.get(Object(message), 'type') === 'ready') {
        clearTimeout(timer)
        resolve()
      }
    })
  })
  child.removeAllListeners('exit')
  if (!child.pid) {
    throw new Error(`${label} daemon did not expose a PID`)
  }
  const identity = await recordProcessIdentity(child.pid)
  child.disconnect()
  return { label, child, identity, socketPath, tokenPath }
}

/** Pod's native hook client, as built now or as it was before the decouple. `userData` is the
 *  data folder its installing Pod records beside it, the one an ORCA_ endpoint may lie in. */
export async function compileHookClient(
  outPath: string,
  era: 'current' | 'pre-decouple',
  userData?: string
): Promise<string> {
  const source = readFileSync(HOOK_CLIENT_SOURCE, 'utf8')
  const sourcePath = `${outPath}.c`
  writeFileSync(sourcePath, era === 'current' ? source : (await loadUnrenamer())(source))
  execFileSync('clang', [
    '-O2',
    '-std=c11',
    '-Wall',
    '-Wextra',
    '-Werror',
    sourcePath,
    '-o',
    outPath
  ])
  if (userData !== undefined) {
    writeFileSync(`${outPath}.user-data`, `${userData}\n`)
  }
  return outPath
}
