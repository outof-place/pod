import {
  chmodSync,
  cpSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'

/** One-time record in the product's userData, so a legacy app that runs again keeps its folder. */
export const PRODUCT_HOME_COPY_RECORD = 'product-home-copy.json'

// The product writes these afresh at startup, and sessions started before the copy keep running
// them from the legacy folder (Claude's settings.json hooks, Agent Teams shims).
const REGENERATED_ENTRIES = new Set(['agent-hooks', 'claude-agent-teams-bin'])

const HOOK_FOLDER = 'agent-hooks'

/**
 * Files in the legacy hook folder that only the product writes (the legacy app writes the folder's
 * other names too, so a pattern could take one of its files). Each is moved to the product's hook
 * folder and a link to it left in its place for one release: sessions, Claude settings and
 * ~/.claude.json entries from before the move still run them, now the product's current copy.
 * TODO(pod): drop the links after 2026-12-31, and no earlier than the release after the decouple.
 */
export const PRODUCT_ONLY_HOOK_ENTRIES = [
  'pod-agent-hook', // pod-agent-hook-native.ts POD_AGENT_HOOK_FILE_NAME
  'pod-agent-statusline', // pod-statusline-native.ts POD_AGENT_STATUSLINE_FILE_NAME
  'mcp-lazy', // mcp-lazy-binary.ts MCP_LAZY_FILE_NAME
  'claude-settings-migration.json' // PodNative's ClaudeHooksMove record
] as const

export type LegacyHomeCopyResult =
  | { status: 'copied'; copied: string[]; skipped: string[]; moved: string[] }
  | {
      status: 'not-needed'
      reason: 'already-recorded' | 'no-legacy-home' | 'legacy-home-is-a-link'
    }
  | { status: 'deferred'; reason: 'legacy-app-running'; pid: number; moved: string[] }

export type LegacyHomeCopyOptions = {
  home: string
  legacyHomeDirName: string
  productHomeDirName: string
  productUserData: string
  /** Live pid of the legacy app, or null; a copy taken while it writes could be torn. */
  legacyAppPid: number | null
  now?: () => Date
}

// Why: fs.cpSync documents no mode guarantee, and saved keys (0600) or private folders (0700) must
// not widen. Children first, so a folder without owner write is chmodded last.
function keepModes(source: string, copy: string): void {
  const stat = lstatSync(source)
  if (stat.isSymbolicLink()) {
    return
  }
  if (stat.isDirectory()) {
    for (const entry of readdirSync(source)) {
      keepModes(join(source, entry), join(copy, entry))
    }
  }
  chmodSync(copy, stat.mode & 0o7777)
}

/** Whether `path` is another name of the file `of` describes: both names of a hard link. */
function isHardLinkOf(path: string, of: { ino: number; dev: number }): boolean {
  try {
    const stat = lstatSync(path)
    return stat.ino === of.ino && stat.dev === of.dev
  } catch {
    return false
  }
}

/**
 * Moves the product-only hook files that are still plain files (a link is an earlier move, and a
 * file the product folder already has stays where it is). The product's copy appears before the
 * link replaces the original, so the old path never goes missing for a hook that runs meanwhile.
 */
function moveProductOnlyHookEntries(legacyHome: string, productHome: string): string[] {
  const legacyHooks = join(legacyHome, HOOK_FOLDER)
  const productHooks = join(productHome, HOOK_FOLDER)
  const moved: string[] = []
  for (const name of PRODUCT_ONLY_HOOK_ENTRIES) {
    const source = join(legacyHooks, name)
    const target = join(productHooks, name)
    let stat
    try {
      stat = lstatSync(source)
    } catch {
      continue
    }
    if (!stat.isFile()) {
      continue
    }
    // Why: a move cut short between its hard link and the swap leaves both names on one file, and
    // the product's next rewrite of its name (temp + rename) would leave the old path behind.
    const linked = isHardLinkOf(target, stat)
    if (!linked && existsSync(target)) {
      continue
    }
    if (!linked) {
      // Modes apply only to folders made here, as for the copied entries.
      mkdirSync(productHome, { recursive: true, mode: lstatSync(legacyHome).mode & 0o777 })
      mkdirSync(productHooks, { recursive: true, mode: lstatSync(legacyHooks).mode & 0o777 })
      try {
        linkSync(source, target)
      } catch {
        // Why a copy: a home folder on two volumes can't hard-link; staged like the entry copies.
        const staging = join(productHooks, `.${name}.pod-copying`)
        rmSync(staging, { force: true })
        cpSync(source, staging, { errorOnExist: true, force: false, preserveTimestamps: true })
        chmodSync(staging, stat.mode & 0o7777)
        renameSync(staging, target)
      }
    }
    const link = join(legacyHooks, `.${name}.pod-link`)
    rmSync(link, { force: true })
    symlinkSync(target, link)
    renameSync(link, source)
    moved.push(name)
  }
  return moved
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
  // Why before the legacy app check: it never writes these names, so its running doesn't matter.
  const moved = moveProductOnlyHookEntries(legacyHome, productHome)
  if (options.legacyAppPid !== null) {
    return { status: 'deferred', reason: 'legacy-app-running', pid: options.legacyAppPid, moved }
  }
  // Mode applies only when the folder is new: a product folder that exists keeps its own.
  mkdirSync(productHome, { recursive: true, mode: lstatSync(legacyHome).mode & 0o777 })
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
    keepModes(join(legacyHome, entry), staging)
    renameSync(staging, target)
    copied.push(entry)
  }
  return record({ status: 'copied', copied, skipped, moved })
}
