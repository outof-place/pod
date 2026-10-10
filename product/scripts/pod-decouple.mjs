#!/usr/bin/env node
// Cuts Pod's runtime ties to Orca across the whole assembled tree, deterministically.
//
// pod-stack.sh runs this as the last step of every assembly and every upstream sync, so the
// result is regenerated instead of carried as hand edits that conflict on each rebase:
//
//   node product/scripts/pod-decouple.mjs --apply         rewrite the tree (exit 1 on any drift)
//   node product/scripts/pod-decouple.mjs --check         exit 1 if --apply would change anything
//   node product/scripts/pod-decouple.mjs --report        list agent-facing env names vs the table
//   node product/scripts/pod-decouple.mjs --update-names  add the tree's new names (then review)
//
// Stages, each fail-closed:
// - pre-env edits (product/pod-decouple/edits.json): ~/.orca becomes ~/.pod, and the CLI ships
//   as `podx` only. A production reference to `.orca` that no rule rewrote must match a keep
//   entry (repository `.orca/` folders, remote state roots), or the run fails.
// - env: every ORCA_* variable Pod's own production code reads or writes as an environment
//   variable becomes POD_*, at every occurrence (producers, consumers, tests, skills), so
//   terminals and agents only see POD_*. The names are derived from the tree and pinned in
//   product/pod-decouple/env-names.json; a name upstream adds fails the run until a person files
//   it under "rename" or "keep".
// - post-env edits: changes whose anchors only exist once names are POD_*. Lines marked
//   `pod-decouple:keep` are never renamed, so a deliberate ORCA_* alias can survive.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const repoRoot = join(import.meta.dirname, '..', '..')
export const TABLE_DIR = join(repoRoot, 'product', 'pod-decouple')
const KEEP_MARKER = 'pod-decouple:keep'

// What the app, its CLI, its relay, its helpers and its bundled skills are built from.
// mobile/ and cloud/ are other products; docs/ and .github/ do not ship.
const SCOPES = [
  'src/',
  'tests/',
  'config/',
  'resources/',
  'skills/',
  'skill-guides/',
  'skill-stubs/',
  'native/',
  'scripts/'
]
const TEXT_EXTENSIONS = new Set(
  (
    'ts tsx mts cts js mjs cjs jsx json jsonc md sh bash zsh fish ps1 psm1 cmd bat py swift c h m ' +
    'mm cc cpp rs yml yaml toml txt html plist rb nu xsh'
  ).split(' ')
)
const SCRIPT_EXTENSIONS = new Set('ts tsx mts cts js mjs cjs jsx'.split(' '))
const SHELL_EXTENSIONS = new Set('sh bash zsh fish ps1 psm1 cmd bat nu xsh'.split(' '))
const NATIVE_EXTENSIONS = new Set('swift c h m mm cc cpp py rs'.split(' '))

const TEST_PATH =
  /(^tests\/|^config\/|\/__tests__\/|\/__fixtures__\/|\/fixtures?\/|[.-](test|spec|e2e)\.[cm]?[jt]sx?$|test-(support|harness|fixture|helpers?|utils?|mocks?)|\.test-[a-z-]+\.[cm]?[jt]sx?$|-fixture\.[cm]?[jt]sx?$|bench(mark)?s?[./-])/

const NAME = '(ORCA_[A-Z0-9_]*[A-Z0-9])'
// A token never continues an identifier on either side (POD_ADOPT_ORCA_TERMINALS holds none),
// except right after a string escape: in `'done\nORCA_X=1'` the `n` belongs to `\n`.
const START = '(?:(?<=\\\\[nrtv0])|(?<![A-Za-z0-9_]))'
const END = '(?![A-Za-z0-9_])'
const TOKEN = new RegExp(`${START}ORCA_[A-Z0-9_]*[A-Z0-9]${END}`, 'g')
const tokenPattern = (name) => new RegExp(`${START}${name}${END}`, 'g')

