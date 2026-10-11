import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const script = join(__dirname, '..', '..', '..', 'product', 'notary-credentials.sh')
const ISSUER = '00000000-0000-4000-8000-000000000000'

// Bash, not a template literal: `${...}` here is the shell's.
const RESOLVE = [
  'set -euo pipefail',
  'die() { echo "DIE $*"; exit 3; }',
  '. "$1"',
  'pod_notary_credentials pod-notary',
  'echo "args ${notary_args[*]}"',
  'echo "env profile=${APPLE_KEYCHAIN_PROFILE:-} key_id=${APPLE_API_KEY_ID:-} issuer=${APPLE_API_ISSUER:-}"'
].join('\n')

let root: string | null = null

afterEach(() => {
  if (root) {
    rmSync(root, { recursive: true, force: true })
    root = null
  }
})

function appStoreConnect(keys: string[], issuer: string | null): string {
  root = mkdtempSync(join(tmpdir(), 'pod-notary-'))
  mkdirSync(join(root, 'private_keys'))
  for (const key of keys) {
    writeFileSync(join(root, 'private_keys', `AuthKey_${key}.p8`), 'not a real key\n')
  }
  if (issuer !== null) {
    writeFileSync(join(root, 'issuer'), `${issuer}\n`)
  }
  return root
}

/** Sources the resolver in a clean environment; prints notary_args and the variables it left. */
function resolve(asc: string, env: Record<string, string> = {}): string {
  const result = spawnSync('/bin/bash', ['-c', RESOLVE, 'resolve', script], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: asc, POD_APPSTORECONNECT_DIR: asc, ...env }
  })
  return `${result.stdout}${result.stderr}`.trim()
}

describe('notarization credentials', () => {
  it('uses the App Store Connect key on disk by default', () => {
    const asc = appStoreConnect(['KX7Q6Y844C'], ISSUER)
    expect(resolve(asc)).toBe(
      [
        `args --key ${asc}/private_keys/AuthKey_KX7Q6Y844C.p8 --key-id KX7Q6Y844C --issuer ${ISSUER}`,
        `env profile= key_id=KX7Q6Y844C issuer=${ISSUER}`
      ].join('\n')
    )
  })

  it('falls back to the keychain profile without an issuer or with more than one key', () => {
    const profile = ['args --keychain-profile pod-notary', 'env profile=pod-notary key_id= issuer=']
    expect(resolve(appStoreConnect(['KX7Q6Y844C'], null))).toBe(profile.join('\n'))
    rmSync(root ?? '', { recursive: true, force: true })
    expect(resolve(appStoreConnect(['A1', 'B2'], ISSUER))).toBe(profile.join('\n'))
  })

  it('lets explicit variables win over the key on disk', () => {
    const asc = appStoreConnect(['KX7Q6Y844C'], ISSUER)
    expect(resolve(asc, { NOTARY_PROFILE: 'other' })).toBe(
      ['args --keychain-profile other', 'env profile=other key_id= issuer='].join('\n')
    )
  })

  it('falls back to HOME when the user database cannot be read (no dscl, as on Linux)', () => {
    const asc = appStoreConnect(['KX7Q6Y844C'], ISSUER)
    const bin = join(asc, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'dscl'), '#!/bin/bash\nexit 127\n', { mode: 0o755 })
    expect(resolve(asc, { PATH: `${bin}:/usr/bin:/bin` })).toBe(
      [
        `args --key ${asc}/private_keys/AuthKey_KX7Q6Y844C.p8 --key-id KX7Q6Y844C --issuer ${ISSUER}`,
        `env profile= key_id=KX7Q6Y844C issuer=${ISSUER}`
      ].join('\n')
    )
  })

  it('refuses an issuer file that holds no issuer id', () => {
    expect(resolve(appStoreConnect(['KX7Q6Y844C'], 'not-an-id'))).toMatch(
      /^DIE .*issuer is not an App Store Connect issuer id$/
    )
  })
})

// Stubs on PATH: the preflight never reaches the real `security`, notarytool or user database.
const STUBS: Record<string, string> = {
  dscl: 'echo "NFSHomeDirectory: $FAKE_HOME"',
  security: [
    'case "$*" in',
    '  "default-keychain -d user") echo "    \\"$FAKE_DEFAULT\\"" ;;',
    '  "list-keychains -d user") echo "    \\"$FAKE_DEFAULT\\""; echo "    \\"/Library/Keychains/System.keychain\\"" ;;',
    '  *) echo "unexpected security $*" >&2; exit 9 ;;',
    'esac'
  ].join('\n'),
  xcrun:
    'echo "$*" > "$XCRUN_ARGS"\nif [ -n "${XCRUN_FAIL:-}" ]; then echo "$XCRUN_FAIL" >&2; exit 1; fi'
}

const PREFLIGHT = [
  'set -euo pipefail',
  'die() { echo "DIE $*"; exit 3; }',
  '. "$1"',
  'pod_notary_credentials pod-notary',
  'pod_notary_preflight',
  'echo PASSED'
].join('\n')

function preflight(defaultKeychain: string, env: Record<string, string> = {}) {
  const asc = appStoreConnect(['KX7Q6Y844C'], ISSUER)
  const bin = join(asc, 'bin')
  mkdirSync(bin)
  for (const [name, body] of Object.entries(STUBS)) {
    writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 })
  }
  const xcrunArgs = join(asc, 'xcrun-args')
  const result = spawnSync('/bin/bash', ['-c', PREFLIGHT, 'preflight', script], {
    encoding: 'utf8',
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: '/fake/home',
      FAKE_HOME: '/fake/home',
      FAKE_DEFAULT: defaultKeychain,
      XCRUN_ARGS: xcrunArgs,
      POD_APPSTORECONNECT_DIR: asc,
      ...env
    }
  })
  return {
    asc,
    output: `${result.stdout}${result.stderr}`,
    xcrun: existsSync(xcrunArgs) ? readFileSync(xcrunArgs, 'utf8').trim() : null
  }
}

describe('notarization preflight', () => {
  const login = '/fake/home/Library/Keychains/login.keychain-db'

  it('passes with the login keychain and asks notarytool with exactly the chosen credentials', () => {
    const { asc, output, xcrun } = preflight(login)
    expect(output).toContain(`default keychain: ${login}`)
    expect(output).toContain('notarytool history OK')
    expect(output).toContain('PASSED')
    expect(xcrun).toBe(
      `notarytool history --key ${asc}/private_keys/AuthKey_KX7Q6Y844C.p8 --key-id KX7Q6Y844C --issuer ${ISSUER}`
    )
  })

  it('stops on another default keychain before calling notarytool, with diagnostics', () => {
    const { output, xcrun } = preflight('/tmp/scratch.keychain-db')
    expect(output).toContain(`DIE the default keychain is /tmp/scratch.keychain-db, not ${login}`)
    expect(output).toContain('list-keychains -d user:')
    expect(output).toContain('/Library/Keychains/System.keychain')
    expect(output).toMatch(/^ {4}HOME=\/fake\/home$/m)
    expect(output).not.toContain('PASSED')
    expect(xcrun).toBeNull()
  })

  it('stops when notarytool refuses the credentials, with its message and diagnostics', () => {
    const { output } = preflight(login, { XCRUN_FAIL: 'Error: No Keychain password item found' })
    expect(output).toContain('notarytool: Error: No Keychain password item found')
    expect(output).toContain('DIE notarytool history failed with the chosen credentials')
    expect(output).toContain('list-keychains -d user:')
    expect(output).not.toContain('PASSED')
  })
})
