// Fork-only (Pod): "Import from Orca" over podImport.*: what a native client previews and applies.

export const POD_ORCA_IMPORT_RPC = {
  detect: 'podImport.orcaDetect',
  preview: 'podImport.orcaPreview',
  apply: 'podImport.orcaApply'
} as const

/** Why the import can't read Orca at all here; the client names it and offers nothing else. */
export type PodOrcaImportRefusal =
  /** A dev, E2E, bench or custom-profile Pod: it reads only POD_ORCA_IMPORT_SOURCE_DIR. */
  | 'not-the-users-pod'
  /** POD_ORCA_IMPORT_SOURCE_DIR names the account's real Orca profile from a non-default Pod. */
  | 'source-is-the-real-profile'
  /** This build has no Orca lineage (identity without legacyProfile). */
  | 'no-legacy-identity'

export type PodOrcaImportDetect =
  | {
      found: true
      orcaRunning: boolean
      /** The last import into this Pod profile, ISO time. */
      lastImportAt: string | null
    }
  | { found: false; refused?: PodOrcaImportRefusal }

export type PodOrcaImportItemKind =
  | 'repo'
  | 'worktree'
  | 'setting'
  | 'theme'
  | 'quickCommand'
  | 'keybinding'

/**
 * - `new`: Pod has none; imported when selected.
 * - `update`: Pod has it; the import fills only what Pod leaves empty.
 * - `conflict`: Pod has its own value; selecting it replaces Pod's with Orca's.
 * - `present`: Pod already has the same thing; nothing to do.
 * - `missing`: Orca names a folder that no longer exists on this Mac.
 * - `unsupported`: not imported by this version (remote projects, folder workspaces).
 * - `shared`: Pod and Orca use the same file, so there is nothing to copy.
 */
export type PodOrcaImportItemState =
  | 'new'
  | 'update'
  | 'conflict'
  | 'present'
  | 'missing'
  | 'unsupported'
  | 'shared'

export type PodOrcaImportItem = {
  /** Stable across previews of the same source: `repo:<path>`, `setting:<key>`, ... */
  id: string
  kind: PodOrcaImportItemKind
  state: PodOrcaImportItemState
  title: string
  /** A path, or "Orca: <value>" next to "Pod: <value>" for a setting. */
  detail?: string
  orcaValue?: string
  podValue?: string
  /** Selected by default: `new` and `update`, never `conflict`. */
  selected: boolean
  /** A worktree's project item; applying the worktree also applies it when it is `new`. */
  parentId?: string
}

/** What stays in Orca, by kind, so the client can say so without listing every row. */
export type PodOrcaImportLeftBehind = {
  kind:
    | 'terminals'
    | 'sessions'
    | 'browser'
    | 'accounts'
    | 'pairedDevices'
    | 'sshTargets'
    | 'automations'
    | 'projectGroups'
    | 'hookSettings'
    | 'encryptedSettings'
  count: number | null
}

export type PodOrcaImportSource = {
  userData: string
  profileId: string
  profileName: string | null
  profiles: { id: string; name: string }[]
  /** `newer`: a newer Orca wrote it, so fields this Pod doesn't know stay behind. */
  schema: 'current' | 'newer' | 'json'
  /** Orca's profile revision, or a content hash for a JSON-only profile. */
  revision: string
  orcaRunning: boolean
}

export type PodOrcaImportPreview =
  | {
      status: 'ready'
      previewId: string
      source: PodOrcaImportSource
      items: PodOrcaImportItem[]
      leftBehind: PodOrcaImportLeftBehind[]
      lastImportAt: string | null
    }
  | { status: 'not-found' }
  | { status: 'refused'; reason: PodOrcaImportRefusal }
  /** The copy taken while Orca wrote was torn twice; quitting Orca gives a still one. */
  | { status: 'orca-busy' }
  | { status: 'unreadable'; message: string }

export type PodOrcaImportItemOutcome = {
  id: string
  outcome: 'imported' | 'skipped' | 'failed'
  message?: string
}

export type PodOrcaImportApplyResult =
  | { status: 'applied'; results: PodOrcaImportItemOutcome[]; recordedAt: string }
  /** Orca writes its profile while it runs; Pod never quits it, the user does. */
  | { status: 'orca-running'; pid: number }
  /** Orca's profile changed since this preview; preview again. */
  | { status: 'stale-preview' }
  | { status: 'not-found' }
  | { status: 'refused'; reason: PodOrcaImportRefusal }
  | { status: 'orca-busy' }
  | { status: 'unreadable'; message: string }
