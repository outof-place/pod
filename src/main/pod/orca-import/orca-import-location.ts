// Fork-only (Pod): which Orca profile the import may read, and never the user's from a test Pod.
import { realpathSync } from 'node:fs'
import { join, relative, resolve, isAbsolute } from 'node:path'
import type { PodOrcaImportRefusal } from '../../../shared/pod-orca-import-types'

/** The only source a dev, E2E, bench or custom-profile Pod reads: a synthetic Orca userData. */
export const ORCA_IMPORT_SOURCE_DIR_ENV = 'POD_ORCA_IMPORT_SOURCE_DIR'
/** That source's home folder (Orca's keybindings); unset means none. */
export const ORCA_IMPORT_SOURCE_HOME_ENV = 'POD_ORCA_IMPORT_SOURCE_HOME'

export type OrcaImportLocation = {
  userData: string
  /** Orca's home folder (its keybindings), when it is not Pod's. */
  legacyHome: string | null
  /** Before decouple Pod and Orca share one home folder, so there is nothing to copy from it. */
  sharesPodHome: boolean
}

export type OrcaImportResolution =
  | { kind: 'source'; location: OrcaImportLocation }
  | { kind: 'refused'; reason: PodOrcaImportRefusal }

export type OrcaImportLocationInput = {
  legacyUserDataName: string | null
  legacyHomeDirName: string | null
  appDataPath: string
  homePath: string
  /** getpwuid's home: where the account's real Orca lives, whatever HOME says. */
  accountHome: string | null
  /** podHookWriteBlockNow(): null only for the user's own Pod. */
  instanceBlock: string | null
  env: NodeJS.ProcessEnv
}

/**
 * podHookWriteBlockNow() says null for an E2E launch with its own home (its hook files land there),
 * but its appData still names the account's real Orca, so the import counts every E2E launch out.
 */
export function orcaImportInstanceBlock(
  env: NodeJS.ProcessEnv,
  hookWriteBlock: () => string | null
): string | null {
  if (env.ORCA_E2E_USER_DATA_DIR || env.POD_E2E_USER_DATA_DIR) {
    return 'e2e'
  }
  return hookWriteBlock()
}

function canonical(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

function isInside(path: string, root: string): boolean {
  const rel = relative(canonical(root), canonical(path))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function nonEmpty(value: string | undefined): string | null {
  return value !== undefined && value.trim().length > 0 ? value : null
}

export function resolveOrcaImportLocation(input: OrcaImportLocationInput): OrcaImportResolution {
  const { legacyUserDataName, legacyHomeDirName } = input
  if (!legacyUserDataName) {
    return { kind: 'refused', reason: 'no-legacy-identity' }
  }
  if (input.instanceBlock === null) {
    return {
      kind: 'source',
      location: {
        userData: join(input.appDataPath, legacyUserDataName),
        legacyHome: legacyHomeDirName ? join(input.homePath, legacyHomeDirName) : null,
        sharesPodHome: !legacyHomeDirName
      }
    }
  }
  const sourceDir = nonEmpty(input.env[ORCA_IMPORT_SOURCE_DIR_ENV])
  if (!sourceDir) {
    return { kind: 'refused', reason: 'not-the-users-pod' }
  }
  const sourceHome = nonEmpty(input.env[ORCA_IMPORT_SOURCE_HOME_ENV])
  // Why the account's home: a synthetic source lives outside it (/private/tmp), and a test Pod's
  // HOME or appData can point anywhere, so neither proves a path isn't the user's real Orca.
  const accountHome = input.accountHome
  if (
    accountHome === null ||
    canonical(sourceDir) === canonical(join(input.appDataPath, legacyUserDataName)) ||
    isInside(sourceDir, accountHome) ||
    (sourceHome !== null && isInside(sourceHome, accountHome))
  ) {
    return { kind: 'refused', reason: 'source-is-the-real-profile' }
  }
  return {
    kind: 'source',
    location: {
      userData: resolve(sourceDir),
      legacyHome: sourceHome ? resolve(sourceHome) : null,
      sharesPodHome: false
    }
  }
}
