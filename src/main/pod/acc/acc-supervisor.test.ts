import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProcessResult, ProcessSpec } from '../../../shared/child-process/run-process'
import { ACC_STATE_DIR } from './acc-lifecycle'
import { ACC_SERVICES_REPORT, type LoginItemApi } from './acc-services'
import { appBundlePath, startPodAccSupervisor } from './acc-supervisor'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

/** An installed Pod (payload 1.31.0, owner.json saying pod) whose bundle carries one agent. */
function installedPod(owner = 'pod') {
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
  mkdirSync(join(home, ACC_STATE_DIR), { recursive: true })
  writeFileSync(
    join(home, ACC_STATE_DIR, 'owner.json'),
    JSON.stringify({ owner, version: '1.31.0', app })
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
