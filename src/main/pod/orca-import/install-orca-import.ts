// Fork-only (Pod): podImport.* over the live store and runtime; off without Orca in Pod's identity.
import { homedir } from 'node:os'
import { app } from 'electron'
import { getDefaultSettings } from '../../../shared/constants'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { Repo } from '../../../shared/repo-types'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import { getProductIdentity, type ProductIdentity } from '../../product-identity/product-identity'
import { accountHome } from '../instance/pod-instance'
import { podHookWriteBlockNow } from '../instance/pod-hook-write-block'
import { getPodSettingsWriter } from '../settings/pod-settings-writer'
import { orcaImportInstanceBlock, resolveOrcaImportLocation } from './orca-import-location'
import { OrcaImportService, setOrcaImportService } from './orca-import-service'

type OrcaImportStore = {
  getRepos(): Repo[]
  getAllWorktreeMeta(): Record<string, WorktreeMeta>
  getSettings(): GlobalSettings
}

type OrcaImportRuntime = {
  addRepo(
    path: string,
    kind: 'git' | 'folder',
    hostId: undefined,
    displayName: string
  ): Promise<Repo>
  updateRepo(selector: string, updates: Partial<Repo>): Promise<Repo>
  updateManagedWorktreeMeta(selector: string, updates: Partial<WorktreeMeta>): Promise<unknown>
}

type OrcaImportKeybindings = { path(): string; reload(): void }

function identityOrNull(): ProductIdentity | null {
  try {
    return getProductIdentity()
  } catch {
    return null
  }
}

// decouple-v3 adds legacyProfile.homeDirName; before it Pod reads Orca's own home folder.
function legacyHomeDirName(identity: ProductIdentity): string | null {
  const value: unknown = identity.legacyProfile
    ? Reflect.get(identity.legacyProfile, 'homeDirName')
    : undefined
  return typeof value === 'string' && value.length > 0 ? value : null
}

// Orca's userData name for a test runtime without Pod's identity; such a runtime reads only
// POD_ORCA_IMPORT_SOURCE_DIR (orca-import-location.ts), so the name only fences the real one off.
const ORCA_USER_DATA_NAME = 'orca'

/** Pod builds only. `POD_ORCA_IMPORT_RPC=0|1` overrides the identity, for tests. */
export function orcaImportLegacyProfile(
  env: NodeJS.ProcessEnv = process.env,
  identity: ProductIdentity | null = identityOrNull()
): { userDataName: string; homeDirName: string | null } | null {
  if (env.POD_ORCA_IMPORT_RPC === '0') {
    return null
  }
  if (identity?.legacyProfile) {
    return {
      userDataName: identity.legacyProfile.userDataName,
      homeDirName: legacyHomeDirName(identity)
    }
  }
  return env.POD_ORCA_IMPORT_RPC === '1'
    ? { userDataName: ORCA_USER_DATA_NAME, homeDirName: null }
    : null
}

export function installOrcaImport(
  store: OrcaImportStore,
  runtime: OrcaImportRuntime,
  keybindings: OrcaImportKeybindings | null
): void {
  const legacy = orcaImportLegacyProfile()
  if (!legacy) {
    return
  }
  setOrcaImportService(
    new OrcaImportService({
      resolve: () =>
        resolveOrcaImportLocation({
          legacyUserDataName: legacy.userDataName,
          legacyHomeDirName: legacy.homeDirName,
          appDataPath: app.getPath('appData'),
          homePath: homedir(),
          accountHome: accountHome(),
          instanceBlock: orcaImportInstanceBlock(process.env, podHookWriteBlockNow),
          env: process.env
        }),
      podUserData: app.getPath('userData'),
      getAllWorktreeMeta: () => store.getAllWorktreeMeta(),
      defaultSettings: () => getDefaultSettings(homedir()),
      ports: {
        getRepos: () => store.getRepos(),
        getSettings: () => store.getSettings(),
        addRepo: (path, kind, hostId, displayName) =>
          runtime.addRepo(path, kind, hostId, displayName),
        updateRepo: (selector, updates) => runtime.updateRepo(selector, updates),
        updateWorktreeMeta: (selector, updates) =>
          runtime.updateManagedWorktreeMeta(selector, updates),
        writeSettings: (values) => {
          const write = getPodSettingsWriter()
          if (!write) {
            throw new Error('Pod settings have no write path yet.')
          }
          return write(values)
        },
        keybindings,
        platform: process.platform
      }
    })
  )
}
