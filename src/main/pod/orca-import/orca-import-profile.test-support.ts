// Fork-only (Pod): a synthetic Orca userData built with Pod's own writer, and a byte-level census.
import { createHash } from 'node:crypto'
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { join, relative } from 'node:path'
import { getOrcaProfileStateDatabaseFile } from '../../../shared/profile-state-storage-paths'
import { openProfileStateDatabase } from '../../persistence/profile-state/profile-state-database'
import { importProfileStateJson } from '../../persistence/profile-state/profile-state-documents'

export type SyntheticOrcaProfile = {
  profileId?: string
  state: Record<string, unknown>
  /** A fake terminal daemon's files, which the import must never touch. */
  withDaemonFiles?: boolean
  /** A Chromium SingletonLock naming this pid, as a running Orca leaves. */
  runningPid?: number
}

export function writeSyntheticOrcaProfile(userData: string, profile: SyntheticOrcaProfile): void {
  const profileId = profile.profileId ?? 'local-default'
  mkdirSync(userData, { recursive: true })
  writeFileSync(
    join(userData, 'orca-profile-index.json'),
    JSON.stringify({
      schemaVersion: 1,
      activeProfileId: profileId,
      profiles: [
        {
          id: profileId,
          name: 'Personal',
          avatar: { kind: 'initials', initials: 'P', color: 'neutral' },
          kind: 'local',
          createdAt: 1,
          updatedAt: 1,
          lastOpenedAt: 1
        }
      ]
    })
  )
  const databasePath = getOrcaProfileStateDatabaseFile(profileId, userData)
  mkdirSync(join(userData, 'profiles', profileId), { recursive: true })
  const opened = openProfileStateDatabase(databasePath, profileId)
  importProfileStateJson(opened.db, JSON.stringify(profile.state))
  opened.db.close()
  if (profile.withDaemonFiles) {
    mkdirSync(join(userData, 'daemon'), { recursive: true })
    writeFileSync(join(userData, 'daemon', 'daemon-v41.pid'), '{"pid":999999}\n')
    writeFileSync(join(userData, 'daemon', 'daemon-v41.token'), 'not-a-real-token\n')
  }
  if (profile.runningPid !== undefined) {
    symlinkSync(`test-host-${profile.runningPid}`, join(userData, 'SingletonLock'))
  }
}

/** Every entry under `root` with its type, mode, size, mtime and content hash. */
export function censusOf(root: string): Map<string, string> {
  const census = new Map<string, string>()
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name)
      const stat = lstatSync(path)
      const key = relative(root, path)
      if (stat.isSymbolicLink()) {
        census.set(key, `link ${readlinkSync(path)} ${stat.mtimeMs}`)
      } else if (stat.isDirectory()) {
        census.set(key, `dir ${stat.mode} ${stat.mtimeMs}`)
        walk(path)
      } else {
        const hash = createHash('sha256').update(readFileSync(path)).digest('hex')
        census.set(key, `file ${stat.mode} ${stat.size} ${stat.mtimeMs} ${hash}`)
      }
    }
  }
  walk(root)
  return census
}
