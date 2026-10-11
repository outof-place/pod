import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { podHookWriteBlock, type PodInstanceInput } from './pod-instance'

const account = '/Users/someone'
const profile = join(account, 'Library', 'Application Support', 'Pod')

function input(overrides: Partial<PodInstanceInput> = {}): PodInstanceInput {
  return {
    packaged: true,
    userDataPath: profile,
    defaultUserDataPath: profile,
    argv: ['/Applications/Pod.app/Contents/MacOS/Pod'],
    env: {},
    hookHome: account,
    accountHome: account,
    ...overrides
  }
}

describe('which Pod may write the user-global hook files', () => {
  it('the packaged app on its default profile, launched by the user', () => {
    expect(podHookWriteBlock(input())).toBeNull()
  })

  it('not a dev build, whatever its HOME says', () => {
    expect(podHookWriteBlock(input({ packaged: false, hookHome: '/tmp/profile/home' }))).toBe(
      'dev-build'
    )
  })

  it('not a harness launch, a runtime host or a test keychain', () => {
    expect(podHookWriteBlock(input({ env: { ORCA_BACKGROUND_LAUNCH: '1' } }))).toBe(
      'automated-launch'
    )
    expect(podHookWriteBlock(input({ env: { POD_E2E_HEADLESS: '1' } }))).toBe('automated-launch')
    expect(podHookWriteBlock(input({ argv: ['Pod', '--serve'] }))).toBe('serve')
    expect(podHookWriteBlock(input({ argv: ['Pod', '--pod-headless-host'] }))).toBe('headless-host')
    expect(
      podHookWriteBlock(input({ argv: ['Pod', '--password-store=basic', '--use-mock-keychain'] }))
    ).toBe('mock-keychain')
  })

  it('not a packaged build on a profile of its own', () => {
    expect(podHookWriteBlock(input({ userDataPath: '/tmp/bench/profile' }))).toBe('custom-profile')
    expect(podHookWriteBlock(input({ defaultUserDataPath: null }))).toBe('custom-profile')
  })

  it('E2E only inside its disposable home', () => {
    const e2e = { ORCA_E2E_USER_DATA_DIR: '/tmp/e2e/user-data' }
    expect(
      podHookWriteBlock(input({ packaged: false, env: e2e, hookHome: '/tmp/e2e/user-data/home' }))
    ).toBeNull()
    expect(podHookWriteBlock(input({ packaged: false, env: e2e }))).toBe('e2e-outside-its-home')
  })
})
