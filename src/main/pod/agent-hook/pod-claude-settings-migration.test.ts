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
  removePodClaudeEntries,
  type PodClaudeCutRefusal
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

describe("a user's comments around Pod's entries", () => {
  const POD = `{ "hooks": [{ "type": "command", "command": "${CLIENT}", "args": [] }] }`
  const MINE = '{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "my-guard" }] }'
  const cut = (text: string): string | undefined => removePodClaudeEntries(text, names)?.text

  it.each([
    [
      "a // line between Pod's event and the next one",
      `{\n\t"hooks": {\n\t\t"SessionStart": [${POD}],\n\t\t// mine: the guard below\n\t\t"PreCompact": [${MINE}]\n\t}\n}\n`,
      `{\n\t"hooks": {\n\t\t// mine: the guard below\n\t\t"PreCompact": [${MINE}]\n\t}\n}\n`
    ],
    [
      "a /* block */ before Pod's last group",
      `{"hooks": {"Stop": [\n\t\t\t${MINE},\n\t\t\t/* Pod's below */\n\t\t\t${POD}\n\t\t]}}`,
      `{"hooks": {"Stop": [\n\t\t\t${MINE}\n\t\t\t/* Pod's below */\n\t\t]}}`
    ],
    [
      "a comment after Pod's last group, on its line",
      `{"hooks": {"Stop": [\n\t\t\t${MINE},\n\t\t\t${POD} // Pod's\n\t\t]}}`,
      `{"hooks": {"Stop": [\n\t\t\t${MINE} // Pod's\n\t\t]}}`
    ],
    [
      "a comment after the comma that follows Pod's group",
      `{"hooks": {"Stop": [\n\t\t\t${POD}, // about mine\n\t\t\t${MINE}\n\t\t]}}`,
      `{"hooks": {"Stop": [\n\t\t\t// about mine\n\t\t\t${MINE}\n\t\t]}}`
    ],
    [
      "a comment in an event that held only Pod's group, which then stays empty",
      `{"hooks": {"Stop": [\n\t\t\t// mine\n\t\t\t${POD}\n\t\t]}}`,
      '{"hooks": {"Stop": [\n\t\t\t// mine\n\t\t]}}'
    ],
    [
      'a /* block */ between events, with CRLF',
      `{\r\n  "hooks": {\r\n    "SessionStart": [${POD}],\r\n    /* mine */\r\n    "PreCompact": [${MINE}]\r\n  }\r\n}\r\n`,
      `{\r\n  "hooks": {\r\n    /* mine */\r\n    "PreCompact": [${MINE}]\r\n  }\r\n}\r\n`
    ],
    [
      "a comment before Pod's statusLine as the file's last member",
      `{\n\t"model": "opus",\n\t// my status line is Pod's\n\t"statusLine": { "type": "command", "command": "${STATUS}" }\n}\n`,
      `{\n\t"model": "opus"\n\t// my status line is Pod's\n}\n`
    ]
  ])('keeps %s', (_label, before, after) => {
    expect(cut(before)).toBe(after)
  })

  it("drops an event and `hooks` that held only Pod's group and no comment, with CRLF", () => {
    expect(
      cut(
        `{\r\n  "hooks": {\r\n    "Stop": [\r\n      ${POD}\r\n    ]\r\n  },\r\n  "model": "opus"\r\n}\r\n`
      )
    ).toBe('{\r\n  "model": "opus"\r\n}\r\n')
  })
})

