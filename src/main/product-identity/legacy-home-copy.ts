import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'

/** One-time record in the product's userData, so a legacy app that runs again keeps its folder. */
export const PRODUCT_HOME_COPY_RECORD = 'product-home-copy.json'

// The product writes these afresh at startup, and sessions started before the copy keep running
// them from the legacy folder (Claude's settings.json hooks, Agent Teams shims).
const REGENERATED_ENTRIES = new Set(['agent-hooks', 'claude-agent-teams-bin'])

export type LegacyHomeCopyResult =
  | { status: 'copied'; copied: string[]; skipped: string[] }
  | {
      status: 'not-needed'
      reason: 'already-recorded' | 'no-legacy-home' | 'legacy-home-is-a-link'
    }
  | { status: 'deferred'; reason: 'legacy-app-running'; pid: number }

export type LegacyHomeCopyOptions = {
  home: string
  legacyHomeDirName: string
  productHomeDirName: string
  productUserData: string
  /** Live pid of the legacy app, or null; a copy taken while it writes could be torn. */
  legacyAppPid: number | null
  now?: () => Date
}

function readRecord(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Copies `~/<legacy>` (keybindings, saved API keys) into `~/<product>` once, entry by entry: never
 * over the product's own, and never the hook scripts and shims the product regenerates. The legacy
 * folder is left as it was, so processes still using it keep working and the copy can be undone by
 * deleting the entries the record lists.
 */
export function copyLegacyHome(options: LegacyHomeCopyOptions): LegacyHomeCopyResult {
  const recordPath = join(options.productUserData, PRODUCT_HOME_COPY_RECORD)
  if (readRecord(recordPath) !== null) {
    return { status: 'not-needed', reason: 'already-recorded' }
  }
  const legacyHome = join(options.home, options.legacyHomeDirName)
  const productHome = join(options.home, options.productHomeDirName)
  const record = (result: LegacyHomeCopyResult): LegacyHomeCopyResult => {
    const at = (options.now?.() ?? new Date()).toISOString()
    mkdirSync(options.productUserData, { recursive: true })
    writeFileSync(
      recordPath,
      `${JSON.stringify({ at, from: legacyHome, to: productHome, result })}\n`
    )
    return result
  }
  // Why record a no-op too: a legacy app installed later keeps the folder it creates.
  if (!existsSync(legacyHome)) {
    return record({ status: 'not-needed', reason: 'no-legacy-home' })
  }
  // Why: a link means someone shares the folder on purpose; the product would read it twice.
  if (lstatSync(legacyHome).isSymbolicLink()) {
    return record({ status: 'not-needed', reason: 'legacy-home-is-a-link' })
  }
  if (options.legacyAppPid !== null) {
    return { status: 'deferred', reason: 'legacy-app-running', pid: options.legacyAppPid }
  }
  mkdirSync(productHome, { recursive: true })
  const copied: string[] = []
  const skipped: string[] = []
  for (const entry of readdirSync(legacyHome).sort()) {
    const target = join(productHome, entry)
    if (REGENERATED_ENTRIES.has(entry) || existsSync(target)) {
      skipped.push(entry)
      continue
    }
    // Why a staging name: a copy cut short must not look finished to the next launch's retry.
    const staging = join(productHome, `.${entry}.pod-copying`)
    rmSync(staging, { recursive: true, force: true })
    cpSync(join(legacyHome, entry), staging, {
      recursive: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
      verbatimSymlinks: true
    })
    renameSync(staging, target)
    copied.push(entry)
  }
  return record({ status: 'copied', copied, skipped })
}
