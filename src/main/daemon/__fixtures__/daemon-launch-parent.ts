// Stands in for Pod main in daemon-responsibility-darwin.live-daemon.test.ts: launches a terminal
// daemon through the real launch path, prints its pids as one JSON line, and lives until killed.
//   daemon-launch-parent.ts <userData> <daemon-entry> <disclaim 0|1> [<dylib for the daemon>]
import { join } from 'node:path'
import { setAppEnvironment } from '../../../shared/app-environment'
import { launchDaemonChild } from '../daemon-launched-child'

async function main(): Promise<void> {
  const [userDataPath, entryPath, disclaim, daemonDylib] = process.argv.slice(2)
  if (!userDataPath || !entryPath) {
    throw new Error('usage: daemon-launch-parent.ts <userData> <daemon-entry> <0|1> [dylib]')
  }
  setAppEnvironment({
    getPath: (name) => join(userDataPath, name),
    getAppPath: () => userDataPath,
    getVersion: () => '0.0.0-responsibility-test',
    isPackaged: () => false,
    onWillQuit: () => {},
    exit: (code) => process.exit(code),
    getAppMetrics: () => []
  })
  if (daemonDylib) {
    // The daemon's env is this process's (buildDaemonChildEnv), so the launcher loads it.
    process.env.DYLD_INSERT_LIBRARIES = daemonDylib
  }
  const launched = await launchDaemonChild({
    entryPath,
    forkEntryPath: entryPath,
    // Plain Node runs the TypeScript entry (NODE_OPTIONS carries tsx), in the clone's place.
    relocatedExecPath: process.execPath,
    userDataPath,
    socketPath: join(userDataPath, 'd.sock'),
    tokenPath: join(userDataPath, 'd.token'),
    pidPath: join(userDataPath, 'd.pid'),
    launchNonce: 'responsibility-test',
    macosLoginSessionWatch: false,
    macosDisclaimResponsibility: disclaim === '1',
    // Why: tsx compiles the entry's graph on a cold start, slower than a built daemon.
    startupTimeoutMs: 60_000
  })
  // childPid is what the launch spawned: it equals daemonPid only if every exec kept the pid.
  process.stdout.write(
    `${JSON.stringify({ daemonPid: launched.identity.pid, childPid: launched.child.pid })}\n`
  )
  setInterval(() => {}, 60_000)
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  )
  process.exit(1)
})
