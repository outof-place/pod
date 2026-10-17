import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

// Fork-only (Pod): a local shell that fails keeps its pane in session tabs, with its exit, and
// session.tabs.restartTerminal starts a new shell in it through the window that owns the pane.
type TerminalTab = {
  type: string
  id: string
  parentTabId: string
  leafId: string
  status?: string
  terminal?: string | null
  terminalExit?: { exitCode: number; exitedAt: number }
}

async function call(page: Page, method: string, params: unknown): Promise<unknown> {
  return await page.evaluate(
    async ({ method, params }) => {
      const response = await window.api.runtime.call({ method, params })
      if (!response.ok) {
        throw new Error(`${method}: ${response.error.message}`)
      }
      return response.result
    },
    { method, params }
  )
}

async function terminalTabs(page: Page, worktreeId: string): Promise<TerminalTab[]> {
  const result = await call(page, 'session.tabs.list', { worktree: `id:${worktreeId}` })
  const tabs: unknown =
    result && typeof result === 'object' && 'tabs' in result ? result.tabs : undefined
  return Array.isArray(tabs)
    ? tabs.filter((tab): tab is TerminalTab => tab?.type === 'terminal')
    : []
}

// Why: behind macOS's /usr/bin/login wrapper (TCC attribution) the host never learns a shell's
// exit code, so a pane keeps its exit only when the shell runs directly.
test.use({ orcaAppExtraEnv: { ORCA_DISABLE_MACOS_LOGIN_SHELL: '1' } })

test('a failed shell keeps its pane and restarts as a shell through the window', async ({
  orcaPage
}) => {
  test.skip(process.platform === 'win32', 'Pod ships for macOS')
  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)
  // Why the sleep: a shell that fails while it is live, after session tabs have listed its pane.
  const created = await call(orcaPage, 'session.tabs.createTerminal', {
    worktree: `id:${worktreeId}`,
    command: 'sleep 3; exit 3',
    // Why activate: a background tab's pane mounts lazily, so its shell would not start yet.
    activate: true
  })
  const parentTabId: unknown =
    created && typeof created === 'object' && 'tab' in created && created.tab
      ? Reflect.get(created.tab, 'parentTabId')
      : undefined
  expect(typeof parentTabId).toBe('string')

  let failed: TerminalTab | undefined
  await expect
    .poll(
      async () => {
        failed = (await terminalTabs(orcaPage, worktreeId)).find(
          (tab) => tab.parentTabId === parentTabId
        )
        return failed ? (failed.terminalExit?.exitCode ?? failed.status) : 'absent'
      },
      { timeout: 30_000 }
    )
    .toBe(3)
  expect(failed).toMatchObject({ status: 'pending-handle', terminal: null })

  const restarted = await call(orcaPage, 'session.tabs.restartTerminal', {
    worktree: `id:${worktreeId}`,
    tabId: failed!.parentTabId,
    leafId: failed!.leafId
  })
  expect(restarted).toMatchObject({ terminal: expect.any(String) })

  await expect
    .poll(
      async () => {
        const leaf = (await terminalTabs(orcaPage, worktreeId)).find(
          (tab) => tab.parentTabId === failed!.parentTabId && tab.leafId === failed!.leafId
        )
        return leaf ? { status: leaf.status, exited: Boolean(leaf.terminalExit) } : null
      },
      { timeout: 30_000 }
    )
    .toEqual({ status: 'ready', exited: false })
})
