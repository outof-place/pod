#!/usr/bin/env node
// Fork-only (Pod): lists the ORCA_* env names Pod's tree uses, read-only, so a new one is filed in
// product/pod-decouple/env-names.json (the source of Pod's POD_ aliases) before it ships.
// Derivation copied from the decouple codemod (pod/decouple-v8 product/scripts/pod-decouple.mjs).
//
//   node product/scripts/pod-env-names.mjs --check    exit 1 on a name the table doesn't file
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const repoRoot = join(import.meta.dirname, '..', '..')
const KEEP_MARKER = 'pod-decouple:keep'

// What the app, its CLI, its relay, its helpers and its bundled skills are built from.
// mobile/ is another product; docs/ and .github/ do not ship. product/agent-launcher
// is the `claude` launcher Pod ships, which reads the pane's env names; e2e.yml sets the app's
// names for the E2E jobs, and a unit test reads them back.
// bench/ stays out: it launches Orca next to Pod and must keep Orca's ORCA_ names.
const SCOPES = [
  'src/',
  'tests/',
  'config/',
  'resources/',
  'skills/',
  'skill-guides/',
  'skill-stubs/',
  'native/',
  'scripts/',
  'product/agent-launcher/',
  '.github/workflows/e2e.yml'
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

/** Production env names the table neither renames nor keeps. */
export function unfiledEnvNames(root = repoRoot) {
  const table = JSON.parse(
    readFileSync(join(root, 'product', 'pod-decouple', 'env-names.json'), 'utf8')
  )
  const texts = new Map()
  for (const file of trackedFiles(root)) {
    const text = readText(root, file)
    if (text !== null) {
      texts.set(file, text)
    }
  }
  const { production } = deriveEnvNames(texts)
  const filed = new Set([
    ...table.rename,
    ...(table.contract?.names ?? []),
    ...Object.keys(table.map ?? {})
  ])
  return [...production.keys()]
    .filter((name) => !filed.has(name) && !isKept(name, table.keep))
    .sort()
    .map((name) => ({ name, where: [...production.get(name)].slice(0, 3) }))
}

if (process.argv[2] === '--check') {
  const unfiled = unfiledEnvNames()
  for (const { name, where } of unfiled) {
    console.error(
      `new env name ${name} (${where.join(', ')}): file it in product/pod-decouple/env-names.json`
    )
  }
  process.exit(unfiled.length > 0 ? 1 : 0)
}
