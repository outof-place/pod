import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  podHookWriteBlock,
  podHookWriteBlockNow,
  type PodInstanceInput
} from './pod-hook-write-block'

const account = '/Users/someone'
const profile = join(account, 'Library', 'Application Support', 'Pod')

function input(overrides: Partial<PodInstanceInput> = {}): PodInstanceInput {
  return {
    packaged: true,
    userDataPath: profile,
    defaultUserDataPath: profile,
    argv: ['/Applications/Pod.app/Contents/MacOS/Pod'],
    automated: false,
    e2e: false,
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
    expect(podHookWriteBlock(input({ automated: true }))).toBe('automated-launch')
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
    expect(
      podHookWriteBlock(input({ packaged: false, e2e: true, hookHome: '/tmp/e2e/user-data/home' }))
    ).toBeNull()
    expect(podHookWriteBlock(input({ packaged: false, e2e: true }))).toBe('e2e-outside-its-home')
  })
})

describe('outside Electron (the CLI), before main installs its check', () => {
  const argv = process.argv
  afterEach(() => {
    process.argv = argv
  })

  it('only the launch flags count', () => {
    process.argv = ['node', 'orca', 'hooks', 'install']
    expect(podHookWriteBlockNow()).toBeNull()
    process.argv = ['node', 'orcad', '--serve']
    expect(podHookWriteBlockNow()).toBe('serve')
  })
})
