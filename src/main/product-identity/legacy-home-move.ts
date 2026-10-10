import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'

/** One-time record in the product's userData, so a legacy app that runs again keeps its folder. */
export const PRODUCT_HOME_MOVE_RECORD = 'product-home-move.json'

// The product writes these afresh at startup, so an existing product home never takes them.
const REGENERATED_ENTRIES = new Set(['agent-hooks', 'claude-agent-teams-bin'])

export type LegacyHomeMoveResult =
  | { status: 'moved' }
  | { status: 'merged'; moved: string[]; skipped: string[] }
  | {
      status: 'not-needed'
      reason: 'already-recorded' | 'no-legacy-home' | 'legacy-home-is-a-link'
    }
  | { status: 'deferred'; reason: 'legacy-app-running'; pid: number }

export type LegacyHomeMoveOptions = {
  home: string
  legacyHomeDirName: string
  productHomeDirName: string
  productUserData: string
  /** Live pid of the legacy app, or null; its open files would follow the move. */
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
 * Moves `~/<legacy>` (hook scripts, keybindings, saved API keys) to `~/<product>` once. A rename
 * when the product has no home yet; otherwise entry by entry, never over the product's own.
 */
export function moveLegacyHome(options: LegacyHomeMoveOptions): LegacyHomeMoveResult {
  const recordPath = join(options.productUserData, PRODUCT_HOME_MOVE_RECORD)
  if (readRecord(recordPath) !== null) {
    return { status: 'not-needed', reason: 'already-recorded' }
  }
  const legacyHome = join(options.home, options.legacyHomeDirName)
  const productHome = join(options.home, options.productHomeDirName)
  const record = (result: LegacyHomeMoveResult): LegacyHomeMoveResult => {
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
  // Why: a link means someone shares the folder on purpose; moving it would move their target.
  if (lstatSync(legacyHome).isSymbolicLink()) {
    return record({ status: 'not-needed', reason: 'legacy-home-is-a-link' })
  }
  if (options.legacyAppPid !== null) {
    return { status: 'deferred', reason: 'legacy-app-running', pid: options.legacyAppPid }
  }
  if (existsSync(productHome)) {
    const moved: string[] = []
    const skipped: string[] = []
    for (const entry of readdirSync(legacyHome).sort()) {
      if (REGENERATED_ENTRIES.has(entry) || existsSync(join(productHome, entry))) {
        skipped.push(entry)
        continue
      }
      renameSync(join(legacyHome, entry), join(productHome, entry))
      moved.push(entry)
    }
    return record({ status: 'merged', moved, skipped })
  }
  renameSync(legacyHome, productHome)
  return record({ status: 'moved' })
}