// Contexts that prove a name is an environment variable. In scripts `${ORCA_X}` interpolates a
// constant and proves nothing; the shell forms inside strings are `$ORCA_X` and `\${ORCA_X}`.
const SCRIPT_ENV_CONTEXTS = [
  new RegExp(`process\\.env\\??\\.${NAME}`, 'g'),
  new RegExp(`(?<![\\w$])[A-Za-z_$]*[eE]nv[\\w$]*\\??\\.${NAME}\\b`, 'g'),
  new RegExp(`[eE]nv[\\w$]*\\??\\.?\\[\\s*['"\`]${NAME}['"\`]\\s*\\]`, 'g'),
  new RegExp(
    `(?:stubEnv|getEnv|readEnv|hasEnv|deleteEnv|envFlag|envValue)\\(\\s*['"\`]${NAME}['"\`]`,
    'g'
  ),
  new RegExp(`\\\\\\$\\{${NAME}`, 'g'),
  new RegExp(`(?<![\\w{])\\$${NAME}\\b`, 'g'),
  new RegExp(`%${NAME}%`, 'g'),
  new RegExp(`\\$env:${NAME}`, 'gi'),
  new RegExp(`['"\`\\s;(]${NAME}=(?!=)`, 'g')
]
const SHELL_ENV_CONTEXTS = [
  new RegExp(`\\$\\{?${NAME}`, 'g'),
  new RegExp(`%${NAME}%`, 'g'),
  new RegExp(`\\$env:${NAME}`, 'gi'),
  new RegExp(`(?:^|[\\s;(])(?:export\\s+|set\\s+-[gx]+\\s+|unset\\s+)?${NAME}=?`, 'gm')
]
const NATIVE_ENV_CONTEXTS = [
  new RegExp(`getenv\\(\\s*"${NAME}"`, 'g'),
  new RegExp(`(?:var|var_os|set_var|remove_var|move_environment_variable)\\([^)]*"${NAME}"`, 'g'),
  new RegExp(`environment\\[\\s*"${NAME}"`, 'g'),
  new RegExp(`environ(?:\\.get)?\\(?\\[?\\s*['"]${NAME}['"]`, 'g')
]

function trackedFiles(root) {
  return execFileSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024
  })
    .split('\0')
    .filter((file) => file && SCOPES.some((scope) => file.startsWith(scope)))
    .filter((file) => TEXT_EXTENSIONS.has(extensionOf(file)) || extensionOf(file) === '')
    .sort()
}

/** '' for a file without one (launcher scripts such as resources/darwin/bin/orca). */
function extensionOf(file) {
  const name = file.slice(file.lastIndexOf('/') + 1)
  return name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : ''
}

function readText(root, file) {
  try {
    const text = readFileSync(join(root, file), 'utf8')
    // Extensionless files count only as scripts with a shebang.
    if (text.includes('\0') || (extensionOf(file) === '' && !text.startsWith('#!'))) {
      return null
    }
    return text
  } catch {
    return null
  }
}

function envContexts(file) {
  const ext = extensionOf(file)
  if (SCRIPT_EXTENSIONS.has(ext)) {
    return SCRIPT_ENV_CONTEXTS
  }
  if (SHELL_EXTENSIONS.has(ext) || ext === '') {
    return SHELL_ENV_CONTEXTS
  }
  return NATIVE_EXTENSIONS.has(ext) ? NATIVE_ENV_CONTEXTS : []
}

function withoutKeptLines(text) {
  return text.includes(KEEP_MARKER)
    ? text
        .split('\n')
        .filter((line) => !line.includes(KEEP_MARKER))
        .join('\n')
    : text
}

/**
 * Every ORCA_* name the tree uses as an environment variable. A name proves itself in an env
 * context anywhere (tests included: production often sets env through object keys that only
 * tests read back), and counts as production when any production file mentions it.
 */
export function deriveEnvNames(texts) {
  const envNames = new Set()
  const productionFiles = new Map()
  for (const [file, text] of texts) {
    if (!text.includes('ORCA_')) {
      continue
    }
    const scanned = withoutKeptLines(text)
    for (const pattern of envContexts(file)) {
      for (const match of scanned.matchAll(pattern)) {
        envNames.add(match[1])
      }
    }
    if (TEST_PATH.test(file)) {
      continue
    }
    for (const match of scanned.matchAll(TOKEN)) {
      const where = productionFiles.get(match[0]) ?? new Set()
      where.add(file)
      productionFiles.set(match[0], where)
    }
  }
  const production = new Map()
  const testOnly = new Set()
  for (const name of envNames) {
    if (productionFiles.has(name)) {
      production.set(name, productionFiles.get(name))
    } else {
      testOnly.add(name)
    }
  }
  return { production, testOnly }
}

function isKept(name, keep) {
  return Object.keys(keep).some((entry) =>
    entry.endsWith('*') ? name.startsWith(entry.slice(0, -1)) : entry === name
  )
}

function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function compileRules(rules) {
  return rules.map((rule) => ({
    ...rule,
    filesPattern: new RegExp(rule.files),
    pattern: new RegExp(rule.find, rule.flags ?? 'g')
  }))
}

