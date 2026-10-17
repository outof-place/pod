// Fork-only (Pod): podImport.*: detect, preview and apply an import from the user's Orca profile.
import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type {
  PodOrcaImportApplyResult,
  PodOrcaImportDetect,
  PodOrcaImportPreview
} from '../../../shared/pod-orca-import-types'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import { defaultIsProcessAlive } from '../../product-identity/legacy-daemon-handover'
import { liveSingletonOwner } from '../../product-identity/legacy-profile-migration'
import { applyOrcaImport, type OrcaImportApplyPorts } from './orca-import-apply'
import type { OrcaImportLocation, OrcaImportResolution } from './orca-import-location'
import { buildOrcaImportPlan, type OrcaImportPlan } from './orca-import-plan'
import type { OrcaImportFsProbe } from './orca-import-plan-repos'
import { appendOrcaImportRecord, lastOrcaImportAt } from './orca-import-record'
import {
  listOrcaProfiles,
  readOrcaProfile,
  type OrcaProfileList,
  type OrcaProfileRead
} from './orca-import-source'

export type OrcaImportServiceDeps = {
  resolve(): OrcaImportResolution
  podUserData: string
  ports: OrcaImportApplyPorts
  getAllWorktreeMeta(): Record<string, WorktreeMeta>
  defaultSettings(): GlobalSettings
  fs?: OrcaImportFsProbe
  isProcessAlive?: (pid: number) => boolean
  now?: () => Date
}

type CachedPreview = { userData: string; profileId: string; revision: string }

const KEPT_PREVIEWS = 8
const KEYBINDINGS_FILE = 'keybindings.json'

const statFs: OrcaImportFsProbe = {
  isDirectory: (path) => {
    try {
      return statSync(path).isDirectory()
    } catch {
      return false
    }
  },
  isGitCheckout: (path) => existsSync(join(path, '.git'))
}

type SourceRead =
  | {
      kind: 'read'
      location: OrcaImportLocation
      list: OrcaProfileList
      profileId: string
      read: OrcaProfileRead
    }
  | { kind: 'stop'; result: Exclude<PodOrcaImportPreview, { status: 'ready' }> }

export class OrcaImportService {
  private readonly previews = new Map<string, CachedPreview>()
  private applying: Promise<unknown> = Promise.resolve()

  constructor(private readonly deps: OrcaImportServiceDeps) {}

  private orcaPid(userData: string): number | null {
    return liveSingletonOwner(userData, this.deps.isProcessAlive ?? defaultIsProcessAlive)
  }

  detect(): PodOrcaImportDetect {
    const resolution = this.deps.resolve()
    if (resolution.kind === 'refused') {
      return { found: false, refused: resolution.reason }
    }
    const { userData } = resolution.location
    if (!listOrcaProfiles(userData)) {
      return { found: false }
    }
    return {
      found: true,
      orcaRunning: this.orcaPid(userData) !== null,
      lastImportAt: lastOrcaImportAt(this.deps.podUserData)
    }
  }

  private readSource(profileId: string | undefined): SourceRead {
    const resolution = this.deps.resolve()
    if (resolution.kind === 'refused') {
      return { kind: 'stop', result: { status: 'refused', reason: resolution.reason } }
    }
    const { location } = resolution
    const list = listOrcaProfiles(location.userData)
    const chosen = profileId ?? list?.activeProfileId
    if (!list || !chosen || !list.profiles.some((profile) => profile.id === chosen)) {
      return { kind: 'stop', result: { status: 'not-found' } }
    }
    const result = readOrcaProfile(
      location.userData,
      list,
      chosen,
      join(this.deps.podUserData, 'orca-import-snapshots')
    )
    switch (result.kind) {
      case 'read':
        return { kind: 'read', location, list, profileId: chosen, read: result.read }
      case 'missing':
        return { kind: 'stop', result: { status: 'not-found' } }
      case 'torn':
        return {
          kind: 'stop',
          result:
            this.orcaPid(location.userData) === null
              ? { status: 'unreadable', message: result.message }
              : { status: 'orca-busy' }
        }
      case 'unreadable':
        return { kind: 'stop', result: { status: 'unreadable', message: result.message } }
    }
  }

