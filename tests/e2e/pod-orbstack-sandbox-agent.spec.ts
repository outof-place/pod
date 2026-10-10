import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createSecureServer, type Http2SecureServer } from 'node:http2'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { runProcess } from '../../src/shared/child-process/run-process'
import { podOrbstackMachineName } from '../../src/main/pod/orbstack/pod-orbstack-recipe'
import { createSandboxCa } from '../../src/main/pod/orbstack/pod-orbstack-sandbox-ca'
import { expect, test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

// Real OrbStack: builds a worktree's isolated agent sandbox from Settings › OrbStack, launches a
// stand-in Claude in it, and checks that its hook status reaches Pod and that it cannot see the
// rest of the Mac. Opt-in (POD_E2E_ORBSTACK=1) because it boots a Linux machine.
const ORB = '/Applications/OrbStack.app/Contents/MacOS/bin/orb'
// Why realpath: OrbStack shares /private, not the /var link that os.tmpdir() returns.
const baseDir = path.join(realpathSync(os.tmpdir()), `pod-orbstack-sbx-e2e-${process.pid}`)
const repoPath = path.join(baseDir, 'sandbox-e2e')
const fakeAgentPath = path.join(repoPath, 'fake-claude.sh')
const visibilityPath = path.join(repoPath, 'visibility.txt')
const screenshotDir = process.env.POD_E2E_SCREENSHOT_DIR
const createdMachines = new Set<string>()
// A stand-in for api.anthropic.com on the Mac, with its own CA: the anthropic-api route goes there
// under a fake key, so the spec never touches the real API or a real credential.
const stubApiCa = createSandboxCa('stub-upstream')
const stubApiCaPath = path.join(baseDir, 'stub-api-ca.pem')
const stubApiPort = 41_000 + (process.pid % 2_000)
const stubApiRequests: { method?: string; url?: string; apiKey?: string }[] = []
let stubApi: Http2SecureServer | null = null

test.skip(
  process.platform !== 'darwin' || process.env.POD_E2E_ORBSTACK !== '1',
  'boots a real OrbStack machine; set POD_E2E_ORBSTACK=1 on a Mac with OrbStack'
)
test.use({
  // The isolated E2E HOME is too long for orb's socket path; OrbStack lives under the real one.
  orcaAppExtraEnv: {
    POD_ORBSTACK: '1',
    POD_ACC_LIFECYCLE: 'off',
    POD_E2E_ORBSTACK_HOME: os.homedir(),
    // The stand-in agent needs only Pod's hook script, not a Claude download.
    POD_E2E_ORBSTACK_SKIP_AGENT_INSTALL: '1',
    POD_E2E_ANTHROPIC_UPSTREAM: `127.0.0.1:${stubApiPort}`,
    POD_E2E_ANTHROPIC_UPSTREAM_CA: stubApiCaPath
  },
  minimumSeededWorktreeCount: 1
})
test.setTimeout(8 * 60_000)

// Runs inside the sandbox: posts Claude-shaped hook events through the script Pod installed.
const FAKE_AGENT = `#!/bin/sh
hook="$HOME/.orca/agent-hooks/claude-hook.sh"
emit() {
  printf '{"hook_event_name":"%s","session_id":"pod-e2e-sandbox","cwd":"%s","prompt":"hello from the sandbox"}' "$1" "$PWD" | /bin/sh "$hook" >/dev/null 2>>"${repoPath}/hook.log"
}
env | grep -e ^ORCA_ -e ^HOME= -e ^ANTHROPIC_ -e ^NODE_EXTRA_CA_CERTS= -e ^POD_SANDBOX | sed 's/TOKEN=.*/TOKEN=<set>/' > "${repoPath}/agent-env.txt"
# The VM's api.anthropic.com is the relay; it trusts only the sandbox CA and swaps the placeholder key.
curl -sS -m 10 --cacert "$NODE_EXTRA_CA_CERTS" -H "x-api-key: $ANTHROPIC_API_KEY" -H 'content-type: application/json' \
  -o /dev/null -w '%{http_code}' -d '{"model":"stub"}' https://api.anthropic.com/v1/messages > "${repoPath}/api-status.txt" 2>>"${repoPath}/hook.log"
{ [ -e "${os.homedir()}/Documents" ] && echo "home: visible" || echo "home: hidden"; } > "${visibilityPath}"
emit SessionStart
emit UserPromptSubmit
sleep 3
emit Stop
sleep 120
`

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

/** `orb` processes on the Mac that name the machine: its relay, or an agent launch inside it. */
async function orbProcessesFor(machine: string, only?: 'relay'): Promise<string[]> {
  const pattern = only === 'relay' ? `-m ${machine} -u root python3` : `-m ${machine}`
  const result = await runProcess({ program: 'pgrep', args: ['-fl', '--', pattern] })
  return result.stdout.split('\n').filter((line) => line.includes('orb'))
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
  writeFileSync(path.join(repoPath, 'README.md'), '# sandbox e2e\n')
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
  writeFileSync(fakeAgentPath, FAKE_AGENT)
  chmodSync(fakeAgentPath, 0o755)
  writeFileSync(stubApiCaPath, stubApiCa.caCertPem)
  const server = createSecureServer(
    { allowHTTP1: true, key: stubApiCa.leafKeyPem, cert: stubApiCa.leafCertPem },
    (req, res) => {
      stubApiRequests.push({
        method: req.method,
        url: req.url,
        apiKey: req.headers['x-api-key']?.toString()
      })
      req.resume()
      req.on('end', () => res.end('{"type":"message"}'))
    }
  )
  await new Promise<void>((resolve) => server.listen(stubApiPort, '127.0.0.1', resolve))
  stubApi = server
})

