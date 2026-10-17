// The account's own Claude files, which a suite that runs app code must leave alone: the real
// ~/.claude/settings.json and every file in ~/.orca/agent-hooks and ~/.pod/agent-hooks (the home
// from the user database, not HOME), compared by content before and after.
//
// A rewrite with the same bytes is reported, not tripped on: the user's live Pod runs its
// managed-hook installer at every start and rewrites settings.json unchanged. A write from a run
// would differ, since its paths point into /private/tmp. ~/.claude.json is rewritten by every live
// Claude session, so it trips only when its content names the run's dir.
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const REAL_HOME = os.userInfo().homedir

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

export function realHomeState() {
  const files = [path.join(REAL_HOME, '.claude/settings.json')]
  for (const dir of ['.orca/agent-hooks', '.pod/agent-hooks']) {
    const full = path.join(REAL_HOME, dir)
    if (existsSync(full)) {
      files.push(
        ...readdirSync(full)
          .map((name) => path.join(full, name))
          .filter((file) => statSync(file).isFile())
      )
    }
  }
  return Object.fromEntries(
    files
      .filter((file) => existsSync(file))
      .map((file) => [file, { sha256: sha256(file), mtimeMs: statSync(file).mtimeMs }])
  )
}

/** Throws when a file changed or came or went; returns the files rewritten with the same bytes. */
export function assertRealHomeUntouched(before, where, runDir) {
  const after = realHomeState()
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (file) => before[file]?.sha256 !== after[file]?.sha256
  )
  const claudeJson = path.join(REAL_HOME, '.claude.json')
  if (existsSync(claudeJson) && readFileSync(claudeJson, 'utf8').includes(runDir)) {
    changed.push(`${claudeJson} (names ${runDir})`)
  }
  if (changed.length > 0) {
    throw new Error(`the account's own Claude files changed ${where}: ${changed.join(', ')}`)
  }
  return Object.keys(after).filter(
    (file) => before[file] && after[file].mtimeMs !== before[file].mtimeMs
  )
}
