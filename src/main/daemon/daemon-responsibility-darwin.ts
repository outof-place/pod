// Fork-only (Pod): macOS attributes a process and its children to a responsible process (TCC grants,
// the Developer Tools exemption), and the daemon outlives the app process that forked it. So a GUI
// session's daemon starts through `pod-agent-launcher --disclaim-exec` (disclaim-exec.swift) and
// answers for itself. Kill switch: POD_DAEMON_DISCLAIM=0.
import {
  findPodAgentLauncher,
  POD_AGENT_LAUNCHER_FILE_NAME
} from '../pod/agent-hook/pod-agent-launcher-path'
import { daemonAppPolicyLaunch, type DaemonProgramLaunch } from './daemon-app-scheduling-policy'
import { daemonImageResourcesPath } from './daemon-image-resources'

const DISCLAIM_EXEC_ARG = '--disclaim-exec'
/** How the launcher's one line starts when it could not disclaim (disclaim-exec.swift). */
const LAUNCHER_NOTICE_PREFIX = `${POD_AGENT_LAUNCHER_FILE_NAME}: `

let reportedMissingLauncher = false

/**
 * The daemon's command line behind the launcher: `launcher --disclaim-exec [taskpolicy -a] <exe>
 * <entry> args`. Null keeps today's launch: off macOS, switched off, outside Electron without a
 * relocated executable, or without the launcher (logged once).
 */
export function disclaimedDaemonLaunch(
  modulePath: string,
  args: string[],
  relocatedExecPath?: string
): DaemonProgramLaunch | null {
  if (process.platform !== 'darwin' || process.env.POD_DAEMON_DISCLAIM === '0') {
    return null
  }
  // Why the app's executable and not its Helper: the daemon becomes its own responsible process,
  // so it must carry the identity TCC and Developer Tools know, codes.pod.app (the Helper is .helper).
  const executable =
    relocatedExecPath ?? (typeof process.versions.electron === 'string' ? process.execPath : null)
  if (!executable) {
    return null
  }
  const launcher = findPodAgentLauncher(
    daemonImageResourcesPath(relocatedExecPath),
    process.env.POD_AGENT_LAUNCHER_BINARY
  )
  if (!launcher) {
    if (!reportedMissingLauncher) {
      reportedMissingLauncher = true
      console.warn(
        `[daemon] no ${POD_AGENT_LAUNCHER_FILE_NAME}; the terminal daemon stays attributed to this app process (TCC grants, Developer Tools)`
      )
    }
    return null
  }
  const command = daemonAppPolicyLaunch(modulePath, args, executable) ?? {
    program: executable,
    args: [modulePath, ...args]
  }
  return { program: launcher, args: [DISCLAIM_EXEC_ARG, command.program, ...command.args] }
}

/** A started daemon's startup stderr: the launcher's line when it could not disclaim, logged. */
export function reportDaemonDisclaimFallback(startupStderr: string): void {
  const notice = startupStderr.split('\n').find((line) => line.startsWith(LAUNCHER_NOTICE_PREFIX))
  if (notice) {
    console.warn(`[daemon] ${notice}`)
  }
}
