import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const repoRoot = join(import.meta.dirname, '..', '..', '..')
const script = join(repoRoot, 'product', 'scripts', 'pod-decouple.mjs')
const repoTables = join(repoRoot, 'product', 'pod-decouple')

// Why placeholders: the codemod runs over this file too, so real legacy tokens in a fixture
// would be rewritten before the test could feed them in. `{O}` is the legacy env prefix.
const legacy = (text: string): string => text.replaceAll('{O}', 'ORCA_').replaceAll('{H}', '.orca')

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function fixture(files: Record<string, string>, tables: { env: object; edits?: object }) {
  const root = mkdtempSync(join(tmpdir(), 'pod-decouple-'))
  roots.push(root)
  const tableDir = join(root, '.tables')
  mkdirSync(tableDir)
  writeFileSync(join(tableDir, 'env-names.json'), legacy(JSON.stringify(tables.env)))
  const noEdits = { residue: '(?<![\\w.-])\\{H}(?=[/])', rules: [], keep: [] }
  writeFileSync(join(tableDir, 'edits.json'), legacy(JSON.stringify(tables.edits ?? noEdits)))
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), legacy(text))
  }
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['add', '-A'], { cwd: root })
  const run = (mode: '--apply' | '--check') =>
    spawnSync('node', [script, mode, '--root', root, '--tables', tableDir], { encoding: 'utf8' })
  const read = (file: string) => readFileSync(join(root, file), 'utf8')
  return { run, read }
}

const env = (rename: string[], extra: object = {}) => ({
  keep: { '{O}E2E_*': 'harness input' },
  contract: { files: [], names: [] },
  map: {},
  rename,
  ...extra
})

