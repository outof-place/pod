import { X509Certificate } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect, createServer, type TLSSocket } from 'node:tls'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { createSandboxCa, createSandboxCas } from './pod-orbstack-sandbox-ca'

function handshake(
  ca: ReturnType<typeof createSandboxCa>,
  trust: string,
  servername: string
): Promise<string> {
  return new Promise((resolve) => {
    const server = createServer({ key: ca.leafKeyPem, cert: ca.leafCertPem }, (socket) =>
      socket.end()
    )
    server.listen(0, '127.0.0.1', () => {
      const address: AddressInfo | string | null = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      const client: TLSSocket = connect({ host: '127.0.0.1', port, servername, ca: trust }, () => {
        client.end()
        server.close()
        resolve('ok')
      })
      client.on('error', (error: NodeJS.ErrnoException) => {
        server.close()
        resolve(error.code ?? error.message)
      })
    })
  })
}

describe('createSandboxCa', () => {
  it('issues a CA limited to api.anthropic.com and one leaf for that name', () => {
    const ca = createSandboxCa('pod-web-1a2b3c4d-sbx')
    const root = new X509Certificate(ca.caCertPem)
    const leaf = new X509Certificate(ca.leafCertPem)
    expect(root.ca).toBe(true)
    expect(root.verify(root.publicKey)).toBe(true)
    expect(leaf.ca).toBe(false)
    expect(leaf.verify(root.publicKey)).toBe(true)
    expect(leaf.checkIssued(root)).toBe(true)
    expect(leaf.checkHost('api.anthropic.com')).toBe('api.anthropic.com')
    expect(leaf.checkHost('evil.example')).toBeUndefined()
    expect(leaf.subjectAltName).toBe('DNS:api.anthropic.com')
    expect(root.subject).toContain('pod-web-1a2b3c4d-sbx')
    expect(new Date(leaf.validTo).getTime()).toBeGreaterThan(Date.now())
  })

  it('makes a fresh CA per sandbox and drops it with the sandbox', () => {
    const cas = createSandboxCas()
    const first = cas.forMachine('pod-a-sbx')
    expect(cas.forMachine('pod-a-sbx')).toBe(first)
    expect(cas.forMachine('pod-b-sbx').caCertPem).not.toBe(first.caCertPem)
    cas.drop('pod-a-sbx')
    expect(cas.forMachine('pod-a-sbx').caCertPem).not.toBe(first.caCertPem)
  })

  it('passes a real TLS handshake only for api.anthropic.com under its own CA', async () => {
    const ca = createSandboxCa('pod-x-sbx')
    expect(await handshake(ca, ca.caCertPem, 'api.anthropic.com')).toBe('ok')
    expect(await handshake(ca, ca.caCertPem, 'example.com')).toBe('ERR_TLS_CERT_ALTNAME_INVALID')
    const other = createSandboxCa('pod-y-sbx')
    expect(await handshake(ca, other.caCertPem, 'api.anthropic.com')).not.toBe('ok')
  })

  it.skipIf(process.platform === 'win32')('is accepted by openssl verify', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-ca-'))
    try {
      const ca = createSandboxCa('pod-x-sbx')
      writeFileSync(join(dir, 'ca.pem'), ca.caCertPem)
      writeFileSync(join(dir, 'leaf.pem'), ca.leafCertPem)
      const out = execFileSync('openssl', [
        'verify',
        '-CAfile',
        join(dir, 'ca.pem'),
        join(dir, 'leaf.pem')
      ])
      expect(out.toString()).toContain('OK')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
