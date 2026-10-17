// One runtime of the two-process build race (sim-app-builds-race.test.ts), bundled by esbuild and
// run by plain node. argv: <POD_SIM_HOME> <worktree root> <build command> <start, epoch ms>
// At `start` it asks for the client of fingerprint f00d, then waits for the build to end and prints
// what it was answered.
import { simRunProcess } from '../../adapters/sim-command-run'
import { simPodHome } from '../../adapters/sim-pod-home'
import { createSimProcessFacts } from '../../adapters/sim-process-facts'
import { createSimBuilds } from '../sim-app-builds'
import { createSimClientCache } from '../sim-app-clients'
import { simAppHome } from '../sim-app-paths'
import { createSimProcessControl, simSpawnDetached } from '../sim-app-spawn'

const [homePath, worktreeRoot, command, startAt] = process.argv.slice(2)

async function main(): Promise<void> {
  const home = simAppHome(simPodHome({ POD_SIM_HOME: homePath }))
  const processes = createSimProcessFacts()
  const start = await processes.startOf(process.pid)
  if (start === 'unknown' || !start.found) {
    throw new Error('no start')
  }
  const builds = createSimBuilds({
    home,
    clients: createSimClientCache({ home, run: simRunProcess, userHome: homePath }),
    spawn: simSpawnDetached,
    control: createSimProcessControl(processes),
    self: { pid: process.pid, startedAt: start.startedAt, profile: `race-${process.pid}` },
    runtimeState: async () => 'live',
    claudeAcc: null
  })
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(startAt) - Date.now())))
  const answer = await builds.ensure({
    appId: 'app',
    app: {
      bundleId: 'com.example.podsim',
      path: 'apps/app',
      build: { command, output: 'build/*.app' }
    },
    fingerprint: 'f00d',
    worktreeRoot
  })
  if (answer.state !== 'building') {
    throw new Error(`answered ${answer.state}`)
  }
  for (;;) {
    await builds.check()
    const now = await builds.get(answer.build.buildId)
    if (now && now.state !== 'building') {
      process.stdout.write(
        JSON.stringify({ buildId: answer.build.buildId, started: answer.started, state: now.state })
      )
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

main().catch((error: unknown) => {
  process.stderr.write(String(error))
  process.exitCode = 1
})
