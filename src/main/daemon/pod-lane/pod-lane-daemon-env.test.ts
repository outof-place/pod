import { afterEach, describe, expect, it, vi } from 'vitest'
import { podLaneDaemonEnv } from './pod-lane-daemon-env'

vi.mock('../../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getAppPath: () => '/app/Resources/app.asar', isPackaged: () => true })
}))

const originalResourcesPath = process.resourcesPath

afterEach(() => {
  vi.restoreAllMocks()
  Object.defineProperty(process, 'resourcesPath', {
    value: originalResourcesPath,
    configurable: true
  })
})

describe('podLaneDaemonEnv', () => {
  it("points the peer-check addon into a relocated daemon host's own bundle", () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    Object.defineProperty(process, 'resourcesPath', {
      value: '/Applications/Pod.app/Contents/Resources',
      configurable: true
    })
    expect(podLaneDaemonEnv().POD_PEER_IDENTITY_ADDON).toBe(
      '/Applications/Pod.app/Contents/Resources/native/pod-peer-identity.node'
    )
    expect(
      podLaneDaemonEnv('/data/daemon-host.noindex/1.0.0/build-x/Pod Runtime/Contents/MacOS/Pod')
        .POD_PEER_IDENTITY_ADDON
    ).toBe(
      '/data/daemon-host.noindex/1.0.0/build-x/Pod Runtime/Contents/Resources/native/pod-peer-identity.node'
    )
  })
})
