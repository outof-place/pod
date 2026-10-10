import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readMacClaudePrivacy } from './pod-orbstack-privacy-env'

describe('readMacClaudePrivacy', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function settings(env: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'pod-privacy-'))
    dirs.push(dir)
    const file = join(dir, 'settings.json')
    writeFileSync(file, JSON.stringify({ env, permissions: {} }))
    return file
  }

  it('mirrors the switches the Mac sets in its env or settings, and closes telemetry and flags', () => {
    const privacy = readMacClaudePrivacy({
      env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '0', PATH: '/usr/bin' },
      settingsFiles: [
        settings({ DISABLE_ERROR_REPORTING: '1', ANTHROPIC_MODEL: 'opus' }),
        join(tmpdir(), 'pod-privacy-missing.json')
      ]
    })
    expect(privacy).toEqual({
      env: { DISABLE_ERROR_REPORTING: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '0' },
      telemetryOff: true,
      featureFlagsOff: true
    })
    expect(
      readMacClaudePrivacy({ env: {}, settingsFiles: [settings({ DO_NOT_TRACK: '1' })] })
    ).toMatchObject({ telemetryOff: true, featureFlagsOff: false })
  })

  it('keeps the route open and mirrors only what the Mac sets when it turns nothing off', () => {
    expect(
      readMacClaudePrivacy({
        env: { DISABLE_TELEMETRY: '', HOME: '/Users/me' },
        settingsFiles: [settings({ ANTHROPIC_MODEL: 'opus', DISABLE_TELEMETRY: '0' })]
      })
    ).toEqual({ env: { DISABLE_TELEMETRY: '0' }, telemetryOff: false, featureFlagsOff: false })
    expect(readMacClaudePrivacy({ env: {}, settingsFiles: [] })).toEqual({
      env: {},
      telemetryOff: false,
      featureFlagsOff: false
    })
  })
})
