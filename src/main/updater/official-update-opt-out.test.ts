import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: true, getAppPath: () => '/nonexistent' } }))

const { readOfficialUpdatesOptOut } = await import('./official-update-opt-out')

const dirs: string[] = []
function appDirWithManifest(contents: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-update-opt-out-'))
  dirs.push(dir)
  if (contents !== null) {
    writeFileSync(join(dir, 'package.json'), contents)
  }
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('readOfficialUpdatesOptOut', () => {
  it('opts out only for an explicit false', () => {
    expect(
      readOfficialUpdatesOptOut(appDirWithManifest('{"name":"orca","orcaOfficialUpdates":false}'))
    ).toBe(true)
  })

  it('keeps upstream behaviour when the field is absent or not false', () => {
    expect(readOfficialUpdatesOptOut(appDirWithManifest('{"name":"orca"}'))).toBe(false)
    expect(readOfficialUpdatesOptOut(appDirWithManifest('{"orcaOfficialUpdates":true}'))).toBe(
      false
    )
    expect(readOfficialUpdatesOptOut(appDirWithManifest('{"orcaOfficialUpdates":"false"}'))).toBe(
      false
    )
  })

  it('keeps upstream behaviour when the manifest is missing or malformed', () => {
    expect(readOfficialUpdatesOptOut(appDirWithManifest(null))).toBe(false)
    expect(readOfficialUpdatesOptOut(appDirWithManifest('not json'))).toBe(false)
    expect(readOfficialUpdatesOptOut(appDirWithManifest('null'))).toBe(false)
  })
})
