// Fork-only (Pod): reads an Orca profile without writing a byte of it: a clone, opened privately.
import { createHash, randomUUID } from 'node:crypto'
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  type Stats
} from 'node:fs'
import { basename, join } from 'node:path'
import {
  DEFAULT_LOCAL_ORCA_PROFILE_ID,
  DEFAULT_LOCAL_ORCA_PROFILE_NAME
} from '../../../shared/orca-profiles'
import {
  getOrcaProfileDataFile,
  getOrcaProfileStateDatabaseFile
} from '../../../shared/profile-state-storage-paths'
import { readProfileIndex } from '../../orca-profiles/profile-index-store'
import {
  getOrcaProfileIndexPath,
  legacyDataFilePath
} from '../../orca-profiles/profile-storage-paths'
import { openProfileStateDatabase } from '../../persistence/profile-state/profile-state-database'
import { readProfileStateDomainsWithRevisionFromDatabase } from '../../persistence/profile-state/profile-state-domain-reader'
import { parseProfileStateRoot } from '../../persistence/profile-state/profile-state-document-validation'

/** What the import reads; the rest of the profile is never opened. */
export const ORCA_IMPORT_DOMAINS = [
  'repos',
  'worktreeMeta',
  'settings',
  'projectGroups',
  'folderWorkspaces',
  'sshTargets',
  'automations'
] as const

export type OrcaProfileRef = { id: string; name: string }

export type OrcaProfileList = {
  activeProfileId: string
  profiles: OrcaProfileRef[]
  /** A profile from before Orca had profiles: its state is userData's own orca-data.json. */
  rootJsonOnly: boolean
}

export type OrcaProfileRead = {
  schema: 'current' | 'newer' | 'json'
  revision: string
  domains: ReadonlyMap<string, unknown>
}

export type OrcaProfileReadResult =
  | { kind: 'read'; read: OrcaProfileRead }
  | { kind: 'missing' }
  /** Both copies taken while Orca wrote were torn. */
  | { kind: 'torn'; message: string }
  | { kind: 'unreadable'; message: string }

export function listOrcaProfiles(userData: string): OrcaProfileList | null {
  const index = readProfileIndex(getOrcaProfileIndexPath(userData))
  if (index && index.profiles.length > 0) {
    return {
      activeProfileId: index.activeProfileId,
      profiles: index.profiles.map((profile) => ({ id: profile.id, name: profile.name })),
      rootJsonOnly: false
    }
  }
  if (existsSync(legacyDataFilePath(userData))) {
    return {
      activeProfileId: DEFAULT_LOCAL_ORCA_PROFILE_ID,
      profiles: [{ id: DEFAULT_LOCAL_ORCA_PROFILE_ID, name: DEFAULT_LOCAL_ORCA_PROFILE_NAME }],
      rootJsonOnly: true
    }
  }
  return null
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function statOrNull(path: string): Stats | null {
  try {
    return statSync(path)
  } catch {
    return null
  }
}

function sameStats(left: Stats | null, right: Stats | null): boolean {
  if (left === null || right === null) {
    return left === right
  }
  return left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs
}

// Why WAL first: a checkpoint between the two copies leaves the db newer than the WAL, which the
// copy replays without losing a commit. Why no -shm: SQLite rebuilds it from the WAL.
function cloneDatabase(databasePath: string, directory: string): boolean {
  const sources = [`${databasePath}-wal`, databasePath]
  const before = sources.map(statOrNull)
  for (const [index, source] of sources.entries()) {
    if (before[index] !== null) {
      copyFileSync(source, join(directory, basename(source)), constants.COPYFILE_FICLONE)
    }
  }
  return sources.every((source, index) => sameStats(before[index], statOrNull(source)))
}

function readClone(
  databasePath: string,
  profileId: string,
  snapshotRoot: string
): OrcaProfileReadResult {
  const directory = join(snapshotRoot, randomUUID())
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  try {
    if (!cloneDatabase(databasePath, directory)) {
      return { kind: 'torn', message: 'Orca changed its profile while it was copied' }
    }
    // Why open the clone with the migrating opener: an older Orca's schema upgrades in the copy.
    const opened = openProfileStateDatabase(join(directory, basename(databasePath)), profileId)
    try {
      const result = readProfileStateDomainsWithRevisionFromDatabase(opened.db, ORCA_IMPORT_DOMAINS)
      if (result.kind === 'unreadable') {
        return { kind: 'torn', message: errorMessage(result.error) }
      }
      return {
        kind: 'read',
        read: {
          schema: opened.readOnly ? 'newer' : 'current',
          revision: String(result.revision),
          domains: result.values
        }
      }
    } finally {
      opened.db.close()
    }
  } catch (error) {
    // quick_check runs inside the opener; a torn clone fails there.
    return { kind: 'torn', message: errorMessage(error) }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

// A legacy profile is read on the main thread; anything this big is not one.
const MAX_JSON_BYTES = 128 * 1024 * 1024

function readJson(path: string): OrcaProfileReadResult {
  let raw: string
  try {
    if (statSync(path).size > MAX_JSON_BYTES) {
      return { kind: 'unreadable', message: 'Orca’s profile file is too large to read.' }
    }
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    return { kind: 'unreadable', message: errorMessage(error) }
  }
  try {
    const root = parseProfileStateRoot(raw)
    const wanted = new Set<string>(ORCA_IMPORT_DOMAINS)
    return {
      kind: 'read',
      read: {
        schema: 'json',
        revision: createHash('sha256').update(raw).digest('hex'),
        domains: new Map(Object.entries(root).filter(([domain]) => wanted.has(domain)))
      }
    }
  } catch (error) {
    return { kind: 'unreadable', message: errorMessage(error) }
  }
}

/**
 * One still read of `profileId`: the database when there is one (cloned twice at most), else its
 * legacy JSON. `snapshotRoot` is Pod's own folder; each clone is removed once read.
 */
export function readOrcaProfile(
  userData: string,
  list: OrcaProfileList,
  profileId: string,
  snapshotRoot: string
): OrcaProfileReadResult {
  // Why first: a crash mid-read leaves a full copy of Orca's profile; reads never overlap (sync).
  rmSync(snapshotRoot, { recursive: true, force: true })
  if (list.rootJsonOnly) {
    return readJson(legacyDataFilePath(userData))
  }
  const databasePath = getOrcaProfileStateDatabaseFile(profileId, userData)
  if (existsSync(databasePath)) {
    const first = readClone(databasePath, profileId, snapshotRoot)
    return first.kind === 'torn' ? readClone(databasePath, profileId, snapshotRoot) : first
  }
  const jsonPath = getOrcaProfileDataFile(profileId, userData)
  return existsSync(jsonPath) ? readJson(jsonPath) : { kind: 'missing' }
}