describe('pod-decouple', () => {
  it('renames an env name at every occurrence and is idempotent', () => {
    const { run, read } = fixture(
      {
        'src/main/spawn.ts': 'env.{O}PANE_KEY = key\nconst hook = `[ -n "$' + '{O}PANE_KEY" ]`\n',
        'src/main/spawn.test.ts': "expect(env).toHaveProperty('{O}PANE_KEY')\n",
        'skills/cli/SKILL.md': 'Read `{O}PANE_KEY` to find your pane.\n'
      },
      { env: env(['{O}PANE_KEY']) }
    )
    expect(run('--apply').status).toBe(0)
    expect(read('src/main/spawn.ts')).toBe(
      'env.POD_PANE_KEY = key\nconst hook = `[ -n "$POD_PANE_KEY" ]`\n'
    )
    expect(read('src/main/spawn.test.ts')).toContain("'POD_PANE_KEY'")
    expect(read('skills/cli/SKILL.md')).toContain('`POD_PANE_KEY`')
    expect(run('--check').status).toBe(0)
  })

  it('fails closed on an env name production code adds', () => {
    const { run, read } = fixture(
      { 'src/main/spawn.ts': 'env.{O}PANE_KEY = key\nenv.{O}NEW_THING = 1\n' },
      { env: env(['{O}PANE_KEY']) }
    )
    const result = run('--apply')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(legacy('new agent-facing env name {O}NEW_THING'))
    expect(read('src/main/spawn.ts')).toContain(legacy('{O}PANE_KEY'))
  })

  it('leaves constants, kept inputs and marked lines alone', () => {
    const files = {
      'src/main/text.ts':
        "const {O}FOOTER = 'x'\nconst line = `${{O}FOOTER}`\nprocess.env.{O}E2E_HOME\n" +
        'env.{O}PANE_KEY = alias // pod-decouple:keep\n'
    }
    const { run, read } = fixture(files, { env: env(['{O}PANE_KEY']) })
    expect(run('--apply').status).toBe(0)
    expect(read('src/main/text.ts')).toBe(legacy(files['src/main/text.ts']))
  })

  it('keeps contract names in contract files only', () => {
    const { run, read } = fixture(
      {
        'src/main/setup-env.ts': 'env.{O}WORKSPACE_NAME = name\n',
        'src/main/terminal-env.ts': 'env.{O}WORKSPACE_NAME = name\n'
      },
      {
        env: env(['{O}WORKSPACE_NAME'], {
          contract: { files: ['^src/main/setup-env\\.ts$'], names: [legacy('{O}WORKSPACE_NAME')] }
        })
      }
    )
    expect(run('--apply').status).toBe(0)
    expect(read('src/main/setup-env.ts')).toContain(legacy('{O}WORKSPACE_NAME'))
    expect(read('src/main/terminal-env.ts')).toContain('POD_WORKSPACE_NAME')
  })

  it('follows Windows spellings of a pinned name in their own case', () => {
    const { run, read } = fixture(
      { 'src/main/win.test.ts': "env.{O}HOOK_NODE\nenv.orca_hook_node\nenv['Orca_Hook_Node']\n" },
      { env: env(['{O}HOOK_NODE']) }
    )
    expect(run('--apply').status).toBe(0)
    expect(read('src/main/win.test.ts')).toBe(
      "env.POD_HOOK_NODE\nenv.pod_hook_node\nenv['Pod_Hook_Node']\n"
    )
  })

  it('rewrites the home folder by rule and fails on one that survives', () => {
    const edits = {
      residue: '(?<![\\w.-])\\{H}(?=[/\'"])',
      rules: [
        {
          id: 'home-join',
          stage: 'pre-env',
          files: '^src/',
          find: "join\\(homedir\\(\\), '\\{H}'",
          replace: "join(homedir(), '.pod'",
          applied: "join\\(homedir\\(\\), '\\.pod'"
        }
      ],
      keep: [{ files: '^src/', line: 'issue-command' }]
    }
    const ok = fixture(
      {
        'src/main/paths.ts': "join(homedir(), '{H}', 'keys')\njoin(repo, '{H}/issue-command')\n"
      },
      { env: env([]), edits }
    )
    expect(ok.run('--apply').status).toBe(0)
    expect(ok.read('src/main/paths.ts')).toBe(
      legacy("join(homedir(), '.pod', 'keys')\njoin(repo, '{H}/issue-command')\n")
    )
    expect(ok.run('--check').status).toBe(0)

    const survivor = fixture(
      { 'src/main/paths.ts': "join(homedir(), '{H}')\nconst other = '~/{H}/x'\n" },
      { env: env([]), edits }
    )
    const result = survivor.run('--apply')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(legacy('~/{H} survives'))
  })
})

describe('pod-decouple tables', () => {
  const identity = JSON.parse(readFileSync(join(repoRoot, 'product', 'identity.json'), 'utf8'))
  const envTable = JSON.parse(readFileSync(join(repoTables, 'env-names.json'), 'utf8'))
  const edits = JSON.parse(readFileSync(join(repoTables, 'edits.json'), 'utf8'))

  it('pins legacy names only, each once, none also kept', () => {
    const rename: string[] = envTable.rename
    expect(new Set(rename).size).toBe(rename.length)
    expect(rename.every((name) => name.startsWith(legacy('{O}')))).toBe(true)
    const kept = Object.keys(envTable.keep)
    expect(
      rename.filter((name) =>
        kept.some((entry) =>
          entry.endsWith('*') ? name.startsWith(entry.slice(0, -1)) : entry === name
        )
      )
    ).toEqual([])
  })

  it('writes the names identity.json declares', () => {
    const replacement = (id: string): string =>
      edits.rules.find((rule: { id: string }) => rule.id === id).replace
    expect(replacement('bundled-cli-launcher')).toContain('getProductIdentity()?.cliName')
    expect(replacement('local-cli-command')).toContain(`'${identity.cliName}'`)
    expect(replacement('home-join')).toContain(`'${identity.homeDirName}'`)
    expect(identity.envPrefix).toBe('POD_')
  })
})
