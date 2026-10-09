import { describe, expect, it } from 'vitest'
import { isPodWorkspaceEnabled } from './pod-workspace-flag'

const noIdentity = (): boolean => false
const podIdentity = (): boolean => true

describe('isPodWorkspaceEnabled', () => {
  it('is off outside macOS, whatever the setting, env or identity', () => {
    for (const platform of ['linux', 'win32'] as const) {
      expect(
        isPodWorkspaceEnabled(
          { experimentalPodWorkspace: true },
          { ORCA_POD_WORKSPACE: '1' },
          platform,
          podIdentity
        )
      ).toBe(false)
    }
  })

  it('follows the Pod identity by default on macOS', () => {
    expect(isPodWorkspaceEnabled({}, {}, 'darwin', podIdentity)).toBe(true)
    expect(isPodWorkspaceEnabled({}, {}, 'darwin', noIdentity)).toBe(false)
  })

  it('turns on for upstream builds through the setting or the env override', () => {
    expect(
      isPodWorkspaceEnabled({ experimentalPodWorkspace: true }, {}, 'darwin', noIdentity)
    ).toBe(true)
    expect(isPodWorkspaceEnabled({}, { ORCA_POD_WORKSPACE: '1' }, 'darwin', noIdentity)).toBe(true)
  })

  it('lets ORCA_POD_WORKSPACE=0 win over the identity and the setting', () => {
    expect(
      isPodWorkspaceEnabled(
        { experimentalPodWorkspace: true },
        { ORCA_POD_WORKSPACE: '0' },
        'darwin',
        podIdentity
      )
    ).toBe(false)
  })
})
