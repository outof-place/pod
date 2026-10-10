import { dirname, join } from 'node:path'
import type { ProcessResult, ProcessSpec } from '@orca/process-host/process-spec'
import type { PodClaudeAccConfig } from '../pod-distro-config'
import { automatedLaunchEnv, runAccLifecycle, type AccLifecycleOutcome } from './acc-lifecycle'
import { isAccMenuHelperRunning } from './acc-menu-helper'

// The helper starts and quits on its own (login item, setup restarting it): look again this often.
const HELPER_PROBE_MS = 30_000

export type PodAccSupervisorOptions = {
  config: PodClaudeAccConfig
  resourcesPath: string
  /** process.execPath of the running app: …/Pod.app/Contents/MacOS/Pod. */
  execPath: string
  home: string
  /** os.userInfo().homedir: the account's home from getpwuid, never $HOME. */
  accountHome: string | null
  userDataPath: string
  /** The product's default profile in accountHome; null for builds without a product identity. */
  defaultUserDataPath: string | null
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  run: (spec: ProcessSpec) => Promise<ProcessResult>
  /** Tells the tray whether the claude-acc menu helper is up, and re-applies the tray. */
  setTrayYield: (helperRunning: () => boolean) => void
  syncTray: () => void
  log: (message: string) => void
}

/** `/Applications/Pod.app/Contents/MacOS/Pod` → `/Applications/Pod.app`. */
export function appBundlePath(execPath: string): string {
  return dirname(dirname(dirname(execPath)))
}

function describe(outcome: AccLifecycleOutcome): string {
  const d = outcome.decision
  switch (outcome.status) {
    case 'skipped':
      return `claude-acc: skipped (${d.action === 'skip' ? d.reason : ''})`
    case 'up-to-date':
      return `claude-acc: ${d.action === 'up-to-date' ? d.version : ''} is installed`
    case 'busy':
      return 'claude-acc: another Pod is running setup'
    case 'refused':
      return `claude-acc: setup refused: ${outcome.message}`
    case 'dry-run':
      return `claude-acc: would run ${[outcome.spec.program, ...(outcome.spec.args ?? [])].join(' ')}`
    case 'installed':
    case 'failed':
      return `claude-acc: setup ${outcome.status} (${d.action === 'install' ? `${d.reason} → ${d.version}` : ''}, exit ${outcome.result.code}${outcome.result.timedOut ? ', timed out' : ''}): ${outcome.message}`
  }
}

/** Installs or updates claude-acc from the payload, then keeps Pod's tray out of the helper's way. */
export function startPodAccSupervisor(options: PodAccSupervisorOptions): {
  stop: () => void
  lifecycle: Promise<AccLifecycleOutcome>
} {
  const lifecycle = runAccLifecycle(
    {
      platform: options.platform,
      home: options.home,
      accountHome: options.accountHome,
      userDataPath: options.userDataPath,
      defaultUserDataPath: options.defaultUserDataPath,
      payloadDir: join(options.resourcesPath, options.config.payload),
      appPath: appBundlePath(options.execPath),
      mode: options.env.POD_ACC_LIFECYCLE,
      automatedBy: automatedLaunchEnv(options.env)
    },
    options.run
  ).then((outcome) => {
    options.log(describe(outcome))
    return outcome
  })
  let helperRunning = false
  let stopped = false
  options.setTrayYield(() => helperRunning)
  const probe = async (): Promise<void> => {
    const running = await isAccMenuHelperRunning(options.run)
    if (!stopped && running !== helperRunning) {
      helperRunning = running
      options.syncTray()
    }
  }
  void probe()
  const timer =
    options.platform === 'darwin' ? setInterval(() => void probe(), HELPER_PROBE_MS) : null
  timer?.unref?.()
  // after setup restarted the helper, look at once instead of waiting a whole probe interval
  void lifecycle.then(() => probe())
  return {
    lifecycle,
    stop: () => {
      stopped = true
      if (timer) {
        clearInterval(timer)
      }
    }
  }
}
