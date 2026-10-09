import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ORCA_APP_BUNDLE_ID,
  ORCA_COMPUTER_USE_BUNDLE_ID,
  ORCA_DEV_APP_BUNDLE_ID,
  ORCA_LOCAL_APP_BUNDLE_ID
} from './app-identity'

const SRC_ROOT = join(__dirname, '..')

function runtimeSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      return entry.name === 'node_modules' ? [] : runtimeSourceFiles(path)
    }
    return /\.(?:ts|tsx|mts|cts)$/.test(entry.name) && !/\.(?:test|spec)\./.test(entry.name)
      ? [path]
      : []
  })
}

describe('app identity', () => {
  it('keeps the shipped bundle id and its variants', () => {
    expect(ORCA_APP_BUNDLE_ID).toBe('com.stablyai.orca')
    expect(ORCA_DEV_APP_BUNDLE_ID).toBe('com.stablyai.orca.dev')
    expect(ORCA_LOCAL_APP_BUNDLE_ID).toBe('com.stablyai.orca.local')
    expect(ORCA_COMPUTER_USE_BUNDLE_ID).toBe('com.stablyai.orca.computer-use')
  })

  it('is the only runtime source that spells the bundle id', () => {
    // Why: a rebranded build must change one constant; a stray literal would
    // silently keep the old identity for TCC, defaults, or notifications.
    const offenders = runtimeSourceFiles(SRC_ROOT)
      .filter((path) => /['"`]com\.stablyai\.orca/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(SRC_ROOT, path).replaceAll('\\', '/'))
    expect(offenders).toEqual(['shared/app-identity.ts'])
  })
})
