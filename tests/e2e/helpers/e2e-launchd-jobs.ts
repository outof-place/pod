// Fork-only (Pod): an E2E profile's daemon may run as a launchd job (POD_DAEMON_LAUNCHD=1). One
// killed with SIGKILL can't boot out its own job, which then stays loaded in the developer's
// gui/<uid>; teardown boots out every job of the profile and fails if one is left.
import { execFileSync } from 'node:child_process'
import {
  daemonLaunchdLabelPrefix,
  parseDaemonLaunchdList
} from '../../../src/main/daemon/daemon-launchd-jobs-darwin'

const LAUNCHCTL = '/bin/launchctl'

function profileJobs(prefix: string): string[] {
  const listed = execFileSync(LAUNCHCTL, ['list'], { encoding: 'utf8', timeout: 10_000 })
  return parseDaemonLaunchdList(listed, prefix).map((job) => job.label)
}

export function bootoutE2ELaunchdJobs(userDataDir: string): void {
  if (process.platform !== 'darwin') {
    return
  }
  // Why before the profile is deleted: the prefix hashes the profile's real path.
  const prefix = daemonLaunchdLabelPrefix(userDataDir)
  for (const label of profileJobs(prefix)) {
    try {
      execFileSync(LAUNCHCTL, ['bootout', `gui/${process.getuid?.()}/${label}`], {
        stdio: 'ignore',
        timeout: 15_000
      })
    } catch {
      // Gone already; the check below decides.
    }
  }
  const left = profileJobs(prefix)
  if (left.length > 0) {
    throw new Error(
      `E2E left ${left.length} launchd job(s) of its profile loaded: ${left.join(', ')}`
    )
  }
}
