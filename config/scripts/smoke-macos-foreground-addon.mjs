import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once, EventEmitter } from 'node:events'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { createPackage } from '@electron/asar'
import { build } from 'esbuild'

assert.equal(process.platform, 'darwin', 'this fixture requires macOS')
const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '../..')
const scratch = mkdtempSync(join(tmpdir(), 'orca-foreground-package-'))
const app = join(scratch, 'Foreground Fixture.app')
const resources = join(app, 'Contents', 'Resources')
const addon = join(resources, 'native', 'orca-proc-info.node')
const sourceAddon = join(root, 'native/proc-info-darwin/.build/release/orca-proc-info.node')
const devRoot = join(scratch, 'decoy-checkout')
const devAddon = join(devRoot, 'native/proc-info-darwin/.build/release/orca-proc-info.node')
const source = join(scratch, 'archive-source')
const entryName = 'out/main/foreground-fixture.cjs'
const archiveEntry = join(resources, 'app.asar', entryName)
const executable = join(app, 'Contents', 'MacOS', 'Electron')
const fixtureEvents = new EventEmitter()
const env = {
  ...process.env,
  ORCA_BACKGROUND_LAUNCH: '1',
  ORCA_DISABLE_NATIVE_PROCESS_INFO: '0',
  ELECTRON_RUN_AS_NODE: '1'
}
let terminal
let ownedPid = 0
let ownedGroup = 0
let validatedFixtureEntries = 0

function command(program, args) {
  return execFileSync(program, args, { encoding: 'utf8', timeout: 120_000, env })
}

function acknowledgment(event) {
  return new Promise((resolveAck, reject) => {
    const timer = setTimeout(() => {
      fixtureEvents.removeListener(event, onAck)
      reject(new Error(`Timed out waiting for PTY ${event}`))
    }, 5_000)
    const onAck = (value) => {
      clearTimeout(timer)
      resolveAck(value)
    }
    fixtureEvents.once(event, onAck)
  })
}

function validateFixture() {
  const fixtureRoot = realpathSync(app)
  const directories = [app]
  validatedFixtureEntries = 0
  while (directories.length) {
    for (const entry of readdirSync(directories.pop(), { withFileTypes: true })) {
      assert(++validatedFixtureEntries < 10_000, 'unexpected fixture size')
      const path = join(entry.parentPath, entry.name)
      const resolved = relative(fixtureRoot, realpathSync(path))
      assert(!isAbsolute(resolved) && resolved !== '..' && !resolved.startsWith('../'))
      if (entry.isDirectory()) {
        directories.push(path)
      }
    }
  }
}

function sealFixture() {
  validateFixture()
  command('codesign', ['--force', '--deep', '--sign', '-', app])
  command('codesign', ['--verify', '--deep', '--strict', app])
}

async function main() {
  command(process.execPath, ['config/scripts/build-proc-info-macos.mjs'])
  const originalExecutable = require('electron')
  cpSync(dirname(dirname(dirname(originalExecutable))), app, {
    recursive: true,
    verbatimSymlinks: true
  })
  mkdirSync(dirname(addon), { recursive: true })
  mkdirSync(dirname(devAddon), { recursive: true })
  cpSync(sourceAddon, addon)
  cpSync(sourceAddon, devAddon)
  await build({
    entryPoints: [join(root, 'config/scripts/macos-foreground-addon-fixture.ts')],
    outfile: join(source, entryName),
    bundle: true,
    platform: 'node',
    format: 'cjs'
  })
  await createPackage(source, join(resources, 'app.asar'))
  validateFixture()
  command('codesign', ['--force', '--sign', '-', addon])
  sealFixture()

  const ready = acknowledgment('ready')
  terminal = spawn(
    'script',
    [
      '-q',
      '/dev/null',
      '/bin/sh',
      '-c',
      'trap \'printf "ORCA_RESIZE_ACK\\n"\' WINCH; printf "ORCA_PTY_READY:%s\\n" "$$"; while :; do sleep 60 & wait $!; done'
    ],
    { env, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  let output = ''
  terminal.stdout.on('data', (data) => {
    output = (output + data).slice(-4096)
    const match = output.match(/ORCA_PTY_READY:(\d+)/)
    if (match && !ownedPid) {
      ownedPid = Number(match[1])
      fixtureEvents.emit('ready')
    }
    if (output.includes('ORCA_RESIZE_ACK')) {
      output = ''
      fixtureEvents.emit('resize')
    }
  })
  terminal.once('error', (error) => fixtureEvents.emit('error', error))
  await ready
  const [pid, group, tty] = command('ps', ['-p', String(ownedPid), '-o', 'pid=,tpgid=,tty='])
    .trim()
    .split(/\s+/)
  assert.equal(Number(pid), ownedPid)
  assert(Number(group) > 1 && tty && tty !== '??', 'PTY fixture has no foreground group')
  ownedGroup = Number(group)
  const results = []
  async function run(mode, program = executable, entry = archiveEntry, overrides = {}) {
    const resized = acknowledgment('resize')
    const result = execFileSync(program, [entry, mode, pid, tty, group, devRoot], {
      encoding: 'utf8',
      timeout: 30_000,
      cwd: devRoot,
      env: { ...env, ...overrides }
    })
    await resized
    results.push(JSON.parse(result.trim()))
  }
  await run('valid')
  await run('disabled', executable, archiveEntry, { ORCA_DISABLE_NATIVE_PROCESS_INFO: '1' })
  rmSync(addon)
  sealFixture()
  await run('missing')
  command('lipo', [
    sourceAddon,
    '-thin',
    process.arch === 'arm64' ? 'x86_64' : 'arm64',
    '-output',
    addon
  ])
  validateFixture()
  command('codesign', ['--force', '--sign', '-', addon])
  sealFixture()
  await run('incompatible')
  const nodeEnv = { ...env }
  delete nodeEnv.ELECTRON_RUN_AS_NODE
  const resized = acknowledgment('resize')
  results.push(
    JSON.parse(
      execFileSync(process.execPath, [join(source, entryName), 'dev', pid, tty, group, devRoot], {
        encoding: 'utf8',
        timeout: 30_000,
        cwd: devRoot,
        env: nodeEnv
      }).trim()
    )
  )
  await resized
  console.log(
    JSON.stringify({
      signing: 'ad-hoc sealed fixture; no Developer ID, hardened-runtime or notarization claim',
      validatedFixtureEntries,
      realPtyResizeAcknowledgments: results.length,
      results
    })
  )
}

try {
  await main()
} finally {
  if (ownedGroup || ownedPid) {
    try {
      process.kill(ownedGroup ? -ownedGroup : ownedPid, 'SIGTERM')
    } catch (error) {
      if (error.code !== 'ESRCH') {
        console.error(error)
        process.exitCode = 1
      }
    }
  }
  if (terminal && terminal.exitCode === null && terminal.signalCode === null) {
    const exited = once(terminal, 'exit')
    terminal.kill('SIGKILL')
    await exited
  }
  rmSync(scratch, { recursive: true, force: true })
}