function applyRules(file, text, rules, counts) {
  let next = text
  for (const rule of rules) {
    if (!rule.filesPattern.test(file)) {
      continue
    }
    if (rule.unless && next.includes(rule.unless)) {
      counts.set(rule.id, (counts.get(rule.id) ?? 0) + 1)
      continue
    }
    next = next.replace(rule.pattern, (...args) => {
      counts.set(rule.id, (counts.get(rule.id) ?? 0) + 1)
      return rule.replace.replace(/\$(\d)/g, (_, index) => args[Number(index)] ?? '')
    })
  }
  return next
}

// Windows environment names are case-insensitive, so code and tests also spell pinned names as
// `Orca_Foo` or `orca_foo`; those follow in their own case.
const MIXED_CASE_TOKEN = new RegExp(
  `${START}(orca|Orca|ORCA)(_[A-Za-z0-9_]*[A-Za-z0-9])${END}`,
  'g'
)
const POD_PREFIX = { orca: 'pod', Orca: 'Pod', ORCA: 'POD' }

function renameMixedCase(line, active, counts) {
  if (!/orca_/i.test(line)) {
    return line
  }
  return line.replace(MIXED_CASE_TOKEN, (token, prefix, rest) => {
    const upper = token.toUpperCase()
    if (token === upper || !active.byName.has(upper)) {
      return token
    }
    counts.set(upper, (counts.get(upper) ?? 0) + 1)
    return `${POD_PREFIX[prefix]}${rest}`
  })
}

function renameEnv(file, text, renames, contract, counts) {
  if (!/orca_/i.test(text)) {
    return text
  }
  const inContract = contract.files.some((pattern) => pattern.test(file))
  const active = inContract ? renames.filter((env) => !contract.names.has(env.from)) : renames
  active.byName = new Set(active.map((env) => env.from))
  const renameLine = (line) => {
    if (!/orca_/i.test(line) || line.includes(KEEP_MARKER)) {
      return line
    }
    let next = renameMixedCase(line, active, counts)
    for (const env of active) {
      next = next.replace(env.pattern, () => {
        counts.set(env.from, (counts.get(env.from) ?? 0) + 1)
        return env.to
      })
    }
    return next
  }
  return text.includes(KEEP_MARKER) ? text.split('\n').map(renameLine).join('\n') : renameLine(text)
}

// A rule that matches nothing is drift unless its result is already in the tree (a rerun).
function isAlreadyApplied(rule, results) {
  if (!rule.applied) {
    return false
  }
  const applied = new RegExp(rule.applied)
  for (const [file, text] of results) {
    if (rule.filesPattern.test(file) && applied.test(text)) {
      return true
    }
  }
  return false
}

function homeResidue(file, text, edits) {
  if (TEST_PATH.test(file) || !text.includes('.orca')) {
    return []
  }
  const found = []
  for (const match of text.matchAll(new RegExp(edits.residue, 'g'))) {
    const lineStart = text.lastIndexOf('\n', match.index) + 1
    const lineEnd = text.indexOf('\n', match.index)
    const line = text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim()
    const kept = edits.keep.some(
      (entry) => new RegExp(entry.files).test(file) && new RegExp(entry.line).test(line)
    )
    if (!kept) {
      found.push(`${file}: ${line.slice(0, 160)}`)
    }
  }
  return found
}

function envCollisions(texts, renames, contract) {
  const wanted = new Map(renames.map((env) => [env.to, env.from]))
  const sources = new Set()
  const targets = []
  for (const [file, text] of texts) {
    if (text.includes('ORCA_')) {
      const inContract = contract.files.some((pattern) => pattern.test(file))
      const scanned = withoutKeptLines(text)
      for (const env of renames) {
        if (inContract && contract.names.has(env.from)) {
          continue
        }
        env.pattern.lastIndex = 0
        if (env.pattern.test(scanned)) {
          sources.add(env.from)
        }
        env.pattern.lastIndex = 0
      }
    }
    // Why production only: tests spell the expected POD_ names next to the ORCA_ inputs.
    if (text.includes('POD_') && !TEST_PATH.test(file)) {
      for (const match of text.matchAll(new RegExp(`${START}POD_[A-Z0-9_]*[A-Z0-9]${END}`, 'g'))) {
        if (wanted.has(match[0])) {
          targets.push({ to: match[0], from: wanted.get(match[0]), file })
        }
      }
    }
  }
  // A POD_ name collides only while its ORCA_ source still exists; after --apply it is ours.
  return targets
    .filter((target) => sources.has(target.from))
    .map((target) => `env rename ${target.from} -> ${target.to} collides with ${target.file}`)
}

