import {
  constants,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join, relative, sep } from 'node:path'

// First launch of a renamed product: clone the legacy Orca profile into the product's own userData,
// hand the live terminal daemons over by symlink, and reuse the legacy safeStorage key. The legacy
// profile, keychain item and daemons are never modified, so going back to Orca stays possible.

export const PRODUCT_MIGRATION_MARKER = 'product-profile-migration.json'

// Caches and Chromium process locks regenerate; the daemon dir is linked, not copied.
const SKIPPED_TOP_LEVEL = new Set([
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'Crashpad',
  'Shared Dictionary',
  'SingletonCookie',
  'SingletonLock',
  'SingletonSocket',
  'daemon'
])
// Any of these means the product profile holds real state and must not be overwritten.
const PROFILE_STATE_ENTRIES = ['orca-data.json', 'orca-profile-index.json', 'profiles']
const DAEMON_PID_FILE = /^daemon-v(\d+)\.pid$/
// Chromium's generated safe-storage secret is base64; anything else is refused rather than quoted.
const SAFE_STORAGE_SECRET = /^[A-Za-z0-9+/=]{8,256}$/

export type SafeStorageKeychainPort = {
  hasItem(service: string, account: string): boolean
  /** Null when the item is absent or the user denied access. */
  readSecret(service: string, account: string): string | null
  writeSecret(service: string, account: string, secret: string, trustedAppPath: string | null): void
}

export type LegacyProfileMigrationOptions = {
  legacyUserData: string
  productUserData: string
  legacyKeychainName: string | null
  productKeychainName: string
  /** The running product .app, added to the new keychain item's access list. */
  trustedAppPath: string | null
  keychain: SafeStorageKeychainPort | null
  attachableDaemonProtocols: readonly number[]
  appVersion: string
  isProcessAlive?: (pid: number) => boolean
  now?: () => Date
}

export type SafeStorageAdoption = 'adopted' | 'already-present' | 'unavailable' | 'not-applicable'

export type LegacyProfileMigrationResult =
  | { status: 'not-needed'; reason: 'product-profile-exists' | 'no-legacy-profile' }
  | { status: 'blocked'; reason: 'legacy-app-running' | 'migration-in-progress'; pid: number }
  | { status: 'imported'; linkedDaemons: number[]; safeStorage: SafeStorageAdoption }

export function safeStorageService(keychainName: string): string {
  return `${keychainName} Safe Storage`
}

export function safeStorageAccount(keychainName: string): string {
  return `${keychainName} Key`
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return Reflect.get(Object(error), 'code') === 'EPERM'
  }
}

/** Chromium's SingletonLock is a symlink to "<host>-<pid>"; returns that pid if it is still alive. */
function liveSingletonOwner(userData: string, isAlive: (pid: number) => boolean): number | null {
  let target: string
  try {
    target = readlinkSync(join(userData, 'SingletonLock'))
  } catch {
    return null
  }
  const pid = Number.parseInt(target.slice(target.lastIndexOf('-') + 1), 10)
  return Number.isSafeInteger(pid) && pid > 0 && isAlive(pid) ? pid : null
}

