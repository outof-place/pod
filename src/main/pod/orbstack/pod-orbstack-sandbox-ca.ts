// Fork-only (Pod): a per-sandbox certificate authority, in memory only. It signs one leaf for
// api.anthropic.com and is then thrown away, so its private key exists for one function call.
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto'

export const ANTHROPIC_API_HOST = 'api.anthropic.com'
const VALIDITY_MS = 30 * 24 * 60 * 60_000

// Minimal DER: just the shapes an X.509 v3 certificate needs.
function length(size: number): Buffer {
  if (size < 0x80) {
    return Buffer.from([size])
  }
  const bytes: number[] = []
  for (let rest = size; rest > 0; rest = Math.floor(rest / 256)) {
    bytes.unshift(rest % 256)
  }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

function tlv(tag: number, ...content: Buffer[]): Buffer {
  const body = Buffer.concat(content)
  return Buffer.concat([Buffer.from([tag]), length(body.length), body])
}

const seq = (...content: Buffer[]) => tlv(0x30, ...content)

function oid(dotted: string): Buffer {
  const [first = 0, second = 0, ...rest] = dotted.split('.').map(Number)
  const bytes = [first * 40 + second]
  for (const arc of rest) {
    const chunk = [arc & 0x7f]
    for (let value = arc >> 7; value > 0; value >>= 7) {
      chunk.unshift(0x80 | (value & 0x7f))
    }
    bytes.push(...chunk)
  }
  return tlv(0x06, Buffer.from(bytes))
}

function integer(bytes: Buffer): Buffer {
  return tlv(0x02, (bytes[0] ?? 0) & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes)
}

function utcTime(date: Date): Buffer {
  const pad = (value: number) => String(value).padStart(2, '0')
  const text = `${pad(date.getUTCFullYear() % 100)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  return tlv(0x17, Buffer.from(text))
}

const bitString = (bytes: Buffer, unusedBits = 0) => tlv(0x03, Buffer.from([unusedBits]), bytes)
const name = (commonName: string) =>
  seq(tlv(0x31, seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from(commonName)))))

function extension(id: string, critical: boolean, value: Buffer): Buffer {
  return seq(oid(id), ...(critical ? [tlv(0x01, Buffer.from([0xff]))] : []), tlv(0x04, value))
}

const ECDSA_SHA256 = seq(oid('1.2.840.10045.4.3.2'))
const dnsName = (host: string) => tlv(0x82, Buffer.from(host))

function keyId(publicKey: KeyObject): Buffer {
  return createHash('sha1')
    .update(publicKey.export({ type: 'spki', format: 'der' }))
    .digest()
}

function certificate(args: {
  subject: string
  issuer: string
  publicKey: KeyObject
  signingKey: KeyObject
  extensions: Buffer[]
  now: Date
}): string {
  const tbs = seq(
    tlv(0xa0, integer(Buffer.from([2]))),
    integer(randomBytes(16)),
    ECDSA_SHA256,
    name(args.issuer),
    seq(
      utcTime(new Date(args.now.getTime() - 60 * 60_000)),
      utcTime(new Date(args.now.getTime() + VALIDITY_MS))
    ),
    name(args.subject),
    args.publicKey.export({ type: 'spki', format: 'der' }),
    tlv(0xa3, seq(...args.extensions))
  )
  const der = seq(tbs, ECDSA_SHA256, bitString(sign('sha256', tbs, args.signingKey)))
  const body = der.toString('base64').match(/.{1,64}/g) ?? []
  return `-----BEGIN CERTIFICATE-----\n${body.join('\n')}\n-----END CERTIFICATE-----\n`
}

export type SandboxCa = {
  /** Trusted inside the sandbox only, via NODE_EXTRA_CA_CERTS. */
  caCertPem: string
  /** What the Mac side of the relay presents for api.anthropic.com. */
  leafCertPem: string
  leafKeyPem: string
}

/**
 * The CA may sign only api.anthropic.com (critical name constraint) and signs exactly one leaf
 * for it; its private key goes out of scope when this returns.
 */
export function createSandboxCa(machine: string, now: Date = new Date()): SandboxCa {
  const ca = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const leaf = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const caId = keyId(ca.publicKey)
  const caName = `Pod sandbox CA (${machine})`.slice(0, 64)
  const caCertPem = certificate({
    subject: caName,
    issuer: caName,
    publicKey: ca.publicKey,
    signingKey: ca.privateKey,
    now,
    extensions: [
      extension('2.5.29.19', true, seq(tlv(0x01, Buffer.from([0xff])), integer(Buffer.from([0])))),
      // keyCertSign + cRLSign
      extension('2.5.29.15', true, bitString(Buffer.from([0x06]), 1)),
      extension('2.5.29.30', true, seq(tlv(0xa0, seq(dnsName(ANTHROPIC_API_HOST))))),
      extension('2.5.29.14', false, tlv(0x04, caId))
    ]
  })
  const leafCertPem = certificate({
    subject: ANTHROPIC_API_HOST,
    issuer: caName,
    publicKey: leaf.publicKey,
    signingKey: ca.privateKey,
    now,
    extensions: [
      extension('2.5.29.19', true, seq()),
      // digitalSignature
      extension('2.5.29.15', true, bitString(Buffer.from([0x80]), 7)),
      extension('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1'))),
      extension('2.5.29.17', false, seq(dnsName(ANTHROPIC_API_HOST))),
      extension('2.5.29.35', false, seq(tlv(0x80, caId))),
      extension('2.5.29.14', false, tlv(0x04, keyId(leaf.publicKey)))
    ]
  })
  return {
    caCertPem,
    leafCertPem,
    leafKeyPem: leaf.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  }
}

/** One CA per sandbox for this Pod run; deleting the sandbox drops it. */
export function createSandboxCas(create: typeof createSandboxCa = createSandboxCa) {
  const byMachine = new Map<string, SandboxCa>()
  return {
    forMachine(machine: string): SandboxCa {
      const live = byMachine.get(machine)
      if (live) {
        return live
      }
      const ca = create(machine)
      byMachine.set(machine, ca)
      return ca
    },
    drop(machine: string): void {
      byMachine.delete(machine)
    }
  }
}

export type SandboxCas = ReturnType<typeof createSandboxCas>
