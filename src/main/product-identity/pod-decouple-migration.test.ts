import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { claudeProfileKeychainServices } from '../claude-accounts/claude-profile-keychain-services'
import {
  copyClaudeProfileCredentials,
  listClaudeProfileIds,
  type ClaudeCredentialsKeychainPort
} from './claude-credentials-copy'
import { copyLegacyHome, PRODUCT_HOME_COPY_RECORD } from './legacy-home-copy'

// Why: this test never reaches a keychain. The port below is a map, every subprocess helper
// throws, and a `security` shim first on PATH logs any call that slips past both.
const noProcess = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('the migration test runs no process')
  })
)
vi.mock('@orca/process-host', () => ({
  runProcess: noProcess,
  runProcessSync: noProcess
}))
vi.mock('../macos-keychain/generic-password', () => ({ readKeychainPassword: noProcess }))

// Why placeholder names: the decouple codemod rewrites the real folder literals in code.
const LEGACY_HOME = '.legacy-home'
const PRODUCT_HOME = '.product-home'
const ACCOUNT = 'claude-code-user'
const PROFILE = '9a103379-e825-411b-bc23-0b8c17acd203'
const TOKEN = '{"claudeAiOauth":{"refreshToken":"fixture"}}'

let root = ''
let home = ''
let securityLog = ''

beforeEach(() => {
  // Real path: Claude hashes the spelling it was given, and tmpdir() is a link on macOS.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'pod-decouple-migration-')))
  home = join(root, 'home')
  mkdirSync(home)
  const shimDir = join(root, 'shim')
  mkdirSync(shimDir)
  securityLog = join(root, 'security.log')
  const shim = join(shimDir, 'security')
  writeFileSync(
    shim,
    `#!/bin/bash\nprintf '%s\\n' "$*" >> '${securityLog}'\necho 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.' >&2\nexit 44\n`
  )
  chmodSync(shim, 0o755)
  vi.stubEnv('HOME', home)
  vi.stubEnv('PATH', `${shimDir}:/usr/bin:/bin`)
})

afterEach(() => {
  vi.unstubAllEnvs()
  const securityCalls = existsSync(securityLog) ? readFileSync(securityLog, 'utf8') : ''
  rmSync(root, { recursive: true, force: true })
  // Any call at all fails the test: nothing here may reach a keychain.
  expect(securityCalls).toBe('')
  expect(noProcess).not.toHaveBeenCalled()
})

function memoryKeychain(items: Record<string, string>, denied: string[] = []) {
  const store = new Map(Object.entries(items))
  const trusted: (string | null)[] = []
  const keychain: ClaudeCredentialsKeychainPort = {
    hasItem: (service, account) => account === ACCOUNT && store.has(service),
    readSecret: (service, account) =>
      account === ACCOUNT && !denied.includes(service) ? (store.get(service) ?? null) : null,
    writeSecret: (service, account, secret, trustedAppPath) => {
      expect(account).toBe(ACCOUNT)
      store.set(service, secret)
      trusted.push(trustedAppPath)
    }
  }
  return { keychain, store, trusted }
}

/** A Mac with the legacy app's home and profile, and the product's copy of that profile. */
function seedMac(options: { productHomeExists: boolean }) {
  const legacyHome = join(home, LEGACY_HOME)
  const hookScript = join(legacyHome, 'agent-hooks', 'pod-agent-hook')
  mkdirSync(join(legacyHome, 'agent-hooks'), { recursive: true })
  writeFileSync(hookScript, '#!/bin/sh\nexit 0\n')
  chmodSync(hookScript, 0o755)
  mkdirSync(join(legacyHome, 'claude-agent-teams-bin'))
  writeFileSync(join(legacyHome, 'claude-agent-teams-bin', 'claude'), '#!/bin/sh\n')
  writeFileSync(join(legacyHome, 'keybindings.json'), '[]')
  // State a running daemon or session may hold open: the copy must leave it where it is.
  mkdirSync(join(legacyHome, 'terminal-history'))
  writeFileSync(join(legacyHome, 'terminal-history', 'pane-1.log'), 'echo hi\n')
  writeFileSync(join(legacyHome, 'daemon.pid'), '1329\n')
  if (options.productHomeExists) {
    mkdirSync(join(home, PRODUCT_HOME, 'bench'), { recursive: true })
  }
  // The hooks running Claude sessions use, as settings.json names them, next to a foreign entry.
  mkdirSync(join(home, '.claude'))
  const foreignHook = { type: 'command', command: join(home, 'bin', 'user-hook'), async: true }
  writeFileSync(
    join(home, '.claude', 'settings.json'),
    `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: hookScript }, foreignHook] }] } }, null, 2)}\n`
  )
  const appData = join(home, 'Library', 'Application Support')
  const legacyUserData = join(appData, 'legacy')
  const productUserData = join(appData, 'Product')
  for (const userData of [legacyUserData, productUserData]) {
    mkdirSync(join(userData, 'claude-profiles', PROFILE, 'home'), { recursive: true })
  }
  const legacy = claudeProfileKeychainServices(legacyUserData, PROFILE, home)
  const product = claudeProfileKeychainServices(productUserData, PROFILE, home)
  return { legacyHome, hookScript, legacyUserData, productUserData, legacy, product }
}

function copyHome(productUserData: string, legacyAppPid: number | null = null) {
  return copyLegacyHome({
    home,
    legacyHomeDirName: LEGACY_HOME,
    productHomeDirName: PRODUCT_HOME,
    productUserData,
    legacyAppPid
  })
}

