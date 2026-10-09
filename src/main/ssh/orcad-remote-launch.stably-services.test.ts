import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as ProductIdentityModule from '../product-identity/product-identity'
import type { ProductIdentity } from '../product-identity/product-identity'
import { podIdentityWithoutStablyServices } from '../product-identity/product-identity.test-fixture'

const identity = vi.hoisted((): { current: ProductIdentity | null } => ({ current: null }))

vi.mock('../product-identity/product-identity', async (importOriginal) => ({
  ...(await importOriginal<typeof ProductIdentityModule>()),
  getProductIdentity: () => identity.current
}))

import { orcadLaunchCommand } from './orcad-remote-launch'
import { windowsOrcadLaunchCommand } from './orcad-remote-launch-windows'
import { getRemoteHostPlatform } from './ssh-remote-platform'

const SPEC = {
  remoteInstallDir: '/home/u/.orca-remote/orcad-0.2.0+bb01',
  nodePath: '/usr/bin/node',
  fullVersion: '0.2.0+bb01',
  userDataDir: '/home/u/.orca',
  bindHost: '127.0.0.1',
  port: 7777,
  activationRoot: '/home/u/.orca-remote/.orcad-activation-transaction'
}

describe('remote orcad launched by a product without Stably services', () => {
  afterEach(() => {
    identity.current = null
  })

  it('launches like upstream Orca without an identity', () => {
    expect(orcadLaunchCommand(getRemoteHostPlatform('linux-x64'), SPEC)).not.toContain(
      'POD_STABLY_SERVICES_OFF'
    )
  })

  it('hands the remote orcad the services-off flag on POSIX and Windows hosts', () => {
    identity.current = podIdentityWithoutStablyServices()
    expect(orcadLaunchCommand(getRemoteHostPlatform('linux-x64'), SPEC)).toContain(
      "POD_STABLY_SERVICES_OFF='1'"
    )
    expect(
      windowsOrcadLaunchCommand(getRemoteHostPlatform('win32-x64'), SPEC, 'C:\\node\\node.exe')
    ).toContain('POD_STABLY_SERVICES_OFF=1')
  })
})
