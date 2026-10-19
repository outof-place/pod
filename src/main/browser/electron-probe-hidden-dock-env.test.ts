import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { describe, expect, it } from 'vitest'
import { withHiddenDockProbeEnv } from './electron-probe-hidden-dock-env'

function preloadPathFrom(nodeOptions: string | undefined): string {
  const match = /--require "([^"]+)"$/.exec(nodeOptions ?? '')
  if (!match) {
    throw new Error(`no --require preload in NODE_OPTIONS: ${nodeOptions}`)
  }
  return match[1]
}

describe('withHiddenDockProbeEnv', () => {
  it('preloads an existing absolute script on darwin', () => {
    const preload = preloadPathFrom(withHiddenDockProbeEnv({}, 'darwin').NODE_OPTIONS)

    expect(isAbsolute(preload)).toBe(true)
    expect(existsSync(preload)).toBe(true)
  })

  it('keeps the NODE_OPTIONS the caller already set', () => {
    const env = withHiddenDockProbeEnv({ NODE_OPTIONS: '--max-old-space-size=512' }, 'darwin')

    expect(env.NODE_OPTIONS).toMatch(/^--max-old-space-size=512 --require "/)
  })

  it('keeps every other variable and leaves the input untouched', () => {
    const input = { PATH: '/bin', ORCA_BACKGROUND_LAUNCH: '1' }

    const env = withHiddenDockProbeEnv(input, 'darwin')

    expect(env).toMatchObject(input)
    expect(input).toEqual({ PATH: '/bin', ORCA_BACKGROUND_LAUNCH: '1' })
  })

  it.each(['linux', 'win32'] as const)('returns the env unchanged on %s', (platform) => {
    const env = { NODE_OPTIONS: '--max-old-space-size=512' }

    expect(withHiddenDockProbeEnv(env, platform)).toBe(env)
  })
})
