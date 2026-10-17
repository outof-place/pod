// A temp account for the lifecycle tests: a home, a bundled helper, the user's go, and launchd's
// gui/<uid> domain faked; every other program runs for real.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import type { ProcessResult, ProcessSpec } from '@orca/process-host/process-spec'
import type { PodGoCacheLifecycleInput } from './pod-gocache-lifecycle'

export const UID = 501
export const LABEL = 'codes.pod.gocache'
const roots: string[] = []

/** A stand-in for the Go helper: answers `version` like the real CLI, refuses everything else. */
export function writeHelper(path: string, version: string, marker = ''): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(
    path,
    `#!/bin/sh\n# ${marker}\n[ "$1" = version ] && { echo "${version}"; exit 0; }\nexit 64\n`
  )
  chmodSync(path, 0o755)
}

/** The user's go: answers `go env GOCACHE`, and fails as a toolchain download would unless told to stay local. */
export function writeGo(dir: string, answer: { gocache?: string; code?: number }): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'go'),
    [
      '#!/bin/sh',
      '[ "$GOTOOLCHAIN" = local ] || { echo "go: downloading go1.99.0" >&2; exit 1; }',
      `[ "$1 $2" = "env GOCACHE" ] && { echo "${answer.gocache ?? ''}"; exit ${answer.code ?? 0}; }`,
      'exit 2',
      ''
    ].join('\n')
  )
  chmodSync(join(dir, 'go'), 0o755)
}

export function lifecycleFixture(
  options: { bundled?: string | null; installed?: string; bundleId?: string } = {}
) {
  const root = mkdtempSync(join(tmpdir(), 'pod-gocache-lifecycle-'))
  roots.push(root)
  const home = join(root, 'home')
  mkdirSync(home)
  const bundledHelper = join(root, 'Pod.app/Contents/Resources/bin/pod-gocache')
  if (options.bundled !== null) {
    writeHelper(bundledHelper, options.bundled ?? '0.2.0', 'bundled')
  }
  const installedHelper = join(home, '.pod/gocache/bin/pod-gocache')
  if (options.installed) {
    writeHelper(installedHelper, options.installed, 'installed')
  }
  const goBin = join(root, 'go/bin')
  const cacheDir = join(home, 'Library/Caches/go-build')
  writeGo(goBin, { gocache: cacheDir })
  const profile = join(home, 'Library/Application Support/Pod')
  const input: PodGoCacheLifecycleInput = {
    platform: 'darwin',
    home,
    accountHome: home,
    userDataPath: profile,
    defaultUserDataPath: profile,
    bundledHelper,
    uid: UID,
    bundleId: options.bundleId ?? 'codes.pod.app',
    settingEnabled: true,
    goEnv: { PATH: `/nonexistent:relative/bin:${goBin}` },
    bootstrapRetryMs: 0
  }
  return {
    root,
    input,
    home,
    goBin,
    cacheDir,
    bundledHelper,
    installedHelper,
    plist: join(home, 'Library/LaunchAgents', `${LABEL}.plist`)
  }
}

export function removeLifecycleFixtures(): void {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
}

export function result(code: number, stdout = '', stderr = ''): ProcessResult {
  return { code, signal: null, stdout, stderr, timedOut: false }
}

type LaunchdOptions = {
  loaded?: boolean
  running?: boolean
  failedBootstraps?: number
  disabled?: boolean
  bootoutCode?: number
}

/** launchd's gui/<uid> domain as far as the lifecycle can see it. */
export function fakeLaunchd(options: LaunchdOptions = {}) {
  const state = { loaded: options.loaded ?? false, running: options.running ?? false }
  let failedBootstraps = options.failedBootstraps ?? 0
  const calls: string[][] = []
  const specs: ProcessSpec[] = []
  const launchctl = (args: readonly string[]): ProcessResult => {
    const [verb, target] = args
    if (verb === 'print-disabled') {
      const ours =
        options.disabled === undefined
          ? ''
          : `\t\t"${LABEL}" => ${options.disabled ? 'disabled' : 'enabled'}\n`
      return result(0, `disabled services = {\n\t\t"com.docker.helper" => enabled\n${ours}\t}\n`)
    }
    if (verb === 'bootout') {
      const was = state.loaded
      state.loaded = false
      state.running = false
      if (options.bootoutCode !== undefined) {
        return result(options.bootoutCode, '', `Boot-out failed: ${options.bootoutCode}`)
      }
      return was ? result(0) : result(113, '', 'Boot-out failed: 113: Could not find service')
    }
    if (verb === 'bootstrap') {
      if (failedBootstraps > 0) {
        failedBootstraps--
        return result(5, '', 'Bootstrap failed: 5: Input/output error')
      }
      if (state.loaded) {
        return result(5, '', 'Bootstrap failed: 5: Input/output error')
      }
      state.loaded = true
      state.running = true
      return result(0)
    }
    if (verb === 'print') {
      return state.loaded && target === `gui/${UID}/${LABEL}`
        ? result(
            0,
            `${target} = {\n\tstate = ${state.running ? 'running' : 'not running'}\n${state.running ? '\tpid = 4242\n' : ''}}\n`
          )
        : result(113, '', `Could not find service "${LABEL}" in domain for user gui: ${UID}`)
    }
    if (verb === 'kickstart') {
      state.running = state.loaded
      return state.loaded ? result(0) : result(113)
    }
    return result(64)
  }
  const run = async (spec: ProcessSpec): Promise<ProcessResult> => {
    if (spec.program === '/bin/launchctl') {
      const args = [...(spec.args ?? [])]
      calls.push(args)
      specs.push(spec)
      return launchctl(args)
    }
    return runProcess(spec)
  }
  /** What changed launchd: everything but the read-only `print` and `print-disabled`. */
  const writes = (): string[][] =>
    calls.filter(([verb]) => verb !== 'print' && verb !== 'print-disabled')
  return { run, calls, specs, state, writes }
}

export async function helperVersion(path: string): Promise<string> {
  return (await runProcess({ program: path, args: ['version'] })).stdout.trim()
}
