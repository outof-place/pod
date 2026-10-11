import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

  it('refuses an issuer file that holds no issuer id', () => {
    expect(resolve(appStoreConnect(['KX7Q6Y844C'], 'not-an-id'))).toMatch(
      /^DIE .*issuer is not an App Store Connect issuer id$/
    )
  })
})
