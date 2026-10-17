// dev-install.sh's second half: Pod's install lifecycle with this checkout's build as the bundled
// helper, so a dev install takes exactly the path a Pod launch takes. Run through tsx, never by Pod.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { userInfo } from 'node:os'
import { runProcess } from '@orca/process-host'
import { runPodGoCacheLifecycle } from '../../../src/main/pod/gocache/pod-gocache-lifecycle'
import { podGoCacheLaunchAgentPlist } from '../../../src/main/pod/gocache/pod-gocache-launch-agent'
import {
  POD_GOCACHE_LABEL,
  podGoCacheHelperPath,
  podGoCacheLaunchAgentPath
} from '../../../src/main/pod/gocache/pod-gocache-paths'

type Flags = { dryRun: boolean; force: boolean }

function productBundleId(): string | null {
  const identity: unknown = JSON.parse(
    readFileSync(join(__dirname, '../../../product/identity.json'), 'utf8')
  )
  const appId: unknown = Reflect.get(Object(identity), 'appId')
  return typeof appId === 'string' ? appId : null
}

async function main(helper: string, home: string, uid: number, flags: Flags): Promise<number> {
  // Pod's default-profile rule has nothing to say about a script: one path for both.
  const profile = join(home, 'Library', 'Application Support', 'Pod')
  const bundleId = productBundleId()
  const outcome = await runPodGoCacheLifecycle(
    {
      platform: process.platform,
      home,
      accountHome: userInfo().homedir,
      userDataPath: profile,
      defaultUserDataPath: profile,
      bundledHelper: helper,
      uid,
      bundleId,
      appPath: 'native/pod-gocache-macos/scripts/dev-install.sh',
      mode: flags.dryRun ? 'dry-run' : undefined,
      settingEnabled: true,
      automatedBy: null,
      // this shell's environment is the user's terminal one
      goEnv: process.env,
      force: flags.force
    },
    (spec) => runProcess(spec, 'tail')
  )
  console.log(JSON.stringify(outcome, null, 2))
  const { decision } = outcome
  if (flags.dryRun && decision.action === 'install') {
    const plist = podGoCacheLaunchAgentPath(home)
    console.log('would:')
    if (decision.replaceHelper) {
      console.log(
        `  copy ${helper} -> ${podGoCacheHelperPath(home)} (temp file, version check, rename)`
      )
    }
    console.log(`  write ${plist}`)
    console.log(`  launchctl bootout gui/${uid}/${POD_GOCACHE_LABEL}`)
    console.log(`  launchctl bootstrap gui/${uid} ${plist}`)
    console.log(`\n${podGoCacheLaunchAgentPlist(home, bundleId, decision.cacheDir)}`)
  }
  return outcome.status === 'failed' || outcome.status === 'refused' ? 1 : 0
}

const [helper, ...rest] = process.argv.slice(2)
const uid = process.getuid?.()
if (!helper || !process.env.HOME || uid === undefined) {
  console.error('usage: dev-install-lifecycle.ts <built pod-gocache> [--dry-run] [--force]')
  process.exit(64)
}
void main(helper, process.env.HOME, uid, {
  dryRun: rest.includes('--dry-run'),
  force: rest.includes('--force')
}).then((code) => process.exit(code))
