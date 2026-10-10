import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * claude-acc's launchd jobs and its menu helper as SMAppService services of Pod.app: each job is
 * Contents/Library/LaunchAgents/<appId>.acc.<job>.plist (its BundleProgram is the payload's
 * pod-acc-run), the helper is Contents/Library/LoginItems/Pod Menu.app. launchd lists them under
 * Pod in Login Items and runs them from the app, instead of plists in ~/Library/LaunchAgents.
 */

// Keeps the bundle id ClaudeAcc had, so its Microphone and Accessibility grants stay valid.
export const ACC_MENU_HELPER_ID = 'com.filip.claude-acc.menubar'
export const ACC_MENU_HELPER_APP = 'Pod Menu.app'

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

function electronType(service: AccService): 'agentService' | 'loginItemService' {
  return service.kind === 'agent' ? 'agentService' : 'loginItemService'
}

/** The services this Pod.app carries: payloads before pod-acc-run ship none. */
export function bundledAccServices(appPath: string, appId: string): AccService[] {
  const agentsDir = join(appPath, 'Contents', 'Library', 'LaunchAgents')
  const prefix = `${appId}.acc.`
  const agents: AccService[] = existsSync(agentsDir)
    ? readdirSync(agentsDir)
        .filter((name) => name.startsWith(prefix) && name.endsWith('.plist'))
        .sort()
        .map((serviceName) => ({ kind: 'agent', serviceName }))
    : []
  const helper = join(appPath, 'Contents', 'Library', 'LoginItems', ACC_MENU_HELPER_APP)
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

/**
 * Registers every service launchd does not run yet. One the user switched off in Login Items
 * reads requires-approval and is left alone: Pod asks, it does not override the user.
 */
export function ensureAccServices(api: LoginItemApi, services: AccService[]): AccServiceReport[] {
  return readAccServiceStatus(api, services).map((report) => {
    if (report.status === 'enabled' || report.status === 'requires-approval') {
      return report
    }
    const { service } = report
    api.setLoginItemSettings({
      openAtLogin: true,
      type: electronType(service),
      serviceName: service.serviceName
    })
    const [after] = readAccServiceStatus(api, [service])
    return { service, status: after.status, registered: true }
  })
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
