import { describe, expect, it } from 'vitest'
import { simAppEnv } from './sim-app-shell'

describe('the environment of a recipe command', () => {
  it('drops the runtime’s own build mode, keeps a UTF-8 locale, and lets the recipe win', () => {
    // Pod's dev run has NODE_ENV=development, a test run NODE_ENV=test: neither is the app's.
    const env = simAppEnv(
      { EXPO_PUBLIC_API: 'https://api.example' },
      { PATH: '/usr/bin', NODE_ENV: 'test' }
    )
    expect(env).toEqual({
      PATH: '/usr/bin',
      LANG: 'en_US.UTF-8',
      EXPO_PUBLIC_API: 'https://api.example'
    })
    // Started from Finder, Pod has no LANG; a user's own one is kept.
    expect(simAppEnv(undefined, { LANG: 'pl_PL.UTF-8' }).LANG).toBe('pl_PL.UTF-8')
    expect(simAppEnv({ NODE_ENV: 'production' }, { NODE_ENV: 'development' }).NODE_ENV).toBe(
      'production'
    )
  })
})
