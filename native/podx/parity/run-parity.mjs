#!/usr/bin/env node
// Parity harness: runs every case through the Node CLI and native podx against the same scripted
// runtime and compares stdout, stderr, exit code and the requests each one sent.
// Usage: node native/podx/parity/run-parity.mjs [--podx <bin>] [--cli <out/cli/index.js>]
//          [--node <node>] [--argv-file <json array of argv arrays>] [--filter <substring>]
import { fork, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildCases } from './cases.mjs'
import { baseWorld } from './world.mjs'

const here = path.dirname(new URL(import.meta.url).pathname)
const repo = path.resolve(here, '../../..')
const opt = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}
const podx = path.resolve(opt('podx', path.join(here, '..', '.build', 'release', 'podx')))
const cli = path.resolve(opt('cli', path.join(repo, 'out', 'cli', 'index.js')))
const node = opt('node', process.execPath)
const filter = opt('filter', null)
const argvFile = opt('argv-file', null)

const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'podx-parity-')))
const worktree = path.join(dir, 'wt', 'app')
const nested = path.join(worktree, 'packages', 'web')
mkdirSync(nested, { recursive: true })

// Native podx falls back by exec'ing POD_NATIVE_CLI_NODE; this wrapper records when it does.
const fallbackLog = path.join(dir, 'fallback.log')
const nodeWrapper = path.join(dir, 'node-fallback.sh')
writeFileSync(nodeWrapper, `#!/bin/sh\necho fallback >> '${fallbackLog}'\nexec '${node}' "$@"\n`, {
  mode: 0o755
})

const server = fork(path.join(here, 'fake-runtime.mjs'), [dir], {
  stdio: ['ignore', 'pipe', 'inherit', 'ipc']
})
await new Promise((resolve) => server.stdout.once('data', resolve))
const reset = () =>
  new Promise((resolve) => {
    server.once('message', resolve)
    server.send('reset')
  })

const world = baseWorld({ worktree, nested, dir })
const cases = buildCases({ world, worktree, nested, dir })
if (argvFile) {
  for (const [i, argv] of JSON.parse(readFileSync(argvFile, 'utf8')).entries()) {
    cases.push({ name: `transcript#${i} ${argv.slice(0, 2).join(' ')}`, argv })
  }
}

const UUID = /"id": "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"/g
const UUID_VALUE = /"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"/g
const normalize = (text) => text.replace(UUID, '"id": "<uuid>"')

function sortKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeys)
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortKeys(value[k])])
    )
  }
  return value
}

// A case's own profile dir; __SOCK__ and __PID__ name the scripted runtime's socket and pid.
function writeUserData(testCase) {
  const target = path.join(dir, `ud-${testCase.name.replaceAll(/[^a-z0-9]+/gi, '-')}`)
  mkdirSync(target, { recursive: true })
  for (const [name, content] of Object.entries(testCase.userData)) {
    writeFileSync(
      path.join(target, name),
      content
        .replaceAll('__SOCK__', path.join(dir, 'o-parity.sock'))
        .replaceAll('__PID__', String(server.pid))
    )
  }
  return target
}

async function runOne(kind, testCase) {
  writeFileSync(
    path.join(dir, 'scenario.json'),
    JSON.stringify({ responses: { ...world, ...testCase.responses } })
  )
  writeFileSync(path.join(dir, 'requests.jsonl'), '')
  writeFileSync(fallbackLog, '')
  await reset()
  const userData = testCase.userData ? writeUserData(testCase) : dir
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    ORCA_USER_DATA_PATH: userData,
    POD_NATIVE_CLI_NODE: nodeWrapper,
    POD_NATIVE_CLI_NODE_ENTRY: cli,
    ...testCase.env
  }
  const [bin, args] = kind === 'node' ? [node, [cli, ...testCase.argv]] : [podx, testCase.argv]
  const started = process.hrtime.bigint()
  const r = spawnSync(bin, args, {
    cwd: testCase.cwd ?? nested,
    env,
    encoding: 'buffer',
    input: testCase.stdin ?? ''
  })
  const ms = Number(process.hrtime.bigint() - started) / 1e6
  const requests = readFileSync(path.join(dir, 'requests.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => sortKeys(JSON.parse(l.replaceAll(UUID_VALUE, '"<uuid>"'))))
  return {
    stdout: normalize(r.stdout.toString('utf8')),
    stdoutBytes: r.stdout,
    stderr: normalize(r.stderr.toString('utf8')),
    status: r.status,
    requests,
    fellBack: readFileSync(fallbackLog, 'utf8').length > 0,
    ms
  }
}

const READ_ONLY = new Set([
  'worktree.list',
  'worktree.show',
  'terminal.list',
  'terminal.show',
  'terminal.resolveActive'
])
let fallbacks = 0
let pass = 0
const failures = []
const timing = { node: [], podx: [] }
for (const testCase of cases) {
  if (filter && !testCase.name.includes(filter)) {
    continue
  }
  const a = await runOne('node', testCase)
  const b = await runOne('podx', testCase)
  timing.node.push(a.ms)
  timing.podx.push(b.ms)
  const diffs = []
  if (a.stdout !== b.stdout) {
    diffs.push(['stdout', a.stdout, b.stdout])
  }
  if (a.stderr !== b.stderr) {
    diffs.push(['stderr', a.stderr, b.stderr])
  }
  if (a.status !== b.status) {
    diffs.push(['exit', String(a.status), String(b.status)])
  }
  // Why: a fallback after read-only lookups repeats them; that is the designed cost, not a diff.
  let nativeRequests = b.requests
  while (
    b.fellBack &&
    nativeRequests.length > a.requests.length &&
    READ_ONLY.has(nativeRequests[0].method)
  ) {
    nativeRequests = nativeRequests.slice(1)
  }
  if (JSON.stringify(a.requests) !== JSON.stringify(nativeRequests)) {
    diffs.push(['requests', JSON.stringify(a.requests), JSON.stringify(b.requests)])
  }
  const expectFallback =
    testCase.name.includes('falls back') ||
    testCase.name === 'kill switch' ||
    testCase.name === 'help falls back'
  if (!testCase.name.startsWith('transcript#') && b.fellBack !== expectFallback) {
    diffs.push(['mode', expectFallback ? 'fallback' : 'native', b.fellBack ? 'fallback' : 'native'])
  }
  if (b.fellBack) {
    fallbacks += 1
    if (process.argv.includes('--show-fallbacks')) {
      console.log(
        `fallback: ${JSON.stringify(testCase.argv.map((t) => (t.startsWith('--') ? t.split('=')[0] : t.length > 24 ? '…' : t)))}`
      )
    }
  }
  if (diffs.length === 0) {
    pass += 1
  } else {
    failures.push({ name: testCase.name, argv: testCase.argv, diffs })
  }
}

const p50 = (xs) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)] ?? 0
for (const f of failures) {
  console.log(`FAIL ${f.name}  argv=${JSON.stringify(f.argv)}`)
  for (const [what, node, native] of f.diffs) {
    console.log(
      `  ${what}:\n    node:   ${JSON.stringify(node).slice(0, 600)}\n    native: ${JSON.stringify(native).slice(0, 600)}`
    )
  }
}
console.log(
  `\n${pass}/${pass + failures.length} cases identical (${fallbacks} via Node fallback); wall p50 node ${p50(timing.node).toFixed(1)} ms, native ${p50(timing.podx).toFixed(1)} ms`
)
server.kill()
process.exit(failures.length === 0 ? 0 : 1)
