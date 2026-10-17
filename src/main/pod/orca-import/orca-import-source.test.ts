import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getOrcaProfileStateDatabaseFile } from '../../../shared/profile-state-storage-paths'
import Database from '../../sqlite/sync-database'
import { censusOf, writeSyntheticOrcaProfile } from './orca-import-profile.test-support'
import { listOrcaProfiles, readOrcaProfile } from './orca-import-source'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function scratch(): { orca: string; snapshots: string } {
  const root = mkdtempSync(join(tmpdir(), 'pod-orca-import-source-'))
  directories.push(root)
  return { orca: join(root, 'orca'), snapshots: join(root, 'Pod', 'orca-import-snapshots') }
}

const state = {
  repos: [{ id: 'r1', path: '/work/app', displayName: 'app', badgeColor: '#fff', addedAt: 1 }],
  settings: { theme: 'light' },
  workspaceSession: { tabs: ['never read'] }
}

describe('readOrcaProfile', () => {
  it('reads the chosen domains from a clone and leaves Orca’s folder byte for byte', () => {
    const { orca, snapshots } = scratch()
    writeSyntheticOrcaProfile(orca, { state, withDaemonFiles: true })
    const before = censusOf(orca)

    const list = listOrcaProfiles(orca)
    expect(list).toEqual({
      activeProfileId: 'local-default',
      profiles: [{ id: 'local-default', name: 'Personal' }],
      rootJsonOnly: false
    })
    const result = readOrcaProfile(orca, list!, 'local-default', snapshots)

    expect(result).toMatchObject({ kind: 'read', read: { schema: 'current', revision: '1' } })
    const domains = result.kind === 'read' ? result.read.domains : new Map()
    expect(domains.get('settings')).toEqual({ theme: 'light' })
    expect(domains.get('repos')).toEqual(state.repos)
    expect(domains.has('workspaceSession')).toBe(false)
    expect(censusOf(orca)).toEqual(before)
    // Each clone is removed once read.
    expect(readdirSync(snapshots)).toEqual([])
  })

  it('reads a profile a newer Orca wrote, read-only', () => {
    const { orca, snapshots } = scratch()
    writeSyntheticOrcaProfile(orca, { state })
    const db = new Database(getOrcaProfileStateDatabaseFile('local-default', orca))
    db.pragma('user_version = 99')
    db.close()
    const before = censusOf(orca)

    const result = readOrcaProfile(orca, listOrcaProfiles(orca)!, 'local-default', snapshots)

    expect(result).toMatchObject({ kind: 'read', read: { schema: 'newer' } })
    expect(censusOf(orca)).toEqual(before)
  })

  it('reads a profile from before Orca had profiles from its root JSON', () => {
    const { orca, snapshots } = scratch()
    mkdirSync(orca, { recursive: true })
    writeFileSync(join(orca, 'orca-data.json'), JSON.stringify(state))

    const list = listOrcaProfiles(orca)
    expect(list?.rootJsonOnly).toBe(true)
    const result = readOrcaProfile(orca, list!, 'local-default', snapshots)

    expect(result).toMatchObject({ kind: 'read', read: { schema: 'json' } })
    expect(result.kind === 'read' && result.read.domains.get('settings')).toEqual({
      theme: 'light'
    })
  })

  it('reports a damaged database as unreadable after one retry, without touching it', () => {
    const { orca, snapshots } = scratch()
    writeSyntheticOrcaProfile(orca, { state })
    writeFileSync(getOrcaProfileStateDatabaseFile('local-default', orca), 'not a database')
    const before = censusOf(orca)

    const result = readOrcaProfile(orca, listOrcaProfiles(orca)!, 'local-default', snapshots)

    expect(result.kind).toBe('torn')
    expect(censusOf(orca)).toEqual(before)
    expect(existsSync(snapshots) ? readdirSync(snapshots) : []).toEqual([])
  })

  it('finds nothing in a folder without an Orca profile', () => {
    const { orca } = scratch()
    mkdirSync(orca, { recursive: true })
    expect(listOrcaProfiles(orca)).toBeNull()
  })
})