  private plan(location: OrcaImportLocation, read: OrcaProfileRead): OrcaImportPlan {
    const { ports } = this.deps
    const podKeybindings = ports.keybindings?.path() ?? null
    const orcaKeybindings = location.legacyHome
      ? join(location.legacyHome, KEYBINDINGS_FILE)
      : location.sharesPodHome
        ? podKeybindings
        : null
    return buildOrcaImportPlan({
      orca: read.domains,
      pod: {
        repos: ports.getRepos(),
        worktreeMeta: this.deps.getAllWorktreeMeta(),
        settings: ports.getSettings(),
        defaults: this.deps.defaultSettings()
      },
      keybindings: podKeybindings ? { orcaPath: orcaKeybindings, podPath: podKeybindings } : null,
      fs: this.deps.fs ?? statFs,
      platform: ports.platform
    })
  }

  preview(profileId?: string): PodOrcaImportPreview {
    const source = this.readSource(profileId)
    if (source.kind === 'stop') {
      return source.result
    }
    const { location, list, read } = source
    const plan = this.plan(location, read)
    const previewId = randomUUID()
    this.previews.set(previewId, {
      userData: location.userData,
      profileId: source.profileId,
      revision: read.revision
    })
    for (const key of [...this.previews.keys()].slice(0, -KEPT_PREVIEWS)) {
      this.previews.delete(key)
    }
    return {
      status: 'ready',
      previewId,
      source: {
        userData: location.userData,
        profileId: source.profileId,
        profileName: list.profiles.find((profile) => profile.id === source.profileId)?.name ?? null,
        profiles: list.profiles,
        schema: read.schema,
        revision: read.revision,
        orcaRunning: this.orcaPid(location.userData) !== null
      },
      items: plan.items,
      leftBehind: plan.leftBehind,
      lastImportAt: lastOrcaImportAt(this.deps.podUserData)
    }
  }

  apply(previewId: string, itemIds: readonly string[]): Promise<PodOrcaImportApplyResult> {
    // Why one at a time: two applies would both add the same projects from one stale plan.
    const run = this.applying.then(() => this.applyNow(previewId, itemIds))
    this.applying = run.catch(() => undefined)
    return run
  }

  private async applyNow(
    previewId: string,
    itemIds: readonly string[]
  ): Promise<PodOrcaImportApplyResult> {
    const cached = this.previews.get(previewId)
    const resolution = this.deps.resolve()
    if (resolution.kind === 'refused') {
      return { status: 'refused', reason: resolution.reason }
    }
    if (!cached || cached.userData !== resolution.location.userData) {
      return { status: 'stale-preview' }
    }
    const pid = this.orcaPid(cached.userData)
    if (pid !== null) {
      return { status: 'orca-running', pid }
    }
    const source = this.readSource(cached.profileId)
    if (source.kind === 'stop') {
      return source.result
    }
    if (source.read.revision !== cached.revision) {
      return { status: 'stale-preview' }
    }
    const results = await applyOrcaImport(
      this.plan(source.location, source.read),
      itemIds,
      this.deps.ports
    )
    this.previews.delete(previewId)
    const entry = appendOrcaImportRecord(
      this.deps.podUserData,
      { userData: cached.userData, profileId: cached.profileId, revision: cached.revision },
      results,
      this.deps.now?.() ?? new Date()
    )
    return { status: 'applied', results, recordedAt: entry.at }
  }
}

let installed: OrcaImportService | null = null

export function setOrcaImportService(service: OrcaImportService | null): void {
  installed = service
}

export function getOrcaImportService(): OrcaImportService | null {
  return installed
}
