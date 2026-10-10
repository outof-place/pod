import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ACC_MENU_HELPER_ID,
  bundledAccServices,
  ensureAccServices,
  removeAccServices,
  type AccServiceStatus,
  type LoginItemApi
} from './acc-services'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

/** A Pod.app whose bundle carries `agents` and, optionally, the menu helper. */
function podApp(agents: string[], helper = true): string {
  const root = mkdtempSync(join(tmpdir(), 'pod-acc-services-'))
  roots.push(root)
  const app = join(root, 'Pod.app')
  mkdirSync(join(app, 'Contents', 'Library', 'LaunchAgents'), { recursive: true })
  for (const name of agents) {
    writeFileSync(join(app, 'Contents', 'Library', 'LaunchAgents', name), '<plist/>')
  }
  if (helper) {
    mkdirSync(join(app, 'Contents', 'Library', 'LoginItems', 'Pod Menu.app'), { recursive: true })
  }
  return app
}

/** launchd as Electron reports it: `statuses` by serviceName, flipped to enabled on register. */
function fakeLaunchd(statuses: Record<string, AccServiceStatus>) {
  const set = vi.fn((settings: Electron.Settings) => {
    statuses[settings.serviceName ?? ''] = settings.openAtLogin ? 'enabled' : 'not-registered'
  })
  const api: LoginItemApi = {
    getLoginItemSettings: (options) => ({
      openAtLogin: statuses[options?.serviceName ?? ''] === 'enabled',
      openAsHidden: false,
      wasOpenedAtLogin: false,
      wasOpenedAsHidden: false,
      restoreState: false,
      status: statuses[options?.serviceName ?? ''] ?? 'not-found',
      executableWillLaunchAtLogin: false,
      launchItems: []
    }),
    setLoginItemSettings: set
  }
  return { api, set, statuses }
}

describe('claude-acc SMAppService services', () => {
  it("lists the bundle's own acc agents and the menu helper, nothing else", () => {
    const app = podApp([
      'codes.pod.app.acc.tick.plist',
      'codes.pod.app.acc.devguard.plist',
      'com.example.other.plist'
    ])
    expect(bundledAccServices(app, 'codes.pod.app')).toEqual([
      { kind: 'agent', serviceName: 'codes.pod.app.acc.devguard.plist' },
      { kind: 'agent', serviceName: 'codes.pod.app.acc.tick.plist' },
      { kind: 'login-item', serviceName: ACC_MENU_HELPER_ID }
    ])
  })

  it('finds nothing in a Pod.app whose payload predates pod-acc-run', () => {
    expect(bundledAccServices(podApp([], false), 'codes.pod.app')).toEqual([])
    expect(bundledAccServices('/nonexistent/Pod.app', 'codes.pod.app')).toEqual([])
  })

  it('registers what launchd lacks and leaves enabled and user-disabled services alone', () => {
    const { api, set } = fakeLaunchd({
      'codes.pod.app.acc.tick.plist': 'enabled',
      'codes.pod.app.acc.devguard.plist': 'requires-approval',
      'codes.pod.app.acc.janitor.plist': 'not-registered'
    })
    const reports = ensureAccServices(api, [
      { kind: 'agent', serviceName: 'codes.pod.app.acc.tick.plist' },
      { kind: 'agent', serviceName: 'codes.pod.app.acc.devguard.plist' },
      { kind: 'agent', serviceName: 'codes.pod.app.acc.janitor.plist' },
      { kind: 'login-item', serviceName: ACC_MENU_HELPER_ID }
    ])
    expect(reports.map((r) => [r.service.serviceName, r.status, r.registered ?? false])).toEqual([
      ['codes.pod.app.acc.tick.plist', 'enabled', false],
      ['codes.pod.app.acc.devguard.plist', 'requires-approval', false],
      ['codes.pod.app.acc.janitor.plist', 'enabled', true],
      [ACC_MENU_HELPER_ID, 'enabled', true]
    ])
    expect(set.mock.calls.map(([settings]) => settings)).toEqual([
      { openAtLogin: true, type: 'agentService', serviceName: 'codes.pod.app.acc.janitor.plist' },
      { openAtLogin: true, type: 'loginItemService', serviceName: ACC_MENU_HELPER_ID }
    ])
  })

  it('unregisters every service on removal', () => {
    const { api, set } = fakeLaunchd({ 'codes.pod.app.acc.tick.plist': 'enabled' })
    const reports = removeAccServices(api, [
      { kind: 'agent', serviceName: 'codes.pod.app.acc.tick.plist' }
    ])
    expect(set).toHaveBeenCalledWith({
      openAtLogin: false,
      type: 'agentService',
      serviceName: 'codes.pod.app.acc.tick.plist'
    })
    expect(reports[0].status).toBe('not-registered')
  })
})
