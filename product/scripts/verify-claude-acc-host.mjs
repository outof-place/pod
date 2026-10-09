#!/usr/bin/env node
// Checks that a built product app declares its names for claude-acc (Info.plist `ClaudeAccHost`),
// and that claude-acc's orcahost.py resolves the app as the product host.
//
//   node product/scripts/verify-claude-acc-host.mjs <App.app> [orcahost.py]
//
// orcahost.py defaults to the payload in the app (Resources/claude-acc), then the repo's
// resources/claude-acc; without one, only the Info.plist half runs.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const repoRoot = join(import.meta.dirname, '..', '..')
const ORCA_CLAUDE_SERVICE = 'Orca Claude Code Managed Credentials'

function readIdentity() {
  return JSON.parse(readFileSync(join(repoRoot, 'product', 'identity.json'), 'utf8'))
}

function readInfoPlist(app) {
  const plist = join(app, 'Contents', 'Info.plist')
  return JSON.parse(
    execFileSync('plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8' })
  )
}

function findOrcahost(app) {
  return [
    join(app, 'Contents', 'Resources', 'claude-acc', 'orcahost.py'),
    join(repoRoot, 'resources', 'claude-acc', 'orcahost.py')
  ].find((path) => existsSync(path))
}

function expect(problems, label, actual, wanted) {
  if (actual !== wanted) {
    problems.push(`${label}: ${JSON.stringify(actual)}, expected ${JSON.stringify(wanted)}`)
  }
}

/** Problems found (empty when the app is a well-formed claude-acc host); `resolved` is orcahost's view. */
export function verifyClaudeAccHost(app, { orcahost = findOrcahost(app), home = homedir() } = {}) {
  const identity = readIdentity()
  const problems = []
  const declared = readInfoPlist(app).ClaudeAccHost ?? {}
  expect(
    problems,
    'ClaudeAccHost.userData',
    declared.userData,
    `~/Library/Application Support/${identity.userDataName}`
  )
  expect(problems, 'ClaudeAccHost.cli', declared.cli, identity.cliName)
  if (!orcahost) {
    return { problems, resolved: null }
  }
  // A clean env: inside a host terminal ORCA_USER_DATA_PATH would point the runtime file elsewhere.
  const resolved = JSON.parse(
    execFileSync('python3', ['-I', orcahost], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: home,
        CLAUDE_ACC_HOST: 'pod',
        POD_APP_PATH: app
      }
    })
  )
  const userData = join(home, 'Library', 'Application Support', identity.userDataName)
  expect(problems, 'orcahost kind', resolved.kind, 'pod')
  expect(problems, 'orcahost bundle_id', resolved.bundle_id, identity.appId)
  expect(problems, 'orcahost executable', resolved.executable, identity.displayName)
  expect(problems, 'orcahost user_data', resolved.user_data, userData)
  expect(problems, 'orcahost cli', resolved.cli, identity.cliName)
  expect(problems, 'orcahost keychain_service', resolved.keychain_service, ORCA_CLAUDE_SERVICE)
  expect(problems, 'orcahost hooks', resolved.hooks, '.orca/agent-hooks')
  expect(problems, 'orcahost runtime', resolved.runtime, join(userData, 'orca-runtime.json'))
  return { problems, resolved }
}

if (process.argv[1] === import.meta.filename) {
  const [app, orcahost] = process.argv.slice(2)
  if (!app) {
    console.error('usage: verify-claude-acc-host.mjs <App.app> [orcahost.py]')
    process.exit(2)
  }
  const { problems, resolved } = verifyClaudeAccHost(app, orcahost ? { orcahost } : {})
  if (problems.length > 0) {
    console.error(`claude-acc host check failed for ${app}:\n  ${problems.join('\n  ')}`)
    process.exit(1)
  }
  console.log(
    resolved
      ? `claude-acc host: ${resolved.name} (${resolved.bundle_id}), ${resolved.user_data}, cli ${resolved.cli}`
      : 'claude-acc host: Info.plist declares it (no orcahost.py to resolve with)'
  )
}