function copySignIns(
  mac: ReturnType<typeof seedMac>,
  keychain: ClaudeCredentialsKeychainPort,
  legacyAppPid: number | null = null
) {
  return copyClaudeProfileCredentials({
    profiles: listClaudeProfileIds(mac.productUserData).map((id) => ({
      id,
      legacyServices: claudeProfileKeychainServices(mac.legacyUserData, id, home).spellings,
      productService: claudeProfileKeychainServices(mac.productUserData, id, home).canonical
    })),
    keychainAccount: ACCOUNT,
    trustedAppPath: null,
    legacyAppPid,
    keychain
  })
}

/** Every file under `dir` with its bytes and mode, to prove a tree was left exactly as it was. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name)
      const mode = (statSync(path).mode & 0o777).toString(8)
      out[path.slice(dir.length)] = `${mode} ${readFileSync(path, 'base64')}`
    }
  }
  return out
}

function settingsHookCommands(): string[] {
  const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'))
  return settings.hooks.Stop.flatMap((group: { hooks: { command: string }[] }) =>
    group.hooks.map((hook) => hook.command)
  )
}

describe('pod-decouple migration in an isolated HOME', () => {
  it('copies user state and sign-ins once, and leaves the legacy home and settings.json alone', () => {
    const mac = seedMac({ productHomeExists: true })
    const legacyAlias = mac.legacy.spellings.find((service) => service !== mac.legacy.canonical)
    expect(legacyAlias).toBeDefined()
    expect(mac.product.canonical).not.toBe(mac.legacy.canonical)
    const legacyItems = {
      [mac.legacy.canonical]: TOKEN,
      [legacyAlias ?? '']: TOKEN,
      'Claude Code-credentials': 'the default profile, never touched'
    }
    const { keychain, store, trusted } = memoryKeychain(legacyItems)
    const legacyBefore = snapshot(mac.legacyHome)
    const settingsBefore = readFileSync(join(home, '.claude', 'settings.json'))

    expect(copyHome(mac.productUserData)).toEqual({
      status: 'copied',
      copied: ['daemon.pid', 'keybindings.json', 'terminal-history'],
      skipped: ['agent-hooks', 'claude-agent-teams-bin']
    })
    expect(readdirSync(join(home, PRODUCT_HOME)).sort()).toEqual([
      'bench',
      'daemon.pid',
      'keybindings.json',
      'terminal-history'
    ])
    expect(snapshot(mac.legacyHome)).toEqual(legacyBefore)
    // Running sessions still find every hook script settings.json names in the legacy home.
    const legacyCommands = settingsHookCommands().filter((command) =>
      command.startsWith(mac.legacyHome)
    )
    expect(legacyCommands).toEqual([mac.hookScript])
    expect(existsSync(mac.hookScript)).toBe(true)

    expect(copySignIns(mac, keychain)).toEqual({ status: 'copied', copied: [PROFILE], denied: [] })
    expect(Object.fromEntries(store)).toEqual({ ...legacyItems, [mac.product.canonical]: TOKEN })
    expect(trusted).toEqual([null])

    // A second launch changes nothing.
    expect(copyHome(mac.productUserData)).toEqual({
      status: 'not-needed',
      reason: 'already-recorded'
    })
    expect(copySignIns(mac, keychain)).toEqual({
      status: 'not-needed',
      reason: 'no-legacy-sign-ins'
    })
    expect(store.size).toBe(4)
    expect(snapshot(mac.legacyHome)).toEqual(legacyBefore)
    expect(readFileSync(join(home, '.claude', 'settings.json'))).toEqual(settingsBefore)
  })

  it('creates the product home on a Mac without one, and records what to delete to undo', () => {
    const mac = seedMac({ productHomeExists: false })
    expect(copyHome(mac.productUserData)).toMatchObject({
      status: 'copied',
      copied: ['daemon.pid', 'keybindings.json', 'terminal-history']
    })
    expect(existsSync(join(home, PRODUCT_HOME, 'keybindings.json'))).toBe(true)
    expect(existsSync(join(home, PRODUCT_HOME, 'agent-hooks'))).toBe(false)
    expect(existsSync(mac.hookScript)).toBe(true)
    expect(
      JSON.parse(readFileSync(join(mac.productUserData, PRODUCT_HOME_COPY_RECORD), 'utf8'))
    ).toMatchObject({
      from: mac.legacyHome,
      to: join(home, PRODUCT_HOME),
      result: { copied: ['daemon.pid', 'keybindings.json', 'terminal-history'] }
    })
  })

  it('touches nothing while the legacy app runs, and copies no sign-in it may not read', () => {
    const mac = seedMac({ productHomeExists: true })
    const running = memoryKeychain({ [mac.legacy.canonical]: TOKEN })
    expect(copyHome(mac.productUserData, 501)).toEqual({
      status: 'deferred',
      reason: 'legacy-app-running',
      pid: 501
    })
    expect(copySignIns(mac, running.keychain, 501)).toEqual({
      status: 'deferred',
      reason: 'legacy-app-running',
      pid: 501
    })
    expect(readdirSync(join(home, PRODUCT_HOME))).toEqual(['bench'])
    expect(existsSync(join(mac.productUserData, PRODUCT_HOME_COPY_RECORD))).toBe(false)
    expect([...running.store.keys()]).toEqual([mac.legacy.canonical])

    const denied = memoryKeychain({ [mac.legacy.canonical]: TOKEN }, [mac.legacy.canonical])
    expect(copySignIns(mac, denied.keychain)).toEqual({
      status: 'copied',
      copied: [],
      denied: [PROFILE]
    })
    expect([...denied.store.keys()]).toEqual([mac.legacy.canonical])
  })
})
