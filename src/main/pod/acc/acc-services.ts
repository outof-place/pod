import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ACC_MENU_HELPER_APP, ACC_STATE_DIR } from './acc-lifecycle'

/**
 * claude-acc's launchd jobs and its menu helper as SMAppService services of Pod.app: each job is
 * Contents/Library/LaunchAgents/<appId>.acc.<job>.plist (its BundleProgram is the payload's
 * pod-acc-run), the helper is Contents/Library/LoginItems/Pod Menu.app. launchd lists them under
 * Pod in Login Items and runs them from the app, instead of plists in ~/Library/LaunchAgents.
 * pod-rootd, the root helper, is none of them: the user installs it from its package (acc-rootd.ts).
 */

// Keeps the bundle id ClaudeAcc had, so its Microphone and Accessibility grants stay valid.
export const ACC_MENU_HELPER_ID = 'com.filip.claude-acc.menubar'

export type AccServiceStatus = Electron.LoginItemSettings['status']
export type AccService =
  | { kind: 'agent'; serviceName: string }
  | { kind: 'login-item'; serviceName: string }
export type LoginItemApi = Pick<Electron.App, 'getLoginItemSettings' | 'setLoginItemSettings'>

export type AccServiceReport = {
  service: AccService
  status: AccServiceStatus
  /** Set when this pass asked launchd to register it. */
  registered?: boolean
}

const ELECTRON_TYPES = {
  agent: 'agentService',
  'login-item': 'loginItemService'
} as const

function electronType(service: AccService): (typeof ELECTRON_TYPES)[AccService['kind']] {
  return ELECTRON_TYPES[service.kind]
}

function bundledPlists(dir: string, prefix: string): string[] {
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.startsWith(prefix) && name.endsWith('.plist'))
        .sort()
    : []
}

/** The services this Pod.app carries: payloads before pod-acc-run ship none. */
export function bundledAccServices(appPath: string, appId: string): AccService[] {
  const library = join(appPath, 'Contents', 'Library')
  const agents = bundledPlists(join(library, 'LaunchAgents'), `${appId}.acc.`).map(
    (serviceName): AccService => ({ kind: 'agent', serviceName })
  )
  const helper = join(library, 'LoginItems', ACC_MENU_HELPER_APP)
  return existsSync(helper)
    ? [...agents, { kind: 'login-item', serviceName: ACC_MENU_HELPER_ID }]
    : agents
}

export function readAccServiceStatus(
  api: LoginItemApi,
  services: AccService[]
): AccServiceReport[] {
  return services.map((service) => ({
    service,
    status: api.getLoginItemSettings({
      type: electronType(service),
      serviceName: service.serviceName
    }).status
  }))
}

function registerAccService(api: LoginItemApi, service: AccService): AccServiceReport {
  api.setLoginItemSettings({
    openAtLogin: true,
    type: electronType(service),
    serviceName: service.serviceName
  })
  const [after] = readAccServiceStatus(api, [service])
  return { service, status: after.status, registered: true }
}

/**
 * Registers every agent and login item launchd does not run yet. One the user switched off in
 * Login Items reads requires-approval and is left alone: Pod asks, it does not override the user.
 */
export function ensureAccServices(api: LoginItemApi, services: AccService[]): AccServiceReport[] {
  return readAccServiceStatus(api, services).map((report) =>
    report.status === 'enabled' || report.status === 'requires-approval'
      ? report
      : registerAccService(api, report.service)
  )
}

/** For handing claude-acc back or removing Pod: deleting Pod.app alone leaves its agents registered. */
export function removeAccServices(api: LoginItemApi, services: AccService[]): AccServiceReport[] {
  for (const service of services) {
    api.setLoginItemSettings({
      openAtLogin: false,
      type: electronType(service),
      serviceName: service.serviceName
    })
  }
  return readAccServiceStatus(api, services)
}

/** $STATE/pod-services.json: what Pod registered, read by every native acc surface through AccKit. */
export const ACC_SERVICES_REPORT = 'pod-services.json'

function entry({ service, status }: AccServiceReport) {
  return { kind: service.kind, name: service.serviceName, status }
}

export function writeAccServicesReport(
  home: string,
  report: {
    app: string
    payload: string | null
    services: AccServiceReport[]
    at: Date
    /** pod-rootd, while Pod ships its package and owns claude-acc. */
    rootd?: { name: string; status: AccServiceStatus } | null
    rootdRequest?: { at: number; outcome: string; step?: string } | null
  }
): void {
  const dir = join(home, ACC_STATE_DIR)
  mkdirSync(dir, { recursive: true })
  const body = {
    version: 1,
    at: report.at.toISOString(),
    app: report.app,
    payload: report.payload,
    services: report.services.map(entry),
    // a key of its own: AccKit before 0.4.0 fails on an unknown kind in services
    daemons: report.rootd ? [{ kind: 'daemon', ...report.rootd }] : [],
    // the last root helper request from the panel, so it stops waiting (acc-rootd.ts)
    ...(report.rootdRequest ? { rootdRequest: report.rootdRequest } : {})
  }
  const path = join(dir, ACC_SERVICES_REPORT)
  // readers poll this file: never let one see half of it
  writeFileSync(`${path}.tmp`, `${JSON.stringify(body, null, 2)}\n`)
  renameSync(`${path}.tmp`, path)
}
