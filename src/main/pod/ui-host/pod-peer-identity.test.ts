import { existsSync, mkdtempSync } from 'node:fs'
import { createConnection, createServer, Socket, type Server } from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  loadPodPeerVerifier,
  podPeerIdentityAddonPath,
  POD_PEER_IDENTITY_BUILD_PATH,
  POD_UI_PEER_REQUIREMENT,
  socketDescriptor,
  type PodPeerCheck
} from './pod-peer-identity'

const addonPath = join(process.cwd(), POD_PEER_IDENTITY_BUILD_PATH)
const servers: Server[] = []
const clients: Socket[] = []

afterEach(() => {
  clients.splice(0).forEach((client) => client.destroy())
  servers.splice(0).forEach((server) => server.close())
})

/** Connects this process to itself and checks the accepted side with `requirement`. */
async function checkSelf(requirement: string): Promise<PodPeerCheck> {
  const verify = loadPodPeerVerifier(addonPath, requirement)
  if (!verify) {
    throw new Error('addon did not load')
  }
  const path = join(mkdtempSync('/tmp/pod-peer-'), 's.sock')
  return new Promise((resolve) => {
    const server = createServer((socket) => {
      resolve(verify(socket))
      socket.destroy()
    })
    servers.push(server)
    server.listen(path, () => clients.push(createConnection(path)))
  })
}

describe('pod peer identity', () => {
  it('finds the addon in the packaged resources or in the checkout', () => {
    expect(podPeerIdentityAddonPath({ resourcesPath: '/R', appPath: '/A', isPackaged: true })).toBe(
      '/R/native/pod-peer-identity.node'
    )
    expect(
      podPeerIdentityAddonPath({ resourcesPath: '/R', appPath: '/A', isPackaged: false })
    ).toBe(join('/A', POD_PEER_IDENTITY_BUILD_PATH))
  })

  it('gives no verifier without the addon, so the socket admits no one', () => {
    expect(loadPodPeerVerifier('/nonexistent/pod-peer-identity.node')).toBeNull()
  })

  it('has no descriptor for a socket that never connected', () => {
    expect(socketDescriptor(new Socket())).toBeNull()
  })

  describe.skipIf(process.platform !== 'darwin' || !existsSync(addonPath))('the addon', () => {
    it('names the connecting process from its audit token', async () => {
      // "always" admits any code: the check itself is what this exercises.
      expect(await checkSelf('always')).toEqual({ ok: true, pid: process.pid })
    })

    it('refuses a peer that is not PodNative signed by Pod', async () => {
      const result = await checkSelf(POD_UI_PEER_REQUIREMENT)
      expect(result.ok).toBe(false)
      expect(result.pid).toBe(process.pid)
      expect(result.error).toMatch(/requirement/)
    })

    it('refuses everyone for a requirement that does not parse', async () => {
      expect(await checkSelf('identifier (((')).toMatchObject({
        ok: false,
        error: 'invalid requirement'
      })
    })
  })
})
