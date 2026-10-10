// The claude-acc layer's probes for product/scripts/verify-bundle-seal.mjs: Python that imports the
// payload's modules from inside a copy of the app, the way perf.py imports orcahost. Python caches
// what a script imports, not the script, and that cache is what broke 0.0.1-test's seal.
const { execFileSync } = require('node:child_process')
const { existsSync, readdirSync, readFileSync } = require('node:fs')
const { homedir } = require('node:os')
const { join, relative } = require('node:path')

// -I ignores PYTHONDONTWRITEBYTECODE and PYTHONPYCACHEPREFIX: only what ships in the payload
// (its __pycache__ files) may keep the bundle clean, as for a process started without Pod's env.
// A third-party package the build machine lacks (sdk/python's anthropic) fails the import only
// after Python compiled the module and tried to cache it, which is all a probe needs.
const IMPORT_SIBLINGS = `import importlib, sys
sys.path.insert(0, sys.argv[1])
for name in sys.argv[2:]:
    try:
        importlib.import_module(name)
    except ModuleNotFoundError as error:
        if error.name in sys.argv[2:]:
            raise
`

/** A Python that never offers to install the command line tools (a bare /usr/bin/python3 can). */
function sealProbePython(env = process.env) {
  const candidates = [
    env.POD_SEAL_PYTHON,
    '/opt/homebrew/bin/python3',
    '/usr/local/bin/python3',
    join(homedir(), '.local/bin/python3')
  ]
  try {
    execFileSync('/usr/bin/xcode-select', ['-p'], { stdio: 'ignore' })
    candidates.push('/usr/bin/python3')
  } catch {
    // no developer tools: /usr/bin/python3 would only show their install dialog
  }
  return candidates.find((path) => Boolean(path) && existsSync(path)) ?? null
}

/** Modules in `dir` that another module there imports. */
function siblingImports(dir) {
  const modules = readdirSync(dir)
    .filter((name) => name.endsWith('.py'))
    .map((name) => name.slice(0, -3))
  const known = new Set(modules)
  const imported = new Set()
  for (const module of modules) {
    const source = readFileSync(join(dir, `${module}.py`), 'utf8')
    for (const match of source.matchAll(
      /^[ \t]*(?:from[ \t]+(\w+)[ \t]+import\b|import[ \t]+([\w \t,.]+))/gm
    )) {
      const names = match[1]
        ? [match[1]]
        : match[2].split(',').map((name) => name.trim().split(/[\s.]/)[0])
      for (const name of names) {
        if (known.has(name) && name !== module) {
          imported.add(name)
        }
      }
    }
  }
  return [...imported].sort()
}

/** Folders of the payload with Python in them, apps and the Orca plugin left out. */
function pythonDirs(dir) {
  const entries = readdirSync(dir, { withFileTypes: true })
  const nested = entries
    .filter(
      (entry) => entry.isDirectory() && !entry.name.endsWith('.app') && entry.name !== 'orca-plugin'
    )
    .flatMap((entry) => pythonDirs(join(dir, entry.name)))
  return entries.some((entry) => entry.isFile() && entry.name.endsWith('.py'))
    ? [dir, ...nested]
    : nested
}

/**
 * One probe per payload folder whose modules import each other. Throws instead of returning
 * none: a gate that ran no Python proves nothing about the seal (v5.3.1 passed with 0 probes).
 */
function podAccSealProbes(app, { payload = 'claude-acc', python = sealProbePython() } = {}) {
  const payloadDir = join(app, 'Contents', 'Resources', payload)
  if (!existsSync(join(payloadDir, 'VERSION'))) {
    throw new Error(`no claude-acc payload in ${app}`)
  }
  if (!python) {
    throw new Error('no Python to probe the claude-acc payload with: set POD_SEAL_PYTHON')
  }
  const probes = pythonDirs(payloadDir).flatMap((dir) => {
    const modules = siblingImports(dir)
    return modules.length === 0
      ? []
      : [
          {
            name: `claude-acc ${relative(payloadDir, dir) || '.'}: import ${modules.join(', ')}`,
            command: python,
            args: ['-I', '-c', IMPORT_SIBLINGS, dir, ...modules]
          }
        ]
  })
  if (probes.length === 0) {
    throw new Error(`no claude-acc module imports another in ${payloadDir}`)
  }
  return probes
}

module.exports = { podAccSealProbes, sealProbePython, siblingImports }
