/**
 * Pod bundles claude-acc's plugin: with a Pod identity (bundledPlugins + claudeAcc), a fresh profile
 * gets the plugin system on, the bundled outof-place.pod-acc plugin installed and approved without a
 * review dialog, and its status bar items filled from claude-acc's state files in HOME. A harness
 * launch skips the payload lifecycle, and dry-run backs that up, so no setup.sh ever runs here.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from './helpers/orca-app'

const IDENTITY_DIR = mkdtempSync(join(tmpdir(), 'pod-identity-e2e-'))
const IDENTITY = join(IDENTITY_DIR, 'product-identity.json')
writeFileSync(
  IDENTITY,
  JSON.stringify({
    formatVersion: 1,
    bundledPlugins: { publishers: ['outof-place'], idPrefix: 'pod-', enablePluginSystem: true },
    claudeAcc: { payload: 'claude-acc', pluginKey: 'outof-place.pod-acc' }
  })
)

test.use({
  orcaAppExtraEnv: {
    ORCA_BACKGROUND_LAUNCH: '1',
    POD_DISTRO_IDENTITY_PATH: IDENTITY,
    POD_ACC_LIFECYCLE: 'dry-run'
  }
})

const GB = 1024 ** 3

function seedState(home: string): void {
  const now = Date.now() / 1000
  const dir = join(home, '.local/share/claude-acc')
  mkdirSync(join(dir, 'sched'), { recursive: true })
  const write = (name: string, data: unknown): void =>
    writeFileSync(join(dir, name), JSON.stringify(data))
  write('status.json', {
    generated_at: now,
    active_email: 'dev@example.com',
    forecast: { session: { switch_at: now + 1500 } },
    pause: null,
    accounts: [
      {
        email: 'dev@example.com',
        tier: 'Max 20x',
        active: true,
        status: 'ok',
        usable: true,
        session: { used: 71, resets_at: now + 5400 },
        weekly: { used: 84, resets_at: now + 2 * 86400 }
      }
    ]
  })
  write('devguard-state.json', {
    snapshot: {
      at: now,
      budget: 12 * GB,
      total: 2 * GB,
      pressure: {
        level: 2,
        stage: 2,
        stage_reasons: ['swap 9.1 GB and growing'],
        swap_used: 9 * GB
      },
      units: [],
      plans: []
    }
  })
  write('sched/state.json', { memory: { free_for_admission_gb: 4 }, running: [], queue: [] })
}

test('Pod shows claude-acc in the status bar from its bundled plugin', async ({
  orcaPage,
  electronApp
}) => {
  test.setTimeout(120_000)
  const home = await electronApp.evaluate(({ app }) => app.getPath('home'))
  seedState(home)

  const plugin = await orcaPage.evaluate(async () => {
    for (let i = 0; i < 100; i++) {
      const entry = (await window.api.plugins.list()).find(
        (p) => p.pluginKey === 'outof-place.pod-acc'
      )
      if (entry?.status === 'running' || entry?.status === 'idle') {
        return entry
      }
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    return (
      (await window.api.plugins.list()).find((p) => p.pluginKey === 'outof-place.pod-acc') ?? null
    )
  })
  expect(plugin?.status, JSON.stringify(plugin)).toMatch(/running|idle/)
  const settings = await orcaPage.evaluate(() => window.api.settings.get())
  expect(settings.pluginSystemEnabled).toBe(true)

  const account = orcaPage.locator('[data-plugin-status-item="outof-place.pod-acc/account"]')
  await expect(account).toContainText(/Claude 84% · switch 2[45]m/, { timeout: 30_000 })
  const memory = orcaPage.locator('[data-plugin-status-item="outof-place.pod-acc/memory"]')
  await expect(memory).toContainText('Memory brake')
  await expect(memory).toHaveAttribute('data-severity', 'error')
  await orcaPage
    .locator('[data-plugin-status-item="outof-place.pod-acc/account"]')
    .locator('xpath=..')
    .screenshot({
      path: test.info().outputPath('pod-acc-status-bar.png')
    })
})
