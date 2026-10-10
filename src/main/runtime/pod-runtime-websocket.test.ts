import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { podFeatureFlags } from '../../shared/product/features'
import { DEVICE_REGISTRY_FILENAME } from './mobile-pairing-files'
import { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'

async function loadPolicy(profile: 'pod' | 'orca') {
  vi.resetModules()
  if (profile === 'pod') {
    vi.stubGlobal('__POD_FEATURES__', podFeatureFlags('pod'))
  }
  return import('./pod-runtime-websocket')
}

// Why: the state an imported Orca profile brings along — a phone paired over the network and seen
// since, which makes the desktop runtime bind its WebSocket listener on every interface at startup.
function userDataWithNetworkPairedPhone(): string {
  const userDataPath = mkdtempSync(join(tmpdir(), 'pod-runtime-ws-'))
  const pairedAt = Date.now() - 60_000
  writeFileSync(
    join(userDataPath, DEVICE_REGISTRY_FILENAME),
    JSON.stringify([
      {
        deviceId: 'phone-1',
        name: 'Mobile 9/24/2026',
        token: 'test-token',
        scope: 'mobile',
        pairedAt,
        lastSeenAt: pairedAt + 1_000,
        pairingReach: 'network'
      }
    ])
  )
  return userDataPath
}

function advertisedTransports(userDataPath: string): unknown {
  const metadata = JSON.parse(readFileSync(join(userDataPath, 'orca-runtime.json'), 'utf8'))
  return metadata.transports.map((transport: { kind: string }) => transport.kind)
}

async function startDesktopRuntime(enableWebSocket: boolean, userDataPath: string) {
  const server = new OrcaRuntimeRpcServer({
    runtime: new OrcaRuntimeService(),
    userDataPath,
    enableWebSocket,
    wsPort: 0
  })
  await server.start()
  return server
}

describe('Pod runtime WebSocket policy', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps the desktop runtime off the network in the Pod profile', async () => {
    const { runtimeWebSocketEnabled } = await loadPolicy('pod')
    expect(runtimeWebSocketEnabled({ serveMode: false })).toBe(false)
    expect(runtimeWebSocketEnabled({ serveMode: true })).toBe(true)

    const userDataPath = userDataWithNetworkPairedPhone()
    const server = await startDesktopRuntime(
      runtimeWebSocketEnabled({ serveMode: false }),
      userDataPath
    )
    try {
      expect(server.getWebSocketEndpoint()).toBeNull()
      expect(advertisedTransports(userDataPath)).toEqual(['unix'])
    } finally {
      await server.stop()
    }
  })

  it('keeps the upstream listener when the profile is not substituted', async () => {
    const { runtimeWebSocketEnabled } = await loadPolicy('orca')
    expect(runtimeWebSocketEnabled({ serveMode: false })).toBe(true)

    // Why the control: proves the paired-phone fixture is what widens the bind upstream.
    const userDataPath = userDataWithNetworkPairedPhone()
    const server = await startDesktopRuntime(
      runtimeWebSocketEnabled({ serveMode: false }),
      userDataPath
    )
    try {
      expect(server.getWebSocketEndpoint()).toMatch(/^ws:\/\/0\.0\.0\.0:\d+$/)
    } finally {
      await server.stop()
    }
  })
})
