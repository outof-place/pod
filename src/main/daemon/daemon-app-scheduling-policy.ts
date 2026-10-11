import { existsSync } from 'node:fs'

const TASKPOLICY_PATH = '/usr/sbin/taskpolicy'

export type DaemonAppPolicyLaunch = { program: string; args: string[] }

/**
 * Pod: on macOS the daemon starts through `taskpolicy -a`, the scheduling policy macOS gives
 * applications (base priority 46 instead of 31). Every keystroke and every echo passes through the
 * daemon; at the default priority its wakeups wait behind other default work on a loaded machine.
 * taskpolicy execs in place, so the pid and the IPC channel are the daemon's own; the policy survives
 * that exec and is not inherited by forks, so PTY children (login, shells, their jobs) start at the
 * default again. Kill switch: POD_DAEMON_APP_POLICY=0.
 *
 * Electron only: `process.helperExecPath` is the Helper executable `fork()` would run.
 */
export function daemonAppPolicyLaunch(
  modulePath: string,
  args: string[],
  relocatedExecPath?: string
): DaemonAppPolicyLaunch | null {
  if (process.platform !== 'darwin' || process.env.POD_DAEMON_APP_POLICY === '0') {
    return null
  }
  // Why the relocated executable first: a daemon forked from its daemon-host clone must run the
  // clone's image, or it and every addon it loads come from the bundle an update deletes.
  const executable: unknown =
    relocatedExecPath ?? Object.getOwnPropertyDescriptor(process, 'helperExecPath')?.value
  if (typeof executable !== 'string' || !existsSync(TASKPOLICY_PATH)) {
    return null
  }
  return { program: TASKPOLICY_PATH, args: ['-a', executable, modulePath, ...args] }
}
