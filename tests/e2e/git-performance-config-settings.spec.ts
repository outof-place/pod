/**
 * Settings > Git > Git Performance Tuning: choosing Recommended offers to tune
 * existing repositories, Apply writes the repo-local config Orca records, and
 * Off removes exactly that config again. Assertions read the repository's real
 * `.git/config` and the rendered row, not the store.
 */
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import type { Page, TestInfo } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { getStoreState, waitForSessionReady } from './helpers/store'
import type { Repo } from '../../src/shared/repo-types'

function localConfig(repoPath: string, key: string): string | null {
  try {
    return execFileSync('git', ['config', '--local', '--get-all', key], {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    return null
  }
}

async function openGitTuningSettings(page: Page): Promise<void> {
  // Why: the host OS locale drives Orca's default UI language; pin English for stable locators.
  await page.evaluate(() => window.__store!.getState().updateSettings({ uiLanguage: 'en' }))
  await page.evaluate(() => {
    const state = window.__store!.getState()
    state.openSettingsTarget({ pane: 'git', repoId: null, sectionId: 'git-performance-config' })
    state.openSettingsPage()
  })
  await expect(page.getByPlaceholder('Search settings')).toBeVisible({ timeout: 10_000 })
  const maybeLater = page.getByRole('button', { name: 'Maybe Later' })
  if (await maybeLater.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await maybeLater.click()
  }
}

async function attachScreenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const screenshotPath = testInfo.outputPath(`${name}.png`)
  await page.locator('#git-performance-config').screenshot({ path: screenshotPath })
  await testInfo.attach(name, { path: screenshotPath, contentType: 'image/png' })
}

test.describe('Git performance tuning setting', () => {
  test('applies the recommended config to an existing repository and reverts it on Off', async ({
    orcaPage,
    testRepoPath
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    const repoPath = realpathSync(testRepoPath)
    const repos = await getStoreState<Repo[]>(orcaPage, 'repos')
    const repo = repos.find((entry) => realpathSync(entry.path) === repoPath)
    expect(repo, 'the seeded repository is registered').toBeDefined()
    expect(localConfig(repoPath, 'orca.performanceConfig')).toBeNull()

    await openGitTuningSettings(orcaPage)
    const section = orcaPage.locator('#git-performance-config')
    await expect(section.getByText('Git Performance Tuning').first()).toBeVisible()
    const row = section.locator(
      `[data-testid="git-performance-config-repo"][data-repo-id="${repo!.id}"]`
    )
    await expect(row).toContainText('No options set by Orca', { timeout: 15_000 })
    await attachScreenshot(orcaPage, testInfo, 'git-tuning-off')

    // Choosing Recommended must not touch existing repositories by itself.
    await section.getByRole('radio', { name: 'Recommended' }).click()
    await expect(
      section.getByRole('button', { name: 'Apply to existing repositories' })
    ).toBeEnabled({
      timeout: 15_000
    })
    expect(localConfig(repoPath, 'fetch.writeCommitGraph')).toBeNull()

    await section.getByRole('button', { name: 'Apply to existing repositories' }).click()
    await expect(row).toContainText('fetch.writeCommitGraph=true', { timeout: 15_000 })
    expect(localConfig(repoPath, 'fetch.writeCommitGraph')).toBe('true')
    expect(localConfig(repoPath, 'orca.performanceConfig')?.split('\n')).toContain(
      'fetch.writeCommitGraph=true'
    )
    await attachScreenshot(orcaPage, testInfo, 'git-tuning-applied')

    await section.getByRole('radio', { name: 'Off' }).click()
    await expect(row).toContainText('No options set by Orca', { timeout: 15_000 })
    await expect.poll(() => localConfig(repoPath, 'fetch.writeCommitGraph')).toBeNull()
    expect(localConfig(repoPath, 'orca.performanceConfig')).toBeNull()
    expect(localConfig(repoPath, 'core.untrackedCache')).toBeNull()
    expect(localConfig(repoPath, 'core.fsmonitor')).toBeNull()
  })
})
