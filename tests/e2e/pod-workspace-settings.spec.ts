import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { runProcess } from '@orca/process-host'
import { expect, test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

// Pod's workspace root (macOS only), against a temp root with one repo and stubbed system tools.
// POD_E2E_SCREENSHOT_DIR, when set, receives CDP screenshots of the rendered section.
const baseDir = path.join(os.tmpdir(), `pod-workspace-e2e-${process.pid}`)
const toolDir = path.join(baseDir, 'tools')
const root = path.join(baseDir, 'root')
const repoPath = path.join(root, 'acme', 'widget')
const screenshotDir = process.env.POD_E2E_SCREENSHOT_DIR

test.skip(process.platform !== 'darwin', 'the Pod workspace root is macOS only')
test.use({
  orcaAppExtraEnv: { ORCA_POD_WORKSPACE: '1', POD_E2E_WORKSPACE_TOOL_DIR: toolDir },
  minimumSeededWorktreeCount: 1
})

// tmutil keeps exclusions in a file so the spec can watch "Exclude build folders" work.
const STUB_TOOLS: Record<string, string> = {
  tmutil: `#!/bin/sh
state="$(dirname "$0")/excluded.txt"
verb="$1"; shift
case "$verb" in
  isexcluded)
    for p in "$@"; do
      if grep -qxF "$p" "$state" 2>/dev/null; then printf '[Excluded]  %s\\n' "$p"; else printf '[Included]  %s\\n' "$p"; fi
    done ;;
  addexclusion) for p in "$@"; do printf '%s\\n' "$p" >> "$state"; done ;;
  destinationinfo) echo 'tmutil: No destinations configured.' >&2 ;;
esac
`,
  mdutil: `#!/bin/sh
printf '/:\\n\\tIndexing enabled.\\n'
`,
  mdfind: `#!/bin/sh
exit 0
`,
  pnpm: `#!/bin/sh
echo undefined
`
}

async function git(args: string[], cwd: string): Promise<void> {
  const result = await runProcess({ program: 'git', args, cwd, timeoutMs: 30_000 })
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  }
}

test.beforeAll(async () => {
  rmSync(baseDir, { recursive: true, force: true })
  mkdirSync(toolDir, { recursive: true })
  for (const [name, script] of Object.entries(STUB_TOOLS)) {
    writeFileSync(path.join(toolDir, name), script)
    chmodSync(path.join(toolDir, name), 0o755)
  }
  mkdirSync(repoPath, { recursive: true })
  await git(['init', '-q'], repoPath)
  writeFileSync(path.join(repoPath, 'README.md'), '# widget\n')
  await git(['add', 'README.md'], repoPath)
  await git(
    [
      '-c',
      'user.name=Pod E2E',
      '-c',
      'user.email=e2e@example.invalid',
      'commit',
      '-q',
      '-m',
      'init'
    ],
    repoPath
  )
  await git(['config', 'core.untrackedCache', 'true'], repoPath)
  mkdirSync(path.join(repoPath, 'node_modules'))
})

test.afterAll(() => {
  rmSync(baseDir, { recursive: true, force: true })
})

async function screenshot(page: Page, name: string, target = '#pod-workspace'): Promise<void> {
  if (!screenshotDir) {
    return
  }
  mkdirSync(screenshotDir, { recursive: true })
  await page.locator(target).screenshot({ path: path.join(screenshotDir, name) })
}

test('Settings › Workspace renders the root, checks and repository rows', async ({ orcaPage }) => {
  await waitForSessionReady(orcaPage)
  await orcaPage.evaluate(
    async ({ root, repoPath }) => {
      await window.__store?.getState().updateSettingsOrThrow({ podWorkspaceRoot: root })
      const added = await window.api.repos.add({ path: repoPath })
      if ('error' in added) {
        throw new Error(added.error)
      }
      await window.__store?.getState().fetchRepos()
      window.__store?.getState().openSettingsPage()
    },
    { root, repoPath }
  )
  await expect(orcaPage.getByPlaceholder('Search settings')).toBeVisible({ timeout: 10_000 })
  await orcaPage.getByRole('button', { name: 'Workspace', exact: true }).click()

  const section = orcaPage.locator('#pod-workspace')
  await expect(section.getByLabel('Workspace root')).toHaveValue(root)
  const health = section.getByTestId('pod-workspace-health')
  await expect(health).toBeVisible({ timeout: 30_000 })
  await expect(health.getByText('Same volume as the pnpm store')).toBeVisible()
  await expect(health.getByText('Letter case')).toBeVisible()
  await expect(health.getByText('Free space')).toBeVisible()
  await expect(health.getByText('Spotlight', { exact: true })).toBeVisible()
  await expect(health.getByText(/Backups are not configured/)).toBeVisible()
  await expect(health.getByText('0 of 1 build folders excluded')).toBeVisible()
  await expect(health.getByText('Not connected', { exact: true })).toBeVisible()

  const row = section.getByTestId('pod-workspace-repo-row')
  await expect(row).toHaveCount(1)
  await expect(row).toContainText('acme/widget')
  await expect(row).toContainText('core.untrackedCache=true')
  await expect(row).toContainText('Worktrees: 1')
  // The fixture's seeded repo lives outside the temp root.
  await expect(section.getByTestId('pod-workspace-outside-list')).toBeVisible()
  await screenshot(orcaPage, 'pod-workspace-settings.png')
  await screenshot(
    orcaPage,
    'pod-workspace-repo-rows.png',
    '[data-testid="pod-workspace-repo-row"]'
  )
  await screenshot(
    orcaPage,
    'pod-workspace-outside.png',
    '[data-testid="pod-workspace-outside-list"]'
  )

  await section.getByRole('button', { name: 'Exclude build folders' }).click()
  await expect(health.getByText('1 of 1 build folders excluded')).toBeVisible({ timeout: 15_000 })
  await expect(section.getByRole('button', { name: 'Exclude build folders' })).toHaveCount(0)
  await screenshot(orcaPage, 'pod-workspace-settings-excluded.png')
})

test('the root field refuses iCloud Drive and keeps the saved root', async ({ orcaPage }) => {
  await waitForSessionReady(orcaPage)
  await orcaPage.evaluate(async (root) => {
    await window.__store?.getState().updateSettingsOrThrow({ podWorkspaceRoot: root })
    window.__store?.getState().openSettingsPage()
  }, root)
  await orcaPage.getByRole('button', { name: 'Workspace', exact: true }).click()
  const input = orcaPage.locator('#pod-workspace').getByLabel('Workspace root')
  await input.fill('~/Library/Mobile Documents/com~apple~CloudDocs/pod')
  await input.press('Enter')
  await expect(orcaPage.locator('#pod-workspace').getByRole('alert')).toContainText('iCloud Drive')
  await expect
    .poll(() => orcaPage.evaluate(() => window.api.settings.get().then((s) => s.podWorkspaceRoot)))
    .toBe(root)
  await screenshot(orcaPage, 'pod-workspace-root-refused.png')
})
