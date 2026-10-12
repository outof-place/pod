import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/orca-user-data' } }))

import {
  migratePodClaudeSettings,
  readPodClaudeMigrations,
  removePodClaudeEntries
} from './pod-claude-settings-migration'

const names = { hookScript: 'claude-hook.sh', statusLineScript: 'claude-statusline.sh' }
const SHELL = '/bin/sh \\"$HOME/.orca/agent-hooks/claude-hook.sh\\"'
const CLIENT = '/Users/e2e/.orca/agent-hooks/pod-agent-hook'
const STATUS =
  'if [ -x \\"${HOME-}/.orca/agent-hooks/pod-agent-hook\\" ]; then exec x; fi; /bin/sh \\"${HOME-}/.orca/agent-hooks/claude-statusline.sh\\"'

// A user's file as Pod left it: JSONC comments, tabs, odd spacing, the user's own hooks beside and
// inside Pod's groups, and Pod's statusLine.
const BEFORE = `// my settings
{
\t"model": "opus",   // keep me
\t"hooks": {
\t\t"PreToolUse": [
\t\t\t{ "matcher": "Bash", "hooks": [ { "type": "command", "command": "rtk hook claude" } ] },
\t\t\t{
\t\t\t\t"matcher": "*",
\t\t\t\t"hooks": [{ "type": "command", "command": "${CLIENT}", "args": [], "timeout": 10, "async": true }]
\t\t\t}
\t\t],
\t\t/* Pod's and mine in one group */
\t\t"Stop": [
\t\t\t{ "hooks": [
\t\t\t\t{ "type": "command", "command": "${SHELL}", "timeout": 10 },
\t\t\t\t{ "type": "command", "command": "say done" }
\t\t\t] }
\t\t],
\t\t"SessionStart": [{ "hooks": [{ "type": "command", "command": "${CLIENT}", "args": [] }] }]
\t},
\t"statusLine": { "type": "command", "command": "${STATUS}" },
\t"permissions": { "allow": ["Bash(ls:*)"] }
}
`

const AFTER = `// my settings
{
\t"model": "opus",   // keep me
\t"hooks": {
\t\t"PreToolUse": [
\t\t\t{ "matcher": "Bash", "hooks": [ { "type": "command", "command": "rtk hook claude" } ] }
\t\t],
\t\t/* Pod's and mine in one group */
\t\t"Stop": [
\t\t\t{ "hooks": [
\t\t\t\t{ "type": "command", "command": "say done" }
\t\t\t] }
\t\t]
\t},
\t"permissions": { "allow": ["Bash(ls:*)"] }
}
`

let root = ''
let hooksDir = ''
let settingsPath = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pod-claude-migration-'))
  hooksDir = join(root, '.orca', 'agent-hooks')
  mkdirSync(hooksDir, { recursive: true })
  mkdirSync(join(root, '.claude'))
  settingsPath = join(root, '.claude', 'settings.json')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("taking Pod's entries out of a Claude settings file", () => {
  it("removes only Pod's entries, leaving every other byte as it was", () => {
    const result = removePodClaudeEntries(BEFORE, names)
    expect(result?.text).toBe(AFTER)
    expect(result?.removed.map((removal) => removal.path)).toEqual([
      ['hooks', 'PreToolUse', 1],
      ['hooks', 'Stop', 0, 'hooks', 0],
      ['hooks', 'SessionStart', 0],
      ['statusLine']
    ])
  })

  it("drops `hooks` only when Pod's removals emptied it, and keeps a user's statusLine", () => {
    const pod = `{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"${CLIENT}","args":[]}]}]},"statusLine":{"type":"command","command":"ccstatusline"}}`
    expect(removePodClaudeEntries(pod, names)?.text).toBe(
      '{"statusLine":{"type":"command","command":"ccstatusline"}}'
    )
    const empty = '{\n  "hooks": {},\n  "env": {}\n}\n'
    expect(removePodClaudeEntries(empty, names)).toEqual({ text: empty, removed: [] })
  })

  it('refuses a file that is not a JSONC object', () => {
    expect(removePodClaudeEntries('{"hooks": ', names)).toBe(null)
    expect(removePodClaudeEntries('[]', names)).toBe(null)
  })

  it('backs the file up, writes it once, logs what went, and then leaves it alone', () => {
    writeFileSync(settingsPath, BEFORE, { mode: 0o640 })
    const entry = migratePodClaudeSettings(settingsPath, hooksDir, names, new Date(0))
    expect(readFileSync(settingsPath, 'utf8')).toBe(AFTER)
    expect(statSync(settingsPath).mode & 0o777).toBe(0o640)
    expect(entry?.backupPath).toBe(
      join(hooksDir, 'claude-settings.1970-01-01T00-00-00-000Z.backup.json')
    )
    expect(readFileSync(entry!.backupPath, 'utf8')).toBe(BEFORE)
    expect(statSync(entry!.backupPath).mode & 0o777).toBe(0o600)
    expect(readPodClaudeMigrations(hooksDir)).toEqual([JSON.parse(JSON.stringify(entry))])
    expect(entry?.removed[0].value).toMatchObject({ matcher: '*', hooks: [{ command: CLIENT }] })

    const mtime = statSync(settingsPath).mtimeMs
    const files = readdirSync(hooksDir).sort()
    expect(migratePodClaudeSettings(settingsPath, hooksDir, names, new Date(1000))).toBe(null)
    expect(statSync(settingsPath).mtimeMs).toBe(mtime)
    expect(readdirSync(hooksDir).sort()).toEqual(files)
    expect(readPodClaudeMigrations(hooksDir)).toHaveLength(1)
  })

  it('writes nothing for a missing, foreign or unparsable file', () => {
    expect(migratePodClaudeSettings(settingsPath, hooksDir, names)).toBe(null)
    for (const text of ['{"model":"opus"}\n', '{"hooks": ']) {
      writeFileSync(settingsPath, text)
      expect(migratePodClaudeSettings(settingsPath, hooksDir, names)).toBe(null)
      expect(readFileSync(settingsPath, 'utf8')).toBe(text)
    }
    expect(readdirSync(hooksDir)).toEqual([])
    expect(existsSync(`${settingsPath}.bak`)).toBe(false)
  })
})
