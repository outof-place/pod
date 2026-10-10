import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  legacyImportRequestPath,
  setProfileAside,
  takeLegacyImportRequest,
  writeLegacyImportRequest
} from './legacy-import-request'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function appData(): string {
  const root = mkdtempSync(join(tmpdir(), 'import-request-'))
  roots.push(root)
  return root
}

describe('legacy import request', () => {
  it('is read once, from beside the profile', () => {
    const dir = appData()
    const path = legacyImportRequestPath(dir, 'Pod')
    expect(path).toBe(join(dir, 'Pod.import-request.json'))
    expect(takeLegacyImportRequest(path)).toBeNull()
    writeLegacyImportRequest(path, new Date('2026-10-10T06:00:00Z'))
    expect(takeLegacyImportRequest(path)).toEqual({ requestedAt: '2026-10-10T06:00:00.000Z' })
    expect(existsSync(path)).toBe(false)
  })

  it('drops a malformed request instead of looping on it', () => {
    const dir = appData()
    const path = legacyImportRequestPath(dir, 'Pod')
    writeFileSync(path, 'not json')
    expect(takeLegacyImportRequest(path)).toBeNull()
    expect(existsSync(path)).toBe(false)
  })

  it('sets a used profile aside under a dated name and skips an empty one', () => {
    const dir = appData()
    expect(setProfileAside(dir, 'Pod', new Date('2026-10-10T06:07:08Z'))).toBeNull()
    mkdirSync(join(dir, 'Pod'))
    expect(setProfileAside(dir, 'Pod', new Date('2026-10-10T06:07:08Z'))).toBeNull()
    writeFileSync(join(dir, 'Pod', 'orca-data.json'), '{}')
    const aside = setProfileAside(dir, 'Pod', new Date('2026-10-10T06:07:08Z'))
    expect(aside).toBe(join(dir, 'Pod before Orca import 2026-10-10 06.07.08'))
    expect(readdirSync(dir).sort()).toEqual(['Pod before Orca import 2026-10-10 06.07.08'])
  })
})
