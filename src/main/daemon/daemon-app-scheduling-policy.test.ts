import { afterEach, describe, expect, it, vi } from 'vitest'
import { daemonAppPolicyLaunch } from './daemon-app-scheduling-policy'

const { existsSync } = vi.hoisted(() => ({ existsSync: vi.fn(() => true) }))
vi.mock('node:fs', () => ({ existsSync }))

const HELPER = '/Applications/Pod.app/Contents/Frameworks/Pod Helper.app/Contents/MacOS/Pod Helper'

function withPlatform(platform: NodeJS.Platform, helperExecPath: string | undefined): void {
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
  Object.defineProperty(process, 'helperExecPath', { value: helperExecPath, configurable: true })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  Object.defineProperty(process, 'helperExecPath', { value: undefined, configurable: true })
  existsSync.mockReturnValue(true)
})

describe('daemonAppPolicyLaunch', () => {
  it('runs the Helper with the daemon entry under taskpolicy -a on macOS', () => {
    vi.stubEnv('POD_DAEMON_APP_POLICY', undefined)
    withPlatform('darwin', HELPER)
    expect(daemonAppPolicyLaunch('/app/daemon-entry.js', ['--socket', '/s'])).toEqual({
      program: '/usr/sbin/taskpolicy',
      args: ['-a', HELPER, '/app/daemon-entry.js', '--socket', '/s']
    })
  })

  it('keeps the plain fork elsewhere, without a Helper, without taskpolicy, or when switched off', () => {
    withPlatform('linux', HELPER)
    expect(daemonAppPolicyLaunch('/app/daemon-entry.js', [])).toBeNull()
    withPlatform('darwin', undefined)
    expect(daemonAppPolicyLaunch('/app/daemon-entry.js', [])).toBeNull()
    withPlatform('darwin', HELPER)
    existsSync.mockReturnValue(false)
    expect(daemonAppPolicyLaunch('/app/daemon-entry.js', [])).toBeNull()
    existsSync.mockReturnValue(true)
    vi.stubEnv('POD_DAEMON_APP_POLICY', '0')
    expect(daemonAppPolicyLaunch('/app/daemon-entry.js', [])).toBeNull()
  })
})
