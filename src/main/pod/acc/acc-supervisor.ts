import { existsSync, watch, type FSWatcher } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ProcessResult, ProcessSpec } from '../../../shared/child-process/run-process'
import type { PodClaudeAccConfig } from '../pod-distro-config'
import {
  ACC_MENU_HELPER_APP,
  ACC_STATE_DIR,
  automatedLaunchEnv,
  readOwnerRecord,
  runAccLifecycle,
  type AccLifecycleOutcome
} from './acc-lifecycle'
import {
  bundledAccServices,
  ensureAccServices,
  readAccServiceStatus,
  removeAccServices,
  writeAccServicesReport,
  type AccServiceReport,
  type LoginItemApi
} from './acc-services'
import { isAccMenuHelperRunning, restartAccMenuHelper } from './acc-menu-helper'
import {
  ACC_ROOTD_PACKAGE,
  ACC_ROOTD_REQUEST,
  ACC_ROOTD_STEP_STATUS,
  accRootdServiceName,
  answerAccRootdRequest,
  readAccRootdStep,
  takeAccRootdRequest,
  type AccRootdAnswerTools,
  type AccRootdRequestOutcome,
  type AccRootdStep
} from './acc-rootd'

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
  /** Electron's SMAppService bridge and the product's appId, which prefixes the agent plists. */
  loginItems: LoginItemApi | null
  appId: string | null
  /** Tells the tray whether the claude-acc menu helper is up, and re-applies the tray. */
  setTrayYield: (helperRunning: () => boolean) => void
  syncTray: () => void
  log: (message: string) => void
  /** How often to look at the menu helper and owner.json; tests shorten it. */
  probeMs?: number
  now?: () => Date
  /** Pod's own yes before Installer or Login Items opens; without one, a request is declined. */
  confirmRootd?: AccRootdAnswerTools['confirm']
  openPath?: AccRootdAnswerTools['openPath']
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
  services: Promise<AccServiceReport[]>
} {
  const payloadDir = join(options.resourcesPath, options.config.payload)
  const lifecycle = runAccLifecycle(
    {
      platform: options.platform,
      home: options.home,
      accountHome: options.accountHome,
      userDataPath: options.userDataPath,
      defaultUserDataPath: options.defaultUserDataPath,
      payloadDir,
      appPath: appBundlePath(options.execPath),
      mode: options.env.POD_ACC_LIFECYCLE,
      automatedBy: automatedLaunchEnv(options.env)
    },
    options.run
  ).then((outcome) => {
    options.log(describe(outcome))
    return outcome
  })
  const appPath = appBundlePath(options.execPath)
  // Ensured this session: a later handback (owner.json naming another owner) removes them again.
  let servicesOwned = false
  let payloadVersion: string | null = null
  let rootdRequest: AccRootdRequestOutcome | null = null
  // pod-rootd is the user's to install or switch off, outside Pod: each probe asks pod-rootctl again
  const rootdPackage = join(payloadDir, ACC_ROOTD_PACKAGE)
  let rootdStep: AccRootdStep | null = null
  const readRootdStep = (): Promise<AccRootdStep | null> =>
    existsSync(rootdPackage) ? readAccRootdStep(options.run, payloadDir) : Promise.resolve(null)
  const rootdEntry = () =>
    servicesOwned && options.appId && existsSync(rootdPackage)
      ? {
          name: accRootdServiceName(options.appId),
          status: rootdStep ? ACC_ROOTD_STEP_STATUS[rootdStep] : ('not-found' as const)
        }
      : null
  const publishReport = (reports: AccServiceReport[]): AccServiceReport[] => {
    for (const r of reports) {
      if (r.registered || r.status !== 'enabled') {
        options.log(`claude-acc: ${r.service.serviceName} ${r.status}`)
      }
    }
    writeAccServicesReport(options.home, {
      app: appPath,
      payload: payloadVersion,
      services: reports,
      at: new Date(),
      rootd: rootdEntry(),
      rootdRequest
    })
    return reports
  }
  const republish = (): void => {
    const { loginItems, appId } = options
    if (loginItems && appId) {
      publishReport(readAccServiceStatus(loginItems, bundledAccServices(appPath, appId)))
    }
  }
  const ensureServices = (payload: string): AccServiceReport[] => {
    const { loginItems, appId } = options
    if (!loginItems || !appId) {
      return []
    }
    servicesOwned = true
    payloadVersion = payload
    return publishReport(ensureAccServices(loginItems, bundledAccServices(appPath, appId)))
  }
  const removeServices = async (): Promise<AccServiceReport[]> => {
    const { loginItems, appId } = options
    if (!loginItems || !appId) {
      return []
    }
    servicesOwned = false
    payloadVersion = null
    // pod-rootd stays: the user installed it, and only its own uninstall removes it (tier B, never Pod's)
    const bundled = bundledAccServices(appPath, appId)
    removeAccServices(loginItems, bundled)
    return publishReport(readAccServiceStatus(loginItems, bundled))
  }
  // Only once setup.sh made this account Pod's: every lifecycle guard applies to launchd too.
  const services = lifecycle.then(async (outcome) => {
    const d = outcome.decision
    if (d.action === 'skip') {
      // handed back: launchd would otherwise keep running Pod's copies next to the new owner's jobs
      return d.reason === 'handed-back' ? removeServices() : []
    }
    const owned = outcome.status === 'installed' || outcome.status === 'up-to-date'
    if (!owned) {
      return []
    }
    rootdStep = await readRootdStep()
    const reports = ensureServices(d.version)
    // setup.sh just installed a new payload: a helper launchd already ran keeps the old binary
    const helper = reports.find((report) => report.service.kind === 'login-item')
    if (outcome.status === 'installed' && helper?.status === 'enabled' && !helper.registered) {
      await restartAccMenuHelper(
        options.run,
        join(appPath, 'Contents', 'Library', 'LoginItems', ACC_MENU_HELPER_APP)
      )
      options.log('claude-acc: restarted the menu helper on the new payload')
    }
    return reports
  })
  let stopped = false
  const refreshRootd = async (): Promise<void> => {
    const step = servicesOwned ? await readRootdStep() : null
    if (servicesOwned && step !== rootdStep) {
      rootdStep = step
      republish()
    }
  }
  // AccServicesView's "Enable root helper…" leaves a request in $STATE: the only way to it
  let requestWatcher: FSWatcher | null = null
  let requestBusy = false
  const takeRootdRequest = async (): Promise<void> => {
    if (requestBusy || !servicesOwned) {
      return
    }
    requestBusy = true
    try {
      const request = takeAccRootdRequest(options.home, options.now?.() ?? new Date())
      if (!request) {
        return
      }
      if (!request.ok) {
        options.log(`claude-acc: ignored a pod-rootd request (${request.reason})`)
        return
      }
      options.log('claude-acc: pod-rootd requested in the panel')
      const answer = existsSync(rootdPackage)
        ? await answerAccRootdRequest({
            run: options.run,
            payloadDir,
            confirm: options.confirmRootd,
            openPath: options.openPath
          })
        : { outcome: 'unavailable' as const }
      rootdRequest = { at: request.at, ...answer }
      options.log(
        `claude-acc: pod-rootd request ${answer.outcome}${answer.step ? ` (${answer.step})` : ''}`
      )
      rootdStep = await readRootdStep()
      republish()
    } finally {
      requestBusy = false
    }
  }
  void services.then(() => {
    if (stopped || !servicesOwned || options.platform !== 'darwin') {
      return
    }
    try {
      requestWatcher = watch(join(options.home, ACC_STATE_DIR), (_event, name) => {
        if (name === ACC_ROOTD_REQUEST) {
          void takeRootdRequest()
        }
      })
      requestWatcher.on('error', () => requestWatcher?.close())
    } catch {
      // the probe still looks every interval
    }
    void takeRootdRequest()
  })
  let helperRunning = false
  options.setTrayYield(() => helperRunning)
  const probe = async (): Promise<void> => {
    const running = await isAccMenuHelperRunning(options.run)
    if (!stopped && running !== helperRunning) {
      helperRunning = running
      options.syncTray()
    }
    const owner = servicesOwned ? readOwnerRecord(options.home) : null
    if (!stopped && owner && owner.owner !== 'pod') {
      options.log(`claude-acc: handed to ${owner.owner}, removing Pod's services`)
      await removeServices()
    }
    if (!stopped) {
      await takeRootdRequest()
      await refreshRootd()
    }
  }
  void probe()
  const timer =
    options.platform === 'darwin'
      ? setInterval(() => void probe(), options.probeMs ?? HELPER_PROBE_MS)
      : null
  timer?.unref?.()
  // after setup restarted the helper, look at once instead of waiting a whole probe interval
  void lifecycle.then(() => probe())
  return {
    lifecycle,
    services,
    stop: () => {
      stopped = true
      requestWatcher?.close()
      if (timer) {
        clearInterval(timer)
      }
    }
  }
}
