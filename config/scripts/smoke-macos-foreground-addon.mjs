import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once, EventEmitter } from 'node:events'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createPackage } from '@electron/asar'
import { build } from 'esbuild'
import { createForegroundFixtureBundle } from './macos-foreground-fixture-bundle.mjs'

assert.equal(process.platform, 'darwin', 'this fixture requires macOS')
const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '../..')
const scratch = mkdtempSync(join(tmpdir(), 'orca-foreground-package-'))
const scratchIdentity = lstatSync(scratch)
const scratchRealpath = realpathSync(scratch)
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
let fixtureBundle
let ownedTty

function command(program, args) {
  return execFileSync(program, args, { encoding: 'utf8', timeout: 120_000, env })
}

function acknowledgment(event) {
  const pending = new Promise((resolveAck, reject) => {
    const timer = setTimeout(() => {
      onFailure(new Error(`Timed out waiting for PTY ${event}`))
    }, 5_000)
    timer.unref()
    const clear = () => {
      clearTimeout(timer)
      fixtureEvents.removeListener(event, onAck)
      fixtureEvents.removeListener('failure', onFailure)
    }
    const onAck = (value) => {
      clear()
      resolveAck(value)
    }
    const onFailure = (error) => {
      clear()
      reject(error)
    }
    fixtureEvents.once(event, onAck)
    fixtureEvents.once('failure', onFailure)
  })
  pending.catch(() => {})
  return pending
}

async function main() {
  command(process.execPath, ['config/scripts/build-proc-info-macos.mjs'])
  fixtureBundle = createForegroundFixtureBundle({
    sourceApp: dirname(dirname(dirname(require('electron')))),
    sourceAddon,
    app,
    scratch
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
  fixtureBundle.validate()
  command('codesign', ['--force', '--sign', '-', addon])
  fixtureBundle.seal()

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
  let terminalErrors = ''
  terminal.stderr.on('data', (data) => {
    terminalErrors = (terminalErrors + data).slice(-4096)
  })
  terminal.once('error', (error) => fixtureEvents.emit('failure', error))
  terminal.once('exit', (code, signal) => {
    fixtureEvents.emit('failure', new Error(`PTY exited ${code ?? signal}: ${terminalErrors}`))
  })
  await ready
  const [pid, parent, group, tty] = command('ps', [
    '-p',
    String(ownedPid),
    '-o',
    'pid=,ppid=,tpgid=,tty='
  ])
    .trim()
    .split(/\s+/)
  assert.equal(Number(pid), ownedPid)
  assert.equal(Number(parent), terminal.pid)
  assert(Number(group) > 1 && tty && tty !== '??', 'PTY fixture has no foreground group')
  ownedGroup = Number(group)
  ownedTty = tty
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
  const ownHostOutput = execFileSync(
    'script',
    ['-q', '/dev/null', executable, archiveEntry, 'own-host'],
    { encoding: 'utf8', timeout: 30_000, env, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  const ownHostMatch = ownHostOutput.match(/\{"mode":"own-host"[^\r\n]+\}/)
  assert(ownHostMatch, 'packaged own-terminal guard produced no result')
  const ownHostGuard = JSON.parse(ownHostMatch[0])
  await run('disabled', executable, archiveEntry, { ORCA_DISABLE_NATIVE_PROCESS_INFO: '1' })
  rmSync(addon)
  fixtureBundle.seal()
  await run('missing')
  command('lipo', [
    sourceAddon,
    '-thin',
    process.arch === 'arm64' ? 'x86_64' : 'arm64',
    '-output',
    addon
  ])
  fixtureBundle.validate()
  command('codesign', ['--force', '--sign', '-', addon])
  fixtureBundle.seal()
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
  fixtureBundle.assertSourcesPreserved()
  console.log(
    JSON.stringify({
      signing: 'ad-hoc sealed fixture; no Developer ID, hardened-runtime or notarization claim',
      validatedFixtureEntries: fixtureBundle.validatedEntries,
      ownHostGuard,
      sourcePreserved: true,
      realPtyResizeAcknowledgments: results.length,
      results
    })
  )
}

try {
  await main()
} finally {
  if (ownedGroup && ownedTty) {
    try {
      const current = command('ps', ['-p', String(ownedPid), '-o', 'pid=,ppid=,tpgid=,tty='])
        .trim()
        .split(/\s+/)
      if (current.join(' ') === [ownedPid, terminal.pid, ownedGroup, ownedTty].join(' ')) {
        process.kill(-ownedGroup, 'SIGTERM')
      }
    } catch (error) {
      if (error.code !== 'ESRCH' && error.status !== 1) {
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
  if (fixtureBundle) {
    fixtureBundle.cleanup()
  } else if (existsSync(scratch)) {
    const current = lstatSync(scratch)
    assert(
      current.isDirectory() &&
        current.dev === scratchIdentity.dev &&
        current.ino === scratchIdentity.ino
    )
    assert.equal(realpathSync(scratch), scratchRealpath)
    rmSync(scratch, { recursive: true, force: true })
  }
}
