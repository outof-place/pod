import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { getE2ECompletedOnboardingProfile } from './helpers/e2e-completed-onboarding-profile'

// A phone paired with Orca over the network: its registry entry, E2EE keypair and side files.
const PAIRING_FILES = {
  'orca-devices.json': JSON.stringify([
    {
      deviceId: 'e2e-phone',
      name: 'E2E phone',
      token: 'a'.repeat(48),
      scope: 'mobile',
      pairedAt: 1_791_000_000_000,
      lastSeenAt: 1_791_000_000_000,
      pairingReach: 'network'
    }
  ]),
  'orca-e2ee-keypair.json': JSON.stringify({ publicKey: 'cHVibGlj', secretKey: 'c2VjcmV0' }),
  'orca-relay-region-preference.json': JSON.stringify({ region: 'eu' }),
  'mobile-notification-dismissals.json': JSON.stringify({ dismissed: [] })
}

const pairedTest = test.extend<{ legacyProfile: string }>({
  // oxlint-disable-next-line no-empty-pattern -- Playwright fixture callbacks require object destructuring here.
  legacyProfile: async ({}, provideFixture) => {
    const dir = mkdtempSync(path.join('/tmp', 'pod-paired-'))
    writeFileSync(
      path.join(dir, 'orca-data.json'),
      `${JSON.stringify(getE2ECompletedOnboardingProfile(), null, 2)}\n`
    )
    for (const [name, text] of Object.entries(PAIRING_FILES)) {
      writeFileSync(path.join(dir, name), text)
    }
    await provideFixture(dir)
    rmSync(dir, { recursive: true, force: true })
  },
  orcaAppExtraEnv: async ({ legacyProfile }, provideFixture) => {
    await provideFixture({
      POD_E2E_PRODUCT_IDENTITY_PATH: path.join(process.cwd(), 'product/identity.json'),
      POD_E2E_LEGACY_USER_DATA_DIR: legacyProfile
    })
  }
})

// Why fresh: a seeded orca-data.json would read as an existing product profile and skip the import.
pairedTest.use({ dismissOnboarding: false })

function processTree(rootPid: number): number[] {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((row) => row.trim().split(/\s+/).map(Number))
  const pids = [rootPid]
  for (let index = 0; index < pids.length; index += 1) {
    for (const [pid, ppid] of rows) {
      if (ppid === pids[index] && !pids.includes(pid)) {
        pids.push(pid)
      }
    }
  }
  return pids
}

function tcpListenAddresses(pids: number[]): string[] {
  try {
    return execFileSync(
      'lsof',
      ['-nP', '-a', '-p', pids.join(','), '-iTCP', '-sTCP:LISTEN', '-Fn'],
      { encoding: 'utf8' }
    )
      .split('\n')
      .filter((line) => line.startsWith('n'))
      .map((line) => line.slice(1))
  } catch (error) {
    // Why: lsof exits 1 when nothing matches.
    if (error instanceof Error && 'status' in error && error.status === 1) {
      return []
    }
    throw error
  }
}

pairedTest(
  "the import leaves Orca's paired phones behind and nothing listens beyond loopback",
  async ({ electronApp, legacyProfile }) => {
    pairedTest.skip(process.platform !== 'darwin', 'lsof-based listener census is macOS-only here')
    const { pid, userData } = await electronApp.evaluate(({ app }) => ({
      pid: process.pid,
      userData: app.getPath('userData')
    }))
    const markerPath = path.join(userData, 'product-profile-migration.json')
    await expect.poll(() => existsSync(markerPath), { timeout: 60_000 }).toBe(true)
    expect(JSON.parse(readFileSync(markerPath, 'utf8'))).toMatchObject({ from: legacyProfile })
    for (const name of Object.keys(PAIRING_FILES)) {
      expect(existsSync(path.join(userData, name)), name).toBe(false)
      expect(existsSync(path.join(legacyProfile, name)), name).toBe(true)
    }

    const page = await electronApp.firstWindow({ timeout: 120_000 })
    await page.waitForFunction(() => Boolean(window.api?.mobile), null, { timeout: 30_000 })
    expect(await page.evaluate(() => window.api.mobile.listDevices())).toEqual({ devices: [] })
    expect(await page.evaluate(() => window.api.mobile.listRuntimeAccessGrants())).toEqual({
      grants: []
    })

    const metadataPath = path.join(userData, 'orca-runtime.json')
    const readTransports = (): { kind: string; endpoint?: string }[] | null => {
      if (!existsSync(metadataPath)) {
        return null
      }
      const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'))
      return metadata.pid === pid ? metadata.transports : null
    }
    await expect.poll(readTransports, { timeout: 30_000 }).not.toBeNull()
    const websocket = readTransports()?.find((transport) => transport.kind === 'websocket')
    // Why: E2E binds a kept runtime WebSocket on every interface whatever the profile holds; with
    // no network-paired device, a desktop launch binds it to loopback (resolveInitialWebSocketBindHost).
    const harnessPort = websocket?.endpoint ? `:${new URL(websocket.endpoint).port}` : null
    const wide = tcpListenAddresses(processTree(pid)).filter(
      (address) =>
        !address.startsWith('127.') &&
        !address.startsWith('[::1]:') &&
        !(harnessPort && address.endsWith(harnessPort))
    )
    expect(wide).toEqual([])
  }
)