function readPid(path: string): number | null {
  try {
    const record: unknown = JSON.parse(readFileSync(path, 'utf8'))
    const pid = typeof record === 'object' && record !== null ? Reflect.get(record, 'pid') : null
    return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

function shouldCopy(legacyUserData: string, source: string): boolean {
  const rel = relative(legacyUserData, source)
  if (rel === '') {
    return true
  }
  if (SKIPPED_TOP_LEVEL.has(rel.split(sep)[0] ?? '')) {
    return false
  }
  try {
    const stat = lstatSync(source)
    // Sockets and FIFOs belong to running processes and cannot be copied.
    return stat.isFile() || stat.isDirectory() || stat.isSymbolicLink()
  } catch {
    return false
  }
}

/** Links each live, attachable legacy daemon's socket, token and pid record into the new profile. */
function linkLiveDaemons(
  legacyUserData: string,
  stagingUserData: string,
  attachable: ReadonlySet<number>,
  isAlive: (pid: number) => boolean
): number[] {
  const legacyDaemonDir = join(legacyUserData, 'daemon')
  if (!existsSync(legacyDaemonDir)) {
    return []
  }
  const linked: number[] = []
  for (const entry of readdirSync(legacyDaemonDir)) {
    const match = DAEMON_PID_FILE.exec(entry)
    if (!match) {
      continue
    }
    const protocol = Number.parseInt(match[1] ?? '', 10)
    const pid = readPid(join(legacyDaemonDir, entry))
    if (!attachable.has(protocol) || pid === null || !isAlive(pid)) {
      continue
    }
    const files = ['sock', 'token', 'pid'].map((ext) => `daemon-v${protocol}.${ext}`)
    if (!files.every((file) => existsSync(join(legacyDaemonDir, file)))) {
      continue
    }
    mkdirSync(join(stagingUserData, 'daemon'), { recursive: true, mode: 0o700 })
    for (const file of files) {
      symlinkSync(join(legacyDaemonDir, file), join(stagingUserData, 'daemon', file))
    }
    linked.push(protocol)
  }
  return linked.sort((left, right) => left - right)
}

function adoptSafeStorageKey(options: LegacyProfileMigrationOptions): SafeStorageAdoption {
  const { keychain, legacyKeychainName, productKeychainName } = options
  if (!keychain || !legacyKeychainName || legacyKeychainName === productKeychainName) {
    return 'not-applicable'
  }
  const productService = safeStorageService(productKeychainName)
  const productAccount = safeStorageAccount(productKeychainName)
  if (keychain.hasItem(productService, productAccount)) {
    return 'already-present'
  }
  // Why reuse the legacy secret instead of re-encrypting: cookies, profile secrets and the shared
  // ~/.orca token files all stay readable by both apps, which is what keeps a rollback lossless.
  const secret = keychain.readSecret(
    safeStorageService(legacyKeychainName),
    safeStorageAccount(legacyKeychainName)
  )
  if (secret === null || !SAFE_STORAGE_SECRET.test(secret)) {
    return 'unavailable'
  }
  keychain.writeSecret(productService, productAccount, secret, options.trustedAppPath)
  return 'adopted'
}

/** Missing, or holding only what Chromium creates on its own before the profile is first used. */
function isUnusedProfile(userData: string): boolean {
  return (
    !existsSync(userData) ||
    ![...PROFILE_STATE_ENTRIES, PRODUCT_MIGRATION_MARKER].some((entry) =>
      existsSync(join(userData, entry))
    )
  )
}

/** One rename when userData is absent; otherwise per entry, state files and marker last. */
function publishStaging(staging: string, productUserData: string): void {
  if (!existsSync(productUserData)) {
    renameSync(staging, productUserData)
    return
  }
  const rank = (entry: string): number =>
    entry === PRODUCT_MIGRATION_MARKER ? 2 : PROFILE_STATE_ENTRIES.includes(entry) ? 1 : 0
  const entries = readdirSync(staging).sort((left, right) => rank(left) - rank(right))
  for (const entry of entries) {
    if (!existsSync(join(productUserData, entry))) {
      renameSync(join(staging, entry), join(productUserData, entry))
    }
  }
  rmSync(staging, { recursive: true, force: true })
}

export function migrateLegacyProfile(
  options: LegacyProfileMigrationOptions
): LegacyProfileMigrationResult {
  const isAlive = options.isProcessAlive ?? defaultIsProcessAlive
  const { legacyUserData, productUserData } = options
  if (!isUnusedProfile(productUserData)) {
    return { status: 'not-needed', reason: 'product-profile-exists' }
  }
  if (!existsSync(legacyUserData)) {
    return { status: 'not-needed', reason: 'no-legacy-profile' }
  }
  // Copying databases while the legacy app writes them would capture a torn state.
  const legacyOwner = liveSingletonOwner(legacyUserData, isAlive)
  if (legacyOwner !== null) {
    return { status: 'blocked', reason: 'legacy-app-running', pid: legacyOwner }
  }

  const staging = join(dirname(productUserData), `.${basename(productUserData)}.migrating`)
  const stagingOwnerFile = join(staging, '.owner')
  if (existsSync(staging)) {
    const owner = readPid(stagingOwnerFile)
    if (owner !== null && owner !== process.pid && isAlive(owner)) {
      return { status: 'blocked', reason: 'migration-in-progress', pid: owner }
    }
    rmSync(staging, { recursive: true, force: true })
  }
  mkdirSync(dirname(productUserData), { recursive: true })
  mkdirSync(staging, { mode: 0o700 })
  writeFileSync(stagingOwnerFile, JSON.stringify({ pid: process.pid }))

  // Why clone: APFS clonefile makes a multi-GB profile copy near-instant and space-free.
  cpSync(legacyUserData, staging, {
    recursive: true,
    force: false,
    errorOnExist: false,
    preserveTimestamps: true,
    verbatimSymlinks: true,
    mode: constants.COPYFILE_FICLONE,
    filter: (source) => shouldCopy(legacyUserData, source)
  })
  const linkedDaemons = linkLiveDaemons(
    legacyUserData,
    staging,
    new Set(options.attachableDaemonProtocols),
    isAlive
  )
  const safeStorage = adoptSafeStorageKey(options)
  writeFileSync(
    join(staging, PRODUCT_MIGRATION_MARKER),
    `${JSON.stringify(
      {
        from: legacyUserData,
        at: (options.now ?? (() => new Date()))().toISOString(),
        appVersion: options.appVersion,
        linkedDaemons,
        safeStorage,
        permissionsNoticeShown: false
      },
      null,
      2
    )}\n`
  )
  rmSync(stagingOwnerFile, { force: true })
  publishStaging(staging, productUserData)
  return { status: 'imported', linkedDaemons, safeStorage }
}