describe('a cut that has to leave valid JSONC (r-orca on v4)', () => {
  const POD = `{ "hooks": [{ "type": "command", "command": "${CLIENT}", "args": [] }] }`
  const MINE = '{ "hooks": [{ "type": "command", "command": "my-guard" }] }'
  const URL_MINE = '{ "hooks": [{ "type": "command", "command": "curl https://example.com//x" }] }'
  const cut = (text: string): string | undefined => removePodClaudeEntries(text, names)?.text

  it.each([
    [
      "a // line before Pod's last event, whose `}` shares its line",
      `{\n  "hooks": {\n    "PreToolUse": [${MINE}],\n    // Pod's\n    "Stop": [${POD}]}\n}`,
      `{\n  "hooks": {\n    "PreToolUse": [${MINE}]\n    // Pod's\n}\n}`
    ],
    [
      'a // line before `hooks` as the last member, closed on the same line',
      `{\n  "model": "opus",\n  // c\n  "hooks": {"Stop": [${POD}]}}`,
      `{\n  "model": "opus"\n  // c\n}`
    ],
    ["a trailing comma after Pod's only event", `{"hooks": {"Stop": [${POD}],}}`, '{}'],
    [
      "a trailing comma after Pod's last group",
      `{"hooks": {"Stop": [${MINE}, ${POD},]}}`,
      `{"hooks": {"Stop": [${MINE},]}}`
    ],
    [
      "a block comment before the comma ahead of Pod's group",
      `{"hooks": {"Stop": [${MINE} /* c */ , ${POD}]}}`,
      `{"hooks": {"Stop": [${MINE} /* c */ ]}}`
    ],
    [
      "a // line right before `]`, after Pod's last group",
      `{"hooks": {"Stop": [\n  ${MINE},\n  ${POD} // c\n]}}`,
      `{"hooks": {"Stop": [\n  ${MINE} // c\n]}}`
    ],
    [
      "a // line right before the file's `}`, after `hooks`",
      `{"hooks": {"Stop": [${POD}]} // c\n}`,
      '{ // c\n}'
    ],
    [
      'a trailing comma after `hooks` as the last member, with CRLF',
      `{\r\n  "model": "opus",\r\n  "hooks": {"Stop": [${POD}]},\r\n}\r\n`,
      '{\r\n  "model": "opus",\r\n}\r\n'
    ],
    [
      'a // inside a string next to the cut',
      `{"hooks": {"Stop": [${URL_MINE},\n ${POD}]}}`,
      `{"hooks": {"Stop": [${URL_MINE}]}}`
    ]
  ])('cuts %s', (_label, before, after) => {
    expect(cut(before)).toBe(after)
    expect(removePodClaudeEntries(after, names)).toEqual({ text: after, removed: [] })
  })
})

describe("a user's own empty entries and Pod's direct command (r-orca on v5)", () => {
  const POD = `{ "hooks": [{ "type": "command", "command": "${CLIENT}", "args": [] }] }`
  const cut = (text: string): string | undefined => removePodClaudeEntries(text, names)?.text

  it("keeps a user's empty event next to the one Pod's removals emptied", () => {
    expect(cut(`{"hooks": {"Notification": [], "Stop": [${POD}]}}`)).toBe(
      '{"hooks": {"Notification": []}}'
    )
    expect(cut(`{"hooks": {"Stop": [${POD}], "X": []}}`)).toBe('{"hooks": {"X": []}}')
  })

  it('keeps `hooks` with only a user empty event when Pod also had its statusLine', () => {
    expect(
      cut(`{"hooks": {"X": []}, "statusLine": { "type": "command", "command": "${STATUS}" }}`)
    ).toBe('{"hooks": {"X": []}}')
  })

  it("takes Pod's command from a group that also holds the user's hooks", () => {
    const before = `{"hooks": {"Stop": [{ "command": "${CLIENT}", "hooks": [{ "type": "command", "command": "say done" }] }]}}`
    const result = removePodClaudeEntries(before, names)
    expect(result?.removed.map((removal) => removal.path)).toEqual([
      ['hooks', 'Stop', 0, 'command']
    ])
    expect(result?.text).toBe(
      '{"hooks": {"Stop": [{ "hooks": [{ "type": "command", "command": "say done" }] }]}}'
    )
  })

  it('names why it refused', () => {
    const refusal: PodClaudeCutRefusal = {}
    expect(removePodClaudeEntries('{"hooks": ', names, refusal)).toBe(null)
    expect(refusal.reason).toBe('not a JSONC object')
  })
})

describe('a settings file that names a key twice (r-orca on cfc502ee)', () => {
  const POD = `{ "hooks": [{ "type": "command", "command": "${CLIENT}", "args": [] }] }`

  it('is refused with its reason and never throws', () => {
    for (const text of [
      `{"hooks":{"Stop":[],"Stop":[${POD}]}}`,
      `{"hooks":{"Stop":[${POD}]},"hooks":{}}`,
      `{"hooks":{"Stop":[{"hooks":[],"hooks":[{"type":"command","command":"${CLIENT}"}]}]}}`
    ]) {
      const refusal: PodClaudeCutRefusal = {}
      expect(removePodClaudeEntries(text, names, refusal)).toBe(null)
      expect(refusal.reason).toBe('duplicate keys')
    }
  })
})
