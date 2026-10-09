/**
 * Fork-only (Pod): a product build shipped with `"stablyServices": false` starts, opens a project,
 * runs a terminal command and touches every Stably-backed entry point without one request to a
 * Stably host. Node traffic and spawned commands (git clones of Stably's plugin marketplace) are
 * seen by a probe required before main's first line; Chromium traffic (renderer, net.fetch,
 * webviews) by a netlog. Both network layers black-hole Stably's hosts, so a broken gate fails
 * here without reaching Stably.
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible } from './helpers/store'
import {
  focusActiveTerminalInput,
  getTerminalContent,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'

const STABLY_HOST = /(^|[./"@])(onorca\.dev|orca\.dev|posthog\.com)\b/i
const STABLY_HOST_RULES = ['onorca.dev', '*.onorca.dev', 'orca.dev', '*.orca.dev', '*.posthog.com']
  .map((host) => `MAP ${host} ~NOTFOUND`)
  .join(', ')

const probeDir = mkdtempSync(path.join(os.tmpdir(), 'pod-e2e-network-'))
const probeLogPath = path.join(probeDir, 'node-network.ndjson')
const netLogPath = path.join(probeDir, 'chromium-netlog.json')

test.use({
  orcaAppExtraEnv: {
    POD_E2E_PRODUCT_IDENTITY_PATH: path.join(process.cwd(), 'product', 'identity.json'),
    ORCA_E2E_NETWORK_PROBE_LOG: probeLogPath
  },
  orcaAppExtraArgs: [
    // Why -r and not NODE_OPTIONS: Playwright's Electron launcher deletes NODE_OPTIONS.
    '-r',
    path.join(process.cwd(), 'tests', 'e2e', 'helpers', 'stably-host-network-probe.cjs'),
    `--log-net-log=${netLogPath}`,
    `--host-resolver-rules=${STABLY_HOST_RULES}`
  ]
})

function readNodeTargets(): string[] {
  if (!existsSync(probeLogPath)) {
    return []
  }
  return readFileSync(probeLogPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line): unknown => JSON.parse(line))
    .map((entry) =>
      typeof entry === 'object' && entry !== null && 'target' in entry ? String(entry.target) : ''
    )
}

// Why only events: the netlog's constants echo the command line, which names the blocked hosts.
// The file is unterminated JSON while the app runs, hence the fallback.
function readNetLogEvents(): string {
  if (!existsSync(netLogPath)) {
    return ''
  }
  const text = readFileSync(netLogPath, 'utf8')
  try {
    const log: unknown = JSON.parse(text)
    return typeof log === 'object' && log !== null && 'events' in log
      ? JSON.stringify(log.events)
      : text
  } catch {
    return text.replace(/"command_line":"(?:[^"\\]|\\.)*"/g, '')
  }
}

async function startControlServer(): Promise<{ server: Server; url: string }> {
  const server = createServer((_request, response) => response.end('ok'))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('control server has no port')
  }
  return { server, url: `http://127.0.0.1:${address.port}/pod-e2e-control` }
}

test('a product without Stably services never contacts a Stably host', async ({
  electronApp,
  orcaPage
}) => {
  const control = await startControlServer()
  try {
    await expect.poll(() => orcaPage.title()).toBe('Pod')

    await ensureTerminalVisible(orcaPage, 30_000)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await waitForActivePanePtyId(orcaPage, 30_000)
    const marker = `pod-e2e-${Date.now()}`
    await focusActiveTerminalInput(orcaPage)
    await orcaPage.keyboard.type(`echo ${marker}`)
    await orcaPage.keyboard.press('Enter')
    await expect
      .poll(async () => (await getTerminalContent(orcaPage)).split(marker).length - 1)
      .toBeGreaterThanOrEqual(2)

    // Every entry point that reaches Stably in upstream Orca, driven through the real IPC.
    const results = await orcaPage.evaluate(async () => {
      const settle = <T>(promise: Promise<T>) =>
        promise.then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error: String(error) })
        )
      return {
        feedback: await window.api.feedback.submit({
          feedback: 'pod e2e',
          submitAnonymously: true,
          githubLogin: null,
          githubEmail: null
        }),
        skillShare: await settle(window.api.skills.resolveShare('podE2EShare')),
        cloud: await window.api.orcaProfiles.authStatus(),
        diagnostics: await window.api.diagnostics.getStatus(),
        telemetry: await window.api.telemetryGetConsentState(),
        product: window.api.product.get()
      }
    })
    expect(results.feedback).toMatchObject({
      ok: false,
      error: 'Feedback is not available in Pod.'
    })
    expect(JSON.stringify(results.skillShare)).toContain('Sharing is not available in Pod.')
    expect(results.cloud).toMatchObject({ configured: false })
    expect(results.diagnostics).toMatchObject({ bundleEnabled: false })
    expect(results.telemetry).toEqual({ effective: 'disabled', reason: 'orca_disabled' })
    expect(results.product).toMatchObject({ displayName: 'Pod', stablyServices: false })

    // Native chrome the identity names: window title and the menu items main translates.
    const chrome = await electronApp.evaluate(({ BrowserWindow, Menu }) => {
      const labels: string[] = []
      // Why skip top-level labels and role items: the app menu and About/Hide/Quit carry the dev
      // instance name here; a packaged build names them after the product (pod/identity).
      const walk = (items: Electron.MenuItem[], nested: boolean): void => {
        for (const item of items) {
          if (nested && item.visible && !item.role) {
            labels.push(item.label)
          }
          walk(item.submenu?.items ?? [], true)
        }
      }
      walk(Menu.getApplicationMenu()?.items ?? [], false)
      return { title: BrowserWindow.getAllWindows()[0]?.getTitle(), labels }
    })
    expect(chrome.title).toBe('Pod')
    expect(chrome.labels).toEqual(
      expect.arrayContaining(['Explore Pod', 'Getting Started with Pod'])
    )
    expect(chrome.labels.filter((label) => /\bOrca\b/.test(label))).toEqual([])

    // The plugin system on, as pod/acc turns it on for the bundled distro plugin: the official
    // marketplace (github.com/stablyai/orca-plugins) must stay unfetched without the opt-in.
    await orcaPage.evaluate(() => window.api.settings.set({ pluginSystemEnabled: true }))

    // Controls: both probes see ordinary traffic, so an empty Stably list is meaningful.
    await electronApp.evaluate(async ({ net }, url) => {
      await fetch(`${url}?layer=node`)
      await net.fetch(`${url}?layer=chromium`)
    }, control.url)
    await expect
      .poll(() => readNodeTargets().some((target) => target.includes('layer=node')))
      .toBe(true)

    // Let startup timers (plugin safety list, marketplace seed, push outbox, relay, telemetry flush) run, then
    // wait for the netlog writer to flush through the control request.
    await orcaPage.waitForTimeout(5_000)
    await electronApp.evaluate(
      ({ net }, url) => net.fetch(`${url}?layer=chromium-final`),
      control.url
    )
    await expect.poll(() => readNetLogEvents().includes('layer=chromium-final')).toBe(true)

    const netLogEvents = readNetLogEvents()
    const stablyNodeTargets = readNodeTargets().filter((target) => STABLY_HOST.test(target))
    const stablyNetLogHosts = [
      ...new Set(netLogEvents.match(/[\w.-]*(?:onorca|orca)\.dev|[\w.-]*posthog\.com/gi))
    ]
    expect(stablyNodeTargets).toEqual([])
    expect(readNodeTargets().filter((target) => target.includes('stablyai/orca-plugins'))).toEqual(
      []
    )
    expect(stablyNetLogHosts).toEqual([])
  } finally {
    control.server.close()
  }
})
