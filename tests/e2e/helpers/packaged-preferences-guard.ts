/**
 * Fork-only (Pod): on macOS 27 cfprefsd writes to the account's real ~/Library/Preferences whatever
 * HOME or CFFIXED_USER_HOME say, so a packaged run on an isolated profile still writes the real
 * defaults of the bundle ids it runs: the user's own Pod and PodNative. Export them before the run
 * and put them back after it.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const PACKAGED_POD_DOMAINS = ['codes.pod.app', 'codes.pod.native'] as const

export type PreferencesBackup = { dir: string; saved: Map<string, string | null> }

function defaults(args: readonly string[]): { status: number | null; stderr: string } {
  const result = spawnSync('/usr/bin/defaults', args, { encoding: 'utf8' })
  return { status: result.status, stderr: result.stderr }
}

export function backupPreferences(
  domains: readonly string[] = PACKAGED_POD_DOMAINS
): PreferencesBackup {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pod-prefs-backup-'))
  const saved = new Map<string, string | null>()
  for (const domain of domains) {
    const file = path.join(dir, `${domain}.plist`)
    // `defaults export` fails for a domain that has never been written.
    saved.set(domain, defaults(['export', domain, file]).status === 0 ? file : null)
  }
  return { dir, saved }
}

/** Puts each domain back as it was: imported from the export, or deleted when there was none. */
export function restorePreferences(backup: PreferencesBackup): string[] {
  const problems: string[] = []
  for (const [domain, file] of backup.saved) {
    const result =
      file && existsSync(file) ? defaults(['import', domain, file]) : defaults(['delete', domain])
    // `defaults delete` of a domain that still doesn't exist exits 1 with "does not exist".
    if (result.status !== 0 && !(file === null && /does not exist/.test(result.stderr))) {
      problems.push(`${domain}: ${result.stderr.trim()}`)
    }
  }
  rmSync(backup.dir, { recursive: true, force: true })
  return problems
}
