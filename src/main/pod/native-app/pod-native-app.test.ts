import { beforeEach, describe, expect, it, vi } from 'vitest'

const { buildFromTemplateMock, setDockMenuMock, getPathMock, runProcessMock } = vi.hoisted(() => ({
  buildFromTemplateMock: vi.fn((template: unknown) => ({ template })),
  setDockMenuMock: vi.fn(),
  getPathMock: vi.fn(() => '/profiles/Pod'),
  runProcessMock: vi.fn()
}))

vi.mock('electron', () => ({
  Menu: { buildFromTemplate: buildFromTemplateMock },
  app: { dock: { setMenu: setDockMenuMock }, getPath: getPathMock }
}))
vi.mock('../../../shared/child-process/run-process', () => ({ runProcess: runProcessMock }))

import {
  OPEN_POD_NATIVE_LABEL,
  POD_NATIVE_APP_ENV,
  installPodNativeDockMenu,
  openPodNative,
  podNativeWindowMenuItems,
  resolvePodNativeApp,
  type PodNativeHost
} from './pod-native-app'

const NESTED = '/Applications/Pod.app/Contents/Helpers/PodNative.app'

function host(overrides: Partial<PodNativeHost> = {}): PodNativeHost {
  return {
    platform: 'darwin',
    darwinRelease: '27.0.0',
    resourcesPath: '/Applications/Pod.app/Contents/Resources',
    env: {},
    hasProductIdentity: true,
    exists: (path) => path === `${NESTED}/Contents/Info.plist`,
    ...overrides
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('resolvePodNativeApp', () => {
  it('finds the app nested in Contents/Helpers', () => {
    expect(resolvePodNativeApp(host())).toBe(NESTED)
  })

  it('is null for upstream builds, other platforms and macOS before 27', () => {
    expect(resolvePodNativeApp(host({ hasProductIdentity: false }))).toBeNull()
    expect(resolvePodNativeApp(host({ platform: 'linux' }))).toBeNull()
    expect(resolvePodNativeApp(host({ darwinRelease: '26.4.0' }))).toBeNull()
  })

  it('is null when the build ships no helper', () => {
    expect(resolvePodNativeApp(host({ exists: () => false }))).toBeNull()
  })

  it('takes a built copy from the environment', () => {
    const env = { [POD_NATIVE_APP_ENV]: '/tmp/build/PodNative.app' }
    const exists = (path: string): boolean =>
      path === '/tmp/build/PodNative.app/Contents/Info.plist'
    expect(resolvePodNativeApp(host({ env, exists }))).toBe('/tmp/build/PodNative.app')
  })
})

describe('menus', () => {
  it('adds a separated Window menu item only when the app is there', () => {
    expect(podNativeWindowMenuItems(host({ exists: () => false }))).toEqual([])
    const items = podNativeWindowMenuItems(host())
    expect(items.map((item) => item.type ?? item.label)).toEqual([
      'separator',
      OPEN_POD_NATIVE_LABEL
    ])
  })

  it('sets the Dock menu only when the app is there', () => {
    installPodNativeDockMenu(host({ hasProductIdentity: false }))
    expect(setDockMenuMock).not.toHaveBeenCalled()
    installPodNativeDockMenu(host())
    expect(buildFromTemplateMock).toHaveBeenCalledWith([
      expect.objectContaining({ label: OPEN_POD_NATIVE_LABEL })
    ])
    expect(setDockMenuMock).toHaveBeenCalledOnce()
  })
})

describe('openPodNative', () => {
  it('opens the app by path with this Pod profile', async () => {
    runProcessMock.mockResolvedValue({ code: 0, stdout: '', stderr: '' })
    await openPodNative(NESTED)
    expect(runProcessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        program: '/usr/bin/open',
        args: ['-a', NESTED, '--args', '--profile', '/profiles/Pod']
      })
    )
  })
})