export function run(root, mode, { tableDir = TABLE_DIR, log = console } = {}) {
  const envTablePath = join(tableDir, 'env-names.json')
  const envTable = loadJson(envTablePath)
  const edits = loadJson(join(tableDir, 'edits.json'))
  const texts = new Map()
  for (const file of trackedFiles(root)) {
    const text = readText(root, file)
    if (text !== null) {
      texts.set(file, text)
    }
  }
  const { production, testOnly } = deriveEnvNames(texts)
  const fresh = [...production.keys()].filter((name) => !isKept(name, envTable.keep)).sort()

  if (mode === 'report') {
    const pinned = new Set(envTable.rename)
    for (const name of fresh) {
      const where = [...production.get(name)].slice(0, 2).join(' ')
      log.log(`${pinned.has(name) ? ' ' : '+'} ${name}\t${where}`)
    }
    log.log(`production env names: ${fresh.length}; test-only (left alone): ${testOnly.size}`)
    return 0
  }
  if (mode === 'update-names') {
    const rename = [...new Set([...envTable.rename, ...fresh])].sort()
    writeFileSync(envTablePath, `${JSON.stringify({ ...envTable, rename }, null, 2)}\n`)
    log.log(`env-names.json: ${rename.length} names, ${rename.length - envTable.rename.length} new`)
    return 0
  }

  const problems = []
  const pinned = new Set(envTable.rename)
  for (const name of fresh.filter((candidate) => !pinned.has(candidate))) {
    const where = [...production.get(name)].slice(0, 3).join(', ')
    problems.push(
      `new agent-facing env name ${name} (${where}): file it in product/pod-decouple/` +
        `env-names.json under "rename", or under "keep" with a reason`
    )
  }
  const renames = envTable.rename.map((from) => ({
    from,
    to: envTable.map?.[from] ?? `POD_${from.slice('ORCA_'.length)}`,
    pattern: tokenPattern(from)
  }))
  const contract = {
    files: (envTable.contract?.files ?? []).map((pattern) => new RegExp(pattern)),
    names: new Set(envTable.contract?.names ?? [])
  }
  problems.push(...envCollisions(texts, renames, contract))

  const preRules = compileRules(edits.rules.filter((rule) => rule.stage === 'pre-env'))
  const postRules = compileRules(edits.rules.filter((rule) => rule.stage === 'post-env'))
  const counts = new Map()
  const changed = []
  const results = new Map()
  for (const [file, text] of texts) {
    let next = applyRules(file, text, preRules, counts)
    next = renameEnv(file, next, renames, contract, counts)
    next = applyRules(file, next, postRules, counts)
    problems.push(
      ...homeResidue(file, next, edits).map(
        (line) => `~/.orca survives: ${line} (add an edits.json rule or keep entry)`
      )
    )
    results.set(file, next)
    if (next !== text) {
      changed.push({ file, next })
    }
  }
  for (const rule of [...preRules, ...postRules]) {
    if (!counts.has(rule.id) && !isAlreadyApplied(rule, results)) {
      problems.push(`anchor drifted: edits.json rule "${rule.id}" matched nothing (${rule.find})`)
    }
  }

  if (problems.length > 0) {
    for (const problem of problems) {
      log.error(`pod-decouple: ${problem}`)
    }
    return 1
  }
  if (mode === 'check') {
    for (const { file } of changed) {
      log.error(`pod-decouple: not applied: ${file}`)
    }
    return changed.length > 0 ? 1 : 0
  }
  for (const { file, next } of changed) {
    writeFileSync(join(root, file), next)
  }
  const renamed = renames.filter((env) => counts.has(env.from)).length
  log.log(`pod-decouple: ${changed.length} files changed; ${renamed} env names renamed`)
  return 0
}

const MODES = new Map([
  ['--apply', 'apply'],
  ['--check', 'check'],
  ['--report', 'report'],
  ['--update-names', 'update-names']
])

if (import.meta.main) {
  const flag = process.argv.find((arg) => MODES.has(arg))
  const option = (name) => {
    const index = process.argv.indexOf(name)
    return index > 0 ? process.argv[index + 1] : undefined
  }
  if (!flag) {
    console.error(
      'usage: pod-decouple.mjs --apply|--check|--report|--update-names [--root DIR] [--tables DIR]'
    )
    process.exit(2)
  }
  process.exit(
    run(option('--root') ?? repoRoot, MODES.get(flag), {
      tableDir: option('--tables') ?? TABLE_DIR
    })
  )
}