test.afterAll(async () => {
  stubApi?.close()
  // Pod has quit by now, and a relay never outlives it.
  for (const name of createdMachines) {
    expect(await orbProcessesFor(name, 'relay')).toEqual([])
  }
  // Only machines this spec created, and only if a failed run left them behind.
  const remaining = await listMachines().catch((): string[] => [])
  for (const name of createdMachines) {
    if (name.startsWith('pod-') && remaining.includes(name)) {
      await run(ORB, ['delete', '--force', name]).catch(() => undefined)
    }
  }
  rmSync(baseDir, { recursive: true, force: true })
})

test('a Claude launch runs in the worktree sandbox and its hook status reaches Pod', async ({
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
  const sandbox = podOrbstackMachineName(worktreeId, repoPath, 'sandbox')
  createdMachines.add(sandbox)
  expect(await listMachines()).not.toContain(sandbox)

  await orcaPage.evaluate(() => window.__store?.getState().openSettingsPage())
  await orcaPage.getByRole('button', { name: 'OrbStack', exact: true }).click()
  const section = orcaPage.locator('#pod-orbstack')
  // The Mac's Claude Code login is opt-in: off until the user flips it, and the switch persists.
  const loginSwitch = section.getByRole('switch', {
    name: /Let sandboxed agents use this Mac's Claude Code login/
  })
  await expect(loginSwitch).not.toBeChecked()
  await loginSwitch.click()
  await expect(loginSwitch).toBeChecked()
  await loginSwitch.click()
  await expect(loginSwitch).not.toBeChecked()
  const row = section.locator(
    `[data-testid="pod-orbstack-worktree-row"][data-worktree-path="${repoPath}"]`
  )
  await row.getByRole('button', { name: 'Create agent sandbox' }).click()
  await expect(row.getByText(sandbox, { exact: true })).toBeVisible({ timeout: 6 * 60_000 })
  // The switch unlocks only once Pod has installed its hook files in the sandbox.
  const agentSwitch = row.getByRole('switch', { name: /Run Claude launches of/ })
  await expect(agentSwitch).toBeEnabled({ timeout: 6 * 60_000 })
  expect(await listMachines()).toContain(sandbox)
  await agentSwitch.click()
  await expect(agentSwitch).toBeChecked()
  await screenshot(orcaPage, 'pod-orbstack-sandbox.png')

  // A Claude launch in that worktree: Pod rewrites it to `orb -m <sandbox> … exec <command>`.
  const paneKey = await orcaPage.evaluate(
    async ({ worktreeId, repoPath, command, leafId }) => {
      const tab = window.__store
        ?.getState()
        .createTab(worktreeId, undefined, undefined, { activate: false })
      if (!tab) {
        throw new Error('no tab')
      }
      await window.api.pty.spawn({
        cols: 100,
        rows: 30,
        cwd: repoPath,
        worktreeId,
        tabId: tab.id,
        leafId,
        launchAgent: 'claude',
        command,
        // Why: pane identity env (ORCA_PANE_KEY) is attached only to a spawn that carries an env.
        env: {}
      })
      return `${tab.id}:${leafId}`
    },
    { worktreeId, repoPath, command: `'${fakeAgentPath}'`, leafId: randomUUID() }
  )

  const readStatus = () =>
    orcaPage.evaluate((paneKey) => {
      const status = window.__store?.getState().agentStatusByPaneKey[paneKey]
      return status ? { state: status.state, prompt: status.prompt ?? null } : null
    }, paneKey)
  const diagnostics = (): string =>
    ['agent-env.txt', 'hook.log', 'visibility.txt', 'api-status.txt']
      .map((file) => {
        const full = path.join(repoPath, file)
        return `--- ${file}\n${existsSync(full) ? readFileSync(full, 'utf8').slice(-3000) : '(missing)'}`
      })
      .join('\n')
  try {
    await expect
      .poll(readStatus, { timeout: 60_000, message: 'no working status from the sandbox' })
      .toMatchObject({ state: 'working', prompt: 'hello from the sandbox' })
  } catch (error) {
    console.log(diagnostics())
    throw error
  }
  await expect
    .poll(readStatus, { timeout: 30_000, message: 'no done status from the sandbox' })
    .toMatchObject({ state: 'done' })
  // The stand-in ran inside the sandbox, which shares only the worktree.
  await expect.poll(() => existsSync(visibilityPath), { timeout: 10_000 }).toBe(true)
  expect(readFileSync(visibilityPath, 'utf8').trim()).toBe('home: hidden')
  // The anthropic-api route: pinned, trusted only through the sandbox CA, key swapped on the Mac.
  const agentEnv = readFileSync(path.join(repoPath, 'agent-env.txt'), 'utf8')
  expect(agentEnv).toContain('ANTHROPIC_API_KEY=pod-sandbox-no-credential')
  expect(agentEnv).toContain('NODE_EXTRA_CA_CERTS=/etc/pod-sandbox/anthropic-ca.pem')
  expect(agentEnv).not.toContain('POD_SANDBOX_VM_')
  expect(readFileSync(path.join(repoPath, 'api-status.txt'), 'utf8')).toBe('200')
  expect(stubApiRequests).toEqual([
    { method: 'POST', url: '/v1/messages', apiKey: 'pod-e2e-stub-key' }
  ])

  await row.getByRole('button', { name: 'Delete agent sandbox' }).click()
  await expect(row.getByRole('button', { name: 'Create agent sandbox' })).toBeVisible({
    timeout: 120_000
  })
  expect(await listMachines()).not.toContain(sandbox)
  // Destroying the sandbox ends its relay and the agent launch inside it: no orphan `orb run`.
  await expect.poll(() => orbProcessesFor(sandbox), { timeout: 15_000 }).toEqual([])
  // Other machines in `orb list` are the user's; none of Pod's may remain.
  expect((await listMachines()).filter((name) => name.startsWith('pod-'))).toEqual([])
})
