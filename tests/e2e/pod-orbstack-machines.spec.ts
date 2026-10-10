import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { runProcess } from '../../src/shared/child-process/run-process'
import { podOrbstackMachineName } from '../../src/main/pod/orbstack/pod-orbstack-recipe'
import { expect, test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import {
  execInTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'

// Real OrbStack: creates one throwaway pod- machine from Settings › OrbStack, opens a terminal in
// it, then deletes it. Opt-in (POD_E2E_ORBSTACK=1) because it boots a Linux machine.
// POD_E2E_SCREENSHOT_DIR, when set, receives CDP screenshots of the section.
const ORB = '/Applications/OrbStack.app/Contents/MacOS/bin/orb'
// Why realpath: OrbStack shares /private, not the /var link that os.tmpdir() returns.
const baseDir = path.join(realpathSync(os.tmpdir()), `pod-orbstack-e2e-${process.pid}`)
const repoPath = path.join(baseDir, 'orbstack-e2e')
const screenshotDir = process.env.POD_E2E_SCREENSHOT_DIR
const createdMachines = new Set<string>()

test.skip(
  process.platform !== 'darwin' || process.env.POD_E2E_ORBSTACK !== '1',
  'boots a real OrbStack machine; set POD_E2E_ORBSTACK=1 on a Mac with OrbStack'
)
test.use({
  // The isolated E2E HOME is too long for orb's socket path; OrbStack lives under the real one.
  orcaAppExtraEnv: {
    ORCA_POD_ORBSTACK: '1',
    POD_ACC_LIFECYCLE: 'off',
    POD_E2E_ORBSTACK_HOME: os.homedir()
  },
  minimumSeededWorktreeCount: 1
})
test.setTimeout(6 * 60_000)

async function run(program: string, args: string[], cwd?: string): Promise<string> {
  const result = await runProcess({ program, args, cwd, timeoutMs: 120_000 })
  if (result.code !== 0) {
    throw new Error(`${program} ${args.join(' ')} failed: ${result.stderr}`)
  }
  return result.stdout
}

async function listMachines(): Promise<string[]> {
  return (await run(ORB, ['list', '--quiet'])).split('\n').filter(Boolean)
}

async function screenshot(page: Page, name: string): Promise<void> {
  if (!screenshotDir) {
    return
  }
  mkdirSync(screenshotDir, { recursive: true })
  await page.locator('#pod-orbstack').screenshot({ path: path.join(screenshotDir, name) })
}

test.beforeAll(async () => {
  rmSync(baseDir, { recursive: true, force: true })
  mkdirSync(repoPath, { recursive: true })
  await run('git', ['init', '-q'], repoPath)
  writeFileSync(path.join(repoPath, 'README.md'), '# orbstack e2e\n')
  await run('git', ['add', 'README.md'], repoPath)
  await run(
    'git',
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
})

test.afterAll(async () => {
  // Only machines this spec created, and only if a failed run left them behind.
  const remaining = await listMachines().catch((): string[] => [])
  for (const name of createdMachines) {
    if (name.startsWith('pod-') && remaining.includes(name)) {
      await run(ORB, ['delete', '--force', name]).catch(() => undefined)
    }
  }
  rmSync(baseDir, { recursive: true, force: true })
})

test('Settings › OrbStack creates a worktree machine, opens a terminal in it, and deletes it', async ({
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)
  const repoId = await orcaPage.evaluate(async (repoPath) => {
    const added = await window.api.repos.add({ path: repoPath })
    if ('error' in added) {
      throw new Error(added.error)
    }
    const state = window.__store?.getState()
    await state?.fetchRepos()
    await state?.fetchWorktrees(added.repo.id)
    return added.repo.id
  }, repoPath)
  const worktreeId = `${repoId}::${repoPath}`
  const machine = podOrbstackMachineName(worktreeId, repoPath)
  createdMachines.add(machine)
  expect(await listMachines()).not.toContain(machine)

  await orcaPage.evaluate(() => window.__store?.getState().openSettingsPage())
  await orcaPage.getByRole('button', { name: 'OrbStack', exact: true }).click()
  const section = orcaPage.locator('#pod-orbstack')
  await expect(section.getByTestId('pod-orbstack-summary')).toContainText('OrbStack: Running', {
    timeout: 30_000
  })
  const row = section.locator(
    `[data-testid="pod-orbstack-worktree-row"][data-worktree-path="${repoPath}"]`
  )
  await row.getByRole('button', { name: 'Create machine' }).click()
  await expect(row.getByText(machine, { exact: true })).toBeVisible({ timeout: 5 * 60_000 })
  expect(await listMachines()).toContain(machine)
  const machineRow = section.locator(
    `[data-testid="pod-orbstack-machine-row"][data-machine="${machine}"]`
  )
  await expect(machineRow).toContainText('Pod')
  await expect(machineRow).toContainText('running')
  await screenshot(orcaPage, 'pod-orbstack-machine.png')

  // A new terminal in the worktree is `orb -m <machine>` in the same folder.
  await orcaPage.evaluate((worktreeId) => {
    const state = window.__store?.getState()
    state?.closeSettingsPage?.()
    state?.setActiveWorktree(worktreeId)
    const tab = window.__store
      ?.getState()
      .createTab(worktreeId, undefined, undefined, { activate: false })
    if (tab) {
      window.__store?.getState().activateTab(tab.id)
    }
  }, worktreeId)
  await waitForActiveTerminalManager(orcaPage)
  const ptyId = await waitForActivePanePtyId(orcaPage, 60_000)
  // Why: input typed before the machine's login shell starts is dropped, so wait for its prompt.
  await waitForTerminalOutput(orcaPage, `@${machine}`, 90_000)
  await execInTerminal(orcaPage, ptyId, 'echo "POD_E2E $(uname -s) $(hostname) $(pwd)"')
  await waitForTerminalOutput(orcaPage, `POD_E2E Linux ${machine} ${repoPath}`, 60_000)

  await orcaPage.evaluate(() => window.__store?.getState().openSettingsPage())
  await orcaPage.getByRole('button', { name: 'OrbStack', exact: true }).click()
  await row.getByRole('button', { name: 'Delete machine' }).click()
  await expect(row.getByRole('button', { name: 'Create machine' })).toBeVisible({
    timeout: 120_000
  })
  expect(await listMachines()).not.toContain(machine)
})
