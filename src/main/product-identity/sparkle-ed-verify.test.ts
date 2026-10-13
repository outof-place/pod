import { spawnSync } from 'node:child_process'
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const script = join(__dirname, '..', '..', '..', 'product', 'scripts', 'sparkle-ed-verify.swift')
const hasSwift = process.platform === 'darwin' && spawnSync('swift', ['--version']).status === 0

let root: string | null = null

afterEach(() => {
  if (root) {
    rmSync(root, { recursive: true, force: true })
    root = null
  }
})

function rawPublicKey(key: KeyObject): string {
  // SPKI DER of an Ed25519 key ends with the 32-byte raw key, which is what SUPublicEDKey holds.
  return key.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64')
}

function verify(...args: string[]): { status: number | null; out: string } {
  const result = spawnSync('swift', [script, ...args], { encoding: 'utf8' })
  return {
    status: result.status,
    out: `${result.stdout}${result.stderr}`.trim()
  }
}

// Signed with Node's Ed25519, not CryptoKit, so the check is not the signer grading itself.
describe.skipIf(!hasSwift)('sparkle-ed-verify.swift', () => {
  it('passes its own negative checks', () => {
    expect(verify('--self-test')).toEqual({
      status: 0,
      out: 'sparkle-ed-verify: self-test OK'
    })
  })

  it('accepts the signature over the whole archive and refuses everything else', () => {
    root = mkdtempSync(join(tmpdir(), 'pod-ed-verify-'))
    const archive = join(root, 'Pod-1.0.0.dmg')
    writeFileSync(archive, Buffer.from(Array.from({ length: 70_000 }, (_, i) => (i * 31) % 256)))
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const other = generateKeyPairSync('ed25519').publicKey
    const signature = sign(null, readFileSync(archive), privateKey)
    const sig = signature.toString('base64')

    expect(verify(archive, sig, rawPublicKey(publicKey)).status).toBe(0)
    expect(verify(archive, sig, rawPublicKey(other)).out).toContain(
      'does not verify against SUPublicEDKey'
    )
    expect(
      verify(archive, signature.subarray(0, 63).toString('base64'), rawPublicKey(publicKey)).out
    ).toContain('not 64 bytes')
    expect(verify(archive, sig, 'bm90IGEga2V5').out).toContain('not a 32-byte Ed25519 public key')
    appendFileSync(archive, Buffer.from([0]))
    expect(verify(archive, sig, rawPublicKey(publicKey)).status).toBe(1)
  })
})
