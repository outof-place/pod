import { existsSync } from 'node:fs'

const TASKPOLICY_PATH = '/usr/sbin/taskpolicy'

export type DaemonProgramLaunch = { program: string; args: string[] }

/**
 * Pod: on macOS the daemon starts through `taskpolicy -a`, the scheduling policy macOS gives
 * applications (base priority 46 instead of 31). Every keystroke and every echo passes through the
 * daemon; at the default priority its wakeups wait behind other default work on a loaded machine.
 * taskpolicy execs in place, so the pid and the IPC channel are the daemon's own; the policy survives
 * that exec and is not inherited by forks, so PTY children (login, shells, their jobs) start at the
 * default again. Kill switch: POD_DAEMON_APP_POLICY=0.
 *
 * `executable`: the daemon's image, a relocated one or (disclaimed) the app's own; else the Helper
 * `fork()` would run (Electron only: `process.helperExecPath`).
 */
export function daemonAppPolicyLaunch(
  modulePath: string,
  args: string[],
  executable?: string
): DaemonProgramLaunch | null {
  if (process.platform !== 'darwin' || process.env.POD_DAEMON_APP_POLICY === '0') {
    return null
  }
  const image = daemonNodeExecutable(executable)
  if (!image || !existsSync(TASKPOLICY_PATH)) {
    return null
  }
  return { program: TASKPOLICY_PATH, args: ['-a', image, modulePath, ...args] }
}

/** The executable a daemon runs as plain Node; null outside Electron. */
export function daemonNodeExecutable(executable?: string): string | null {
  // Why the given executable first: a daemon forked from its daemon-host clone must run the
  // clone's image, or it and every addon it loads come from the bundle an update deletes.
  const image: unknown =
    executable ?? Object.getOwnPropertyDescriptor(process, 'helperExecPath')?.value
  return typeof image === 'string' ? image : null
}
