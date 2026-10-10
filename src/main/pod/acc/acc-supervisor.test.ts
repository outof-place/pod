import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProcessResult, ProcessSpec } from '../../../shared/child-process/run-process'
import { ACC_STATE_DIR } from './acc-lifecycle'
import { ACC_SERVICES_REPORT, type LoginItemApi } from './acc-services'
import { appBundlePath, startPodAccSupervisor } from './acc-supervisor'

const ROOTD = 'codes.pod.app.rootd.plist'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

/** An installed Pod (payload 1.31.0, owner.json saying pod) whose bundle carries one agent. */
function installedPod(owner = 'pod', ownedVersion = '1.31.0', { rootd = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pod-acc-supervisor-'))
  roots.push(root)
  const app = join(root, 'Pod.app')
  const home = join(root, 'home')
  const payload = join(app, 'Contents', 'Resources', 'claude-acc')
  mkdirSync(payload, { recursive: true })
  writeFileSync(join(payload, 'VERSION'), '1.31.0\n')
  writeFileSync(join(payload, 'setup.sh'), '#!/bin/bash\n')
  mkdirSync(join(app, 'Contents', 'Library', 'LaunchAgents'), { recursive: true })
  writeFileSync(
    join(app, 'Contents', 'Library', 'LaunchAgents', 'codes.pod.app.acc.tick.plist'),
    ''
  )
  if (rootd) {
    mkdirSync(join(app, 'Contents', 'Library', 'LaunchDaemons'), { recursive: true })
    writeFileSync(join(app, 'Contents', 'Library', 'LaunchDaemons', ROOTD), '')
  }
  mkdirSync(join(home, ACC_STATE_DIR), { recursive: true })
  writeFileSync(
    join(home, ACC_STATE_DIR, 'owner.json'),
    JSON.stringify({ owner, version: ownedVersion, app })
  )
  const profile = join(home, 'Library/Application Support/Pod')
  return {
    resourcesPath: join(app, 'Contents', 'Resources'),
    execPath: join(app, 'Contents', 'MacOS', 'Pod'),
    home,
    accountHome: home,
    userDataPath: profile,
    defaultUserDataPath: profile
  }
}

function fakeLoginItems() {
  const set = vi.fn()
  const api: LoginItemApi = {
    getLoginItemSettings: () => ({
      openAtLogin: false,
      openAsHidden: false,
      wasOpenedAtLogin: false,
      wasOpenedAsHidden: false,
      restoreState: false,
      status: 'not-registered',
      executableWillLaunchAtLogin: false,
      launchItems: []
    }),
    setLoginItemSettings: set
  }
  return { api, set }
}

/** launchd as Electron reports it, by serviceName; `events` logs each (un)registration. */
function statefulLoginItems(
  statuses: Record<string, Electron.LoginItemSettings['status']>,
  events: string[] = []
) {
  const set = vi.fn((settings: Electron.Settings) => {
    events.push(`${settings.openAtLogin ? 'register' : 'unregister'} ${settings.serviceName}`)
    statuses[settings.serviceName ?? ''] = settings.openAtLogin ? 'enabled' : 'not-registered'
  })
  const api: LoginItemApi = {
    getLoginItemSettings: (o) => ({
      ...fakeLoginItems().api.getLoginItemSettings(o),
      status: statuses[o?.serviceName ?? ''] ?? 'not-registered'
    }),
    setLoginItemSettings: set
  }
  return { api, set, statuses }
}

function result(code: number): ProcessResult {
  return { code, signal: null, stdout: '', stderr: '', timedOut: false }
}

const ACCOUNT = {
  home: '/nonexistent/home',
  accountHome: '/nonexistent/home',
  userDataPath: '/nonexistent/home/Library/Application Support/Pod',
  defaultUserDataPath: '/nonexistent/home/Library/Application Support/Pod'
}

describe('claude-acc supervisor', () => {
  it('finds the app bundle from the executable', () => {
    expect(appBundlePath('/Applications/Pod.app/Contents/MacOS/Pod')).toBe('/Applications/Pod.app')
  })

  it('yields the tray to the running menu helper and re-applies it when that changes', async () => {
    let helper = true
    const run = vi.fn(async (spec: ProcessSpec) =>
      spec.program === '/usr/bin/pgrep' ? result(helper ? 0 : 1) : result(0)
    )
    let yieldTo: (() => boolean) | null = null
    const syncTray = vi.fn()
    const log = vi.fn()
    const supervisor = startPodAccSupervisor({
      config: { payload: 'claude-acc', pluginKey: 'outof-place.pod-acc' },
      resourcesPath: '/nonexistent/Resources',
      execPath: '/Applications/Pod.app/Contents/MacOS/Pod',
      ...ACCOUNT,
      platform: 'darwin',
      env: {},
      run,
      loginItems: null,
      appId: null,
      setTrayYield: (fn) => {
        yieldTo = fn
      },
      syncTray,
      log
    })
    await supervisor.lifecycle
    await vi.waitFor(() => expect(syncTray).toHaveBeenCalled())
    expect(yieldTo!()).toBe(true)
    expect(log).toHaveBeenCalledWith('claude-acc: skipped (no-payload)')
    expect(run.mock.calls.every(([spec]) => spec.program === '/usr/bin/pgrep')).toBe(true)
    supervisor.stop()
    helper = false
  })

  it('skips the lifecycle for a harness launch with a throwaway HOME and profile', async () => {
    const run = vi.fn(async (_spec: ProcessSpec) => result(1))
    const log = vi.fn()
    const supervisor = startPodAccSupervisor({
      config: { payload: 'claude-acc', pluginKey: 'outof-place.pod-acc' },
      resourcesPath: '/nonexistent/Resources',
      execPath: '/Applications/Pod.app/Contents/MacOS/Pod',
      ...ACCOUNT,
      home: '/private/tmp/e2e-home',
      userDataPath: '/private/tmp/e2e-home/userData',
      platform: 'darwin',
      env: { ORCA_E2E_USER_DATA_DIR: '/private/tmp/e2e-home/userData' },
      run,
      loginItems: null,
      appId: null,
      setTrayYield: () => {},
      syncTray: () => {},
      log
    })
    await expect(supervisor.lifecycle).resolves.toMatchObject({
      status: 'skipped',
      decision: { reason: 'automated-launch' }
    })
    expect(log).toHaveBeenCalledWith('claude-acc: skipped (automated-launch)')
    expect(run.mock.calls.every(([spec]) => spec.program === '/usr/bin/pgrep')).toBe(true)
    supervisor.stop()
  })

  it('registers the bundled agents once claude-acc is up to date, and reports them', async () => {
    const loginItems = fakeLoginItems()
    const pod = installedPod()
    const supervisor = startPodAccSupervisor({
      config: { payload: 'claude-acc', pluginKey: 'outof-place.pod-acc' },
      ...pod,
      platform: 'darwin',
      env: {},
      run: vi.fn(async () => result(1)),
      loginItems: loginItems.api,
      appId: 'codes.pod.app',
      setTrayYield: () => {},
      syncTray: () => {},
      log: () => {}
    })
    await expect(supervisor.lifecycle).resolves.toMatchObject({ status: 'up-to-date' })
    await supervisor.services
    expect(loginItems.set).toHaveBeenCalledWith({
      openAtLogin: true,
      type: 'agentService',
      serviceName: 'codes.pod.app.acc.tick.plist'
    })
    const report = JSON.parse(
      readFileSync(join(pod.home, ACC_STATE_DIR, ACC_SERVICES_REPORT), 'utf8')
    )
    expect(report).toMatchObject({
      version: 1,
      app: appBundlePath(pod.execPath),
      payload: '1.31.0',
      services: [{ kind: 'agent', name: 'codes.pod.app.acc.tick.plist', status: 'not-registered' }]
    })
    supervisor.stop()
  })

  it('unregisters every Pod service once claude-acc was handed back', async () => {
    const loginItems = fakeLoginItems()
    const pod = installedPod('brew')
    const supervisor = startPodAccSupervisor({
      config: { payload: 'claude-acc', pluginKey: 'outof-place.pod-acc' },
      ...pod,
      platform: 'darwin',
      env: {},
      run: vi.fn(async () => result(1)),
      loginItems: loginItems.api,
      appId: 'codes.pod.app',
      setTrayYield: () => {},
      syncTray: () => {},
      log: () => {}
    })
    await expect(supervisor.lifecycle).resolves.toMatchObject({
      status: 'skipped',
      decision: { reason: 'handed-back' }
    })
    await supervisor.services
    expect(loginItems.set.mock.calls).toEqual([
      [{ openAtLogin: false, type: 'agentService', serviceName: 'codes.pod.app.acc.tick.plist' }]
    ])
    expect(existsSync(join(pod.home, ACC_STATE_DIR, ACC_SERVICES_REPORT))).toBe(true)
    supervisor.stop()
  })

  it('removes its services when claude-acc is handed back while Pod runs', async () => {
    const loginItems = fakeLoginItems()
    const pod = installedPod()
    const log = vi.fn()
    const supervisor = startPodAccSupervisor({
      config: { payload: 'claude-acc', pluginKey: 'outof-place.pod-acc' },
      ...pod,
      platform: 'darwin',
      env: {},
      run: vi.fn(async () => result(1)),
      loginItems: loginItems.api,
      appId: 'codes.pod.app',
      setTrayYield: () => {},
      syncTray: () => {},
      log,
      probeMs: 10
    })
    await supervisor.services
    expect(loginItems.set).toHaveBeenLastCalledWith(expect.objectContaining({ openAtLogin: true }))
    writeFileSync(
      join(pod.home, ACC_STATE_DIR, 'owner.json'),
      JSON.stringify({ owner: 'brew', version: '1.31.0', app: null })
    )
    await vi.waitFor(() =>
      expect(loginItems.set).toHaveBeenLastCalledWith({
        openAtLogin: false,
        type: 'agentService',
        serviceName: 'codes.pod.app.acc.tick.plist'
      })
    )
    expect(log).toHaveBeenCalledWith("claude-acc: handed to brew, removing Pod's services")
    supervisor.stop()
  })

  it.each([
    ['restarts', 'enabled', true],
    ['leaves', 'not-registered', false]
  ] as const)(
    '%s the menu helper after installing a new payload when launchd ran it already (%s)',
    async (_verb, helperStatus, restarts) => {
      const pod = installedPod('pod', '1.30.3')
      const app = appBundlePath(pod.execPath)
      mkdirSync(join(app, 'Contents', 'Library', 'LoginItems', 'Pod Menu.app'), { recursive: true })
      const statuses: Record<string, Electron.LoginItemSettings['status']> = {
        'com.filip.claude-acc.menubar': helperStatus
      }
      const set = vi.fn((settings: Electron.Settings) => {
        statuses[settings.serviceName ?? ''] = settings.openAtLogin ? 'enabled' : 'not-registered'
      })
      const loginItems: LoginItemApi = {
        getLoginItemSettings: (o) => ({
          ...fakeLoginItems().api.getLoginItemSettings(o),
          status: statuses[o?.serviceName ?? ''] ?? 'not-registered'
        }),
        setLoginItemSettings: set
      }
      const run = vi.fn(async (spec: ProcessSpec) => {
        if (spec.program === '/bin/bash') {
          // what setup.sh does on success: Pod owns the new version
          writeFileSync(
            join(pod.home, ACC_STATE_DIR, 'owner.json'),
            JSON.stringify({ owner: 'pod', version: '1.31.0', app })
          )
          return result(0)
        }
        return result(spec.program === '/usr/bin/pgrep' ? 1 : 0)
      })
      const supervisor = startPodAccSupervisor({
        config: { payload: 'claude-acc', pluginKey: 'outof-place.pod-acc' },
        ...pod,
        platform: 'darwin',
        env: {},
        run,
        loginItems,
        appId: 'codes.pod.app',
        setTrayYield: () => {},
        syncTray: () => {},
        log: () => {}
      })
      await expect(supervisor.lifecycle).resolves.toMatchObject({ status: 'installed' })
      await supervisor.services
      const programs = run.mock.calls.map(([spec]) =>
        [spec.program, ...(spec.args ?? [])].join(' ')
      )
      expect(programs.includes('/usr/bin/pkill -x ClaudeAcc')).toBe(restarts)
      expect(
        programs.includes(
          `/usr/bin/open -g ${join(app, 'Contents/Library/LoginItems/Pod Menu.app')}`
        )
      ).toBe(restarts)
      supervisor.stop()
    }
  )

  it.each([
    ['unregisters', 0],
    ['keeps', 1]
  ] as const)(
    '%s an enabled pod-rootd on handback once pod-rootctl restore exits %i',
    async (_verb, restoreCode) => {
      const pod = installedPod('brew', '1.31.0', { rootd: true })
      const events: string[] = []
      const loginItems = statefulLoginItems({ [ROOTD]: 'enabled' }, events)
      const ctl = join(pod.resourcesPath, 'claude-acc', 'pod-rootctl')
      const run = vi.fn(async (spec: ProcessSpec) => {
        if (spec.program === ctl) {
          events.push(`${spec.program} ${(spec.args ?? []).join(' ')}`)
          return result(restoreCode)
        }
        return result(1)
      })
      const log = vi.fn()
      const supervisor = startPodAccSupervisor({
        config: { payload: 'claude-acc', pluginKey: 'outof-place.pod-acc' },
        ...pod,
        platform: 'darwin',
        env: {},
        run,
        loginItems: loginItems.api,
        appId: 'codes.pod.app',
        setTrayYield: () => {},
        syncTray: () => {},
        log
      })
      await supervisor.services
      expect(events[0]).toBe(`${ctl} restore`)
      expect(events.includes(`unregister ${ROOTD}`)).toBe(restoreCode === 0)
      expect(events).toContain('unregister codes.pod.app.acc.tick.plist')
      if (restoreCode !== 0) {
        expect(log).toHaveBeenCalledWith(
          'claude-acc: pod-rootctl restore failed (exit 1), pod-rootd stays registered'
        )
      }
      supervisor.stop()
    }
  )

  it('registers pod-rootd only on the opt-in, and reports it under daemons', async () => {
    const pod = installedPod('pod', '1.31.0', { rootd: true })
    const loginItems = statefulLoginItems({})
    const supervisor = startPodAccSupervisor({
      config: { payload: 'claude-acc', pluginKey: 'outof-place.pod-acc' },
      ...pod,
      platform: 'darwin',
      env: {},
      run: vi.fn(async () => result(1)),
      loginItems: loginItems.api,
      appId: 'codes.pod.app',
      setTrayYield: () => {},
      syncTray: () => {},
      log: () => {}
    })
    await supervisor.services
    const daemonCalls = () =>
      loginItems.set.mock.calls.filter(([settings]) => settings.type === 'daemonService')
    expect(daemonCalls()).toEqual([])
    const readReport = () =>
      JSON.parse(readFileSync(join(pod.home, ACC_STATE_DIR, ACC_SERVICES_REPORT), 'utf8'))
    expect(readReport()).toMatchObject({
      services: [
        {
          kind: 'agent',
          name: 'codes.pod.app.acc.tick.plist',
          status: 'enabled'
        }
      ],
      daemons: [{ kind: 'daemon', name: ROOTD, status: 'not-registered' }]
    })
    await expect(supervisor.registerRootd()).resolves.toMatchObject({
      status: 'enabled',
      registered: true
    })
    expect(daemonCalls()).toEqual([
      [{ openAtLogin: true, type: 'daemonService', serviceName: ROOTD }]
    ])
    expect(readReport().daemons).toEqual([{ kind: 'daemon', name: ROOTD, status: 'enabled' }])
    supervisor.stop()
  })

  it.each([
    ['registers', true],
    ['leaves', false]
  ] as const)(
    "%s pod-rootd when the panel's Enable root helper… asks and Pod's dialog answers %s",
    async (_verb, confirmed) => {
      const pod = installedPod('pod', '1.31.0', { rootd: true })
      const loginItems = statefulLoginItems({})
      const log = vi.fn()
      const confirmRootd = vi.fn(async () => confirmed)
      const supervisor = startPodAccSupervisor({
        config: { payload: 'claude-acc', pluginKey: 'outof-place.pod-acc' },
        ...pod,
        platform: 'darwin',
        env: {},
        run: vi.fn(async () => result(1)),
        loginItems: loginItems.api,
        appId: 'codes.pod.app',
        setTrayYield: () => {},
        syncTray: () => {},
        log,
        probeMs: 10,
        confirmRootd
      })
      await supervisor.services
      const at = Date.now() / 1000
      const request = join(pod.home, ACC_STATE_DIR, 'pod-rootd-request.json')
      writeFileSync(request, JSON.stringify({ action: 'enable', at }), { mode: 0o600 })
      const report = () =>
        JSON.parse(readFileSync(join(pod.home, ACC_STATE_DIR, ACC_SERVICES_REPORT), 'utf8'))
      await vi.waitFor(() => expect(report().rootdRequest?.at).toBe(at))
      expect(confirmRootd).toHaveBeenCalledOnce()
      expect(existsSync(request)).toBe(false)
      expect(report().rootdRequest.outcome).toBe(confirmed ? 'registered' : 'declined')
      expect(
        loginItems.set.mock.calls.some(([settings]) => settings.type === 'daemonService')
      ).toBe(confirmed)
      expect(log).toHaveBeenCalledWith(
        'claude-acc: pod-rootd requested in the panel, asking to confirm'
      )
      expect(log).toHaveBeenCalledWith(
        confirmed
          ? 'claude-acc: pod-rootd request registered (enabled)'
          : 'claude-acc: pod-rootd request declined'
      )
      supervisor.stop()
    }
  )

  it('declines a pod-rootd request when Pod has no way to ask', async () => {
    const pod = installedPod('pod', '1.31.0', { rootd: true })
    const loginItems = statefulLoginItems({})
    const log = vi.fn()
    const supervisor = startPodAccSupervisor({
      config: { payload: 'claude-acc', pluginKey: 'outof-place.pod-acc' },
      ...pod,
      platform: 'darwin',
      env: {},
      run: vi.fn(async () => result(1)),
      loginItems: loginItems.api,
      appId: 'codes.pod.app',
      setTrayYield: () => {},
      syncTray: () => {},
      log,
      probeMs: 10
    })
    await supervisor.services
    const request = join(pod.home, ACC_STATE_DIR, 'pod-rootd-request.json')
    writeFileSync(request, JSON.stringify({ action: 'enable', at: Date.now() / 1000 }), {
      mode: 0o600
    })
    await vi.waitFor(() =>
      expect(log).toHaveBeenCalledWith('claude-acc: pod-rootd request declined')
    )
    expect(existsSync(request)).toBe(false)
    expect(loginItems.set.mock.calls.some(([settings]) => settings.type === 'daemonService')).toBe(
      false
    )
    supervisor.stop()
  })

  it('offers no pod-rootd opt-in once claude-acc was handed back', async () => {
    const pod = installedPod('brew', '1.31.0', { rootd: true })
    const loginItems = statefulLoginItems({})
    const supervisor = startPodAccSupervisor({
      config: { payload: 'claude-acc', pluginKey: 'outof-place.pod-acc' },
      ...pod,
      platform: 'darwin',
      env: {},
      run: vi.fn(async () => result(1)),
      loginItems: loginItems.api,
      appId: 'codes.pod.app',
      setTrayYield: () => {},
      syncTray: () => {},
      log: () => {}
    })
    const request = join(pod.home, ACC_STATE_DIR, 'pod-rootd-request.json')
    writeFileSync(request, JSON.stringify({ action: 'enable', at: Date.now() / 1000 }), {
      mode: 0o600
    })
    await expect(supervisor.registerRootd()).resolves.toBeNull()
    expect(loginItems.set).not.toHaveBeenCalledWith(expect.objectContaining({ openAtLogin: true }))
    // not Pod's install any more: the request is not Pod's to take
    expect(existsSync(request)).toBe(true)
    supervisor.stop()
  })

  it('never touches launchd services when the lifecycle skipped', async () => {
    const loginItems = fakeLoginItems()
    const pod = installedPod()
    const supervisor = startPodAccSupervisor({
      config: { payload: 'claude-acc', pluginKey: 'outof-place.pod-acc' },
      ...pod,
      platform: 'darwin',
      env: { ORCA_E2E_HEADLESS: '1' },
      run: vi.fn(async () => result(1)),
      loginItems: loginItems.api,
      appId: 'codes.pod.app',
      setTrayYield: () => {},
      syncTray: () => {},
      log: () => {}
    })
    await expect(supervisor.services).resolves.toEqual([])
    expect(loginItems.set).not.toHaveBeenCalled()
    expect(existsSync(join(pod.home, ACC_STATE_DIR, ACC_SERVICES_REPORT))).toBe(false)
    supervisor.stop()
  })
})
