import { forkProcess, type ForkSpec } from '@orca/process-host/fork-process'
import { spawnProcess } from '@orca/process-host'
import type { SpawnedProcess } from '@orca/process-host/process-spec'
import { getAppEnvironment } from '../../shared/app-environment'
import { removeChromiumDisabledSessionBus } from '../pty/chromium-session-bus-env'
import { daemonAppPolicyLaunch, type DaemonProgramLaunch } from './daemon-app-scheduling-policy'
import { buildDurableDaemonScopeCommand } from './daemon-cgroup-scope'
import { daemonLogArgs } from './daemon-launch-paths'
import { disclaimedDaemonLaunch } from './daemon-responsibility-darwin'
import { podLaneDaemonEnv } from './pod-lane/pod-lane-daemon-env'

export type DaemonChildSpawnOptions = {
  entryPath: string
  forkEntryPath: string
  relocatedExecPath?: string
  userDataPath: string
  socketPath: string
  tokenPath: string
  pidPath: string
  launchNonce: string
  macosLoginSessionWatch: boolean
  /** Pod: a GUI session's daemon on macOS, responsible for itself (daemon-responsibility-darwin.ts). */
  macosDisclaimResponsibility: boolean
  /** Defaults to 10 s; a cold first exec on Windows can need longer. */
  startupTimeoutMs?: number
}

export function buildDaemonScriptArgs(
  options: DaemonChildSpawnOptions,
  spawnerExecPath: string = process.execPath
): string[] {
  const { socketPath, tokenPath, pidPath, launchNonce, entryPath, macosLoginSessionWatch } = options
  return [
    '--socket',
    socketPath,
    '--token',
    tokenPath,
    '--pid-record',
    pidPath,
    '--launch-nonce',
    launchNonce,
    '--entry-path',
    entryPath,
    '--app-version',
    getAppEnvironment().getVersion(),
    '--spawner-exec-path',
    spawnerExecPath,
    ...(macosLoginSessionWatch ? ['--login-session-watch'] : []),
    ...daemonLogArgs()
  ]
}

/** The daemon's environment, and so every PTY's. */
export function buildDaemonChildEnv(
  options: Pick<DaemonChildSpawnOptions, 'userDataPath' | 'relocatedExecPath'>
): NodeJS.ProcessEnv {
  // Why: run as plain Node so Electron's GPU/display init can't interfere with node-pty's posix_spawn of the spawn-helper.
  const daemonEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    // Why: the detached plain-Node daemon has no AppEnvironment, but shell rcfiles must live outside swept tmp.
    ORCA_USER_DATA_PATH: options.userDataPath,
    // Pod: the direct terminal lane's peer check.
    ...podLaneDaemonEnv(options.relocatedExecPath)
  }
  // Why: this env becomes the daemon's, and so every PTY's (#21119).
  removeChromiumDisabledSessionBus(daemonEnv)
  return daemonEnv
}

/**
 * Pod: on macOS the same command line under the app scheduling policy and, for a GUI session's
 * daemon, responsible for itself. Both exec in place, so the pid and the IPC channel stay its own.
 */
function darwinDaemonLaunch(
  options: DaemonChildSpawnOptions,
  scriptArgs: string[]
): DaemonProgramLaunch | null {
  const { forkEntryPath, relocatedExecPath } = options
  const disclaimed = options.macosDisclaimResponsibility
    ? disclaimedDaemonLaunch(forkEntryPath, scriptArgs, relocatedExecPath)
    : null
  return disclaimed ?? daemonAppPolicyLaunch(forkEntryPath, scriptArgs, relocatedExecPath)
}

/**
 * Starts the daemon's OS process: `fork()`; on macOS the same command line behind `taskpolicy` and,
 * for a GUI session's daemon, `pod-agent-launcher --disclaim-exec`; or (`useDurableScope`) wrapped
 * in `systemd-run --user --scope` so it lands in a sibling cgroup (daemon-cgroup-scope.ts). All go
 * through `@orca/process-host`, take the same `'ipc'` stdio contract and exec in place, so the
 * readiness handshake is unchanged. Do not read the daemon's PID off the returned child; the daemon
 * reports its own (see daemon-ready-identity.ts).
 */
export function spawnDaemonChildProcess(
  options: DaemonChildSpawnOptions,
  useDurableScope: boolean
): SpawnedProcess {
  const { forkEntryPath, relocatedExecPath, userDataPath, launchNonce } = options
  const scriptArgs = buildDaemonScriptArgs(options)
  const daemonEnv = buildDaemonChildEnv(options)
  // Why cwd: detached daemons outlive dev worktrees; userData keeps process.cwd() valid after a repo/worktree is deleted.
  // Why detached/stdio: detached+unref outlives Electron; stdout 'ignore' (else blocks exit), stderr 'pipe' captures startup crashes lost in v1.4.129-rc.1.
  const childOptions: Pick<ForkSpec, 'cwd' | 'detached' | 'stdio'> = {
    cwd: userDataPath,
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc']
  }
  const darwinLaunch = useDurableScope ? null : darwinDaemonLaunch(options, scriptArgs)
  if (darwinLaunch) {
    return spawnProcess({ ...childOptions, ...darwinLaunch, env: daemonEnv })
  }
  if (!useDurableScope) {
    return forkProcess({
      ...childOptions,
      modulePath: forkEntryPath,
      args: scriptArgs,
      // Why: run the byte-identical relocated Orca.exe so the image path sits outside the updater's kill zone.
      ...(relocatedExecPath ? { execPath: relocatedExecPath } : {}),
      env: daemonEnv
    })
  }
  const scoped = buildDurableDaemonScopeCommand(
    relocatedExecPath ?? process.execPath,
    [forkEntryPath, ...scriptArgs, '--fresh-daemon-scope'],
    launchNonce,
    daemonEnv
  )
  return spawnProcess({
    ...childOptions,
    program: scoped.command,
    args: scoped.args,
    env: scoped.env
  })
}
