import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'
import { PROTOCOL_VERSION } from '../../src/main/daemon/types'
import { probeDaemonSocket } from '../../src/main/daemon/daemon-launch-paths'
import { expect, test } from './helpers/orca-app'
import { getE2ECompletedOnboardingProfile } from './helpers/e2e-completed-onboarding-profile'

// Orca 1.4.223's protocol: older than this build's, so the product could reach it as a legacy daemon.
const LEGACY_PROTOCOL = 41

type LegacyProfile = { dir: string; connections(): number }

const podTest = test.extend<{ legacyProfile: LegacyProfile }>({
  // oxlint-disable-next-line no-empty-pattern -- Playwright fixture callbacks require object destructuring here.
  legacyProfile: async ({}, provideFixture) => {
    // Short base: Unix socket paths are capped at 104 bytes on macOS.
    const dir = mkdtempSync(path.join('/tmp', 'pod-legacy-'))
    writeFileSync(
      path.join(dir, 'orca-data.json'),
      `${JSON.stringify(getE2ECompletedOnboardingProfile(), null, 2)}\n`
    )
    mkdirSync(path.join(dir, 'daemon'))
    // A live legacy daemon: this process answers on its socket and owns its pid record.
    let connections = 0
    const server = createServer((socket) => {
      connections++
      socket.destroy()
    })
    await new Promise<void>((resolve) =>
      server.listen(path.join(dir, `daemon/daemon-v${LEGACY_PROTOCOL}.sock`), resolve)
    )
    writeFileSync(path.join(dir, `daemon/daemon-v${LEGACY_PROTOCOL}.token`), 'legacy-token')
    writeFileSync(
      path.join(dir, `daemon/daemon-v${LEGACY_PROTOCOL}.pid`),
      JSON.stringify({ pid: process.pid })
    )
    await provideFixture({ dir, connections: () => connections })
    await new Promise((resolve) => server.close(resolve))
    rmSync(dir, { recursive: true, force: true })
  },
  // Why fresh: a seeded orca-data.json would read as an existing product profile and skip the import.
  dismissOnboarding: [false, { option: true }],
  orcaAppExtraEnv: async ({ legacyProfile }, provideFixture) => {
    await provideFixture({
      POD_E2E_PRODUCT_IDENTITY_PATH: path.join(process.cwd(), 'product/identity.json'),
      POD_E2E_LEGACY_USER_DATA_DIR: legacyProfile.dir
    })
  }
})

podTest(
  'the first-run import leaves a running legacy daemon alone and starts its own',
  async ({ electronApp, legacyProfile }) => {
    const userData = await electronApp.evaluate(({ app }) => app.getPath('userData'))
    const ownSocket = path.join(userData, `daemon/daemon-v${PROTOCOL_VERSION}.sock`)

    await expect
      .poll(() => existsSync(path.join(userData, 'product-profile-migration.json')), {
        timeout: 60_000
      })
      .toBe(true)
    const marker = JSON.parse(
      readFileSync(path.join(userData, 'product-profile-migration.json'), 'utf8')
    )
    expect(marker).toMatchObject({ from: legacyProfile.dir, adoptableDaemons: [LEGACY_PROTOCOL] })
    // Headless runs never answer the handover question, so nothing moved.
    expect(marker.daemonHandover).toBeUndefined()

    await expect.poll(() => probeDaemonSocket(ownSocket), { timeout: 90_000 }).toBe(true)
    expect(
      readdirSync(path.join(userData, 'daemon')).filter((name) =>
        name.includes(`-v${LEGACY_PROTOCOL}.`)
      )
    ).toEqual([])
    expect(readdirSync(path.join(legacyProfile.dir, 'daemon')).sort()).toEqual([
      `daemon-v${LEGACY_PROTOCOL}.pid`,
      `daemon-v${LEGACY_PROTOCOL}.sock`,
      `daemon-v${LEGACY_PROTOCOL}.token`
    ])
    expect(legacyProfile.connections()).toBe(0)
  }
)
