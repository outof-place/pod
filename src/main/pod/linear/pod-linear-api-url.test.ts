// Fork-only (Pod): POD_LINEAR_API_URL moves Linear only to loopback, only in an isolated profile,
// and a refused value fails every client instead of falling back to api.linear.app.
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { loadLinearSdk, type LinearSdkModule } from '../../linear/linear-sdk'
import { podLinearSdk, resolvePodLinearApiTarget } from './pod-linear-api-url'

const ISOLATED = { ORCA_E2E_USER_DATA_DIR: '/private/tmp/pod-e2e-profile' }

describe('resolvePodLinearApiTarget', () => {
  it('keeps the SDK default when the variable is unset or empty', () => {
    expect(resolvePodLinearApiTarget({})).toEqual({ kind: 'default' })
    expect(resolvePodLinearApiTarget({ POD_LINEAR_API_URL: '', ...ISOLATED })).toEqual({
      kind: 'default'
    })
  })

  it.each([
    'http://127.0.0.1:4100/graphql',
    'http://localhost:4100/graphql',
    'http://[::1]:4100/graphql',
    'https://127.0.0.1/graphql'
  ])('takes loopback %s in an isolated profile', (apiUrl) => {
    expect(resolvePodLinearApiTarget({ POD_LINEAR_API_URL: apiUrl, ...ISOLATED })).toEqual({
      kind: 'mock',
      apiUrl
    })
  })

  it.each([
    'https://api.linear.app/graphql',
    'http://10.0.0.5:4100/graphql',
    'http://127.0.0.2/graphql',
    'http://127.0.0.1.example.com/graphql',
    'http://localhost.example.com/graphql',
    'http://127.0.0.1@example.com/graphql',
    'http://user:pass@127.0.0.1/graphql',
    'file:///private/tmp/linear',
    'ws://127.0.0.1:4100/graphql',
    'not a url'
  ])('refuses %s', (apiUrl) => {
    expect(resolvePodLinearApiTarget({ POD_LINEAR_API_URL: apiUrl, ...ISOLATED }).kind).toBe(
      'refused'
    )
  })

  it('refuses even a loopback URL outside an isolated profile', () => {
    const target = resolvePodLinearApiTarget({
      POD_LINEAR_API_URL: 'http://127.0.0.1:4100/graphql'
    })
    expect(target).toEqual({
      kind: 'refused',
      message: expect.stringContaining('ORCA_E2E_USER_DATA_DIR')
    })
  })
})

describe('podLinearSdk', () => {
  // The real SDK, unwrapped: building a client sends nothing. Where a mock client's requests go
  // is pod-linear-mock-server.test.ts's part.
  let sdk: LinearSdkModule
  beforeAll(() => {
    vi.stubEnv('POD_LINEAR_API_URL', undefined)
    sdk = loadLinearSdk()
    vi.unstubAllEnvs()
  })

  it('returns the SDK itself without an override', () => {
    expect(podLinearSdk(sdk, { kind: 'default' })).toBe(sdk)
  })

  it('fails every client on a refused value', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const wrapped = podLinearSdk(sdk, { kind: 'refused', message: 'Linear is off: test' })
    expect(() => new wrapped.LinearClient({ apiKey: 'lin_api_fake' })).toThrow(
      'Linear is off: test'
    )
  })

  it('builds the SDK client on the mock target', () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const wrapped = podLinearSdk(sdk, { kind: 'mock', apiUrl: 'http://127.0.0.1:4100/graphql' })
    expect(new wrapped.LinearClient({ apiKey: 'lin_api_fake' })).toBeInstanceOf(sdk.LinearClient)
  })
})
