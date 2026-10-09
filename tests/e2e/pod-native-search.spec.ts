import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import {
  encodeOgdJsonFrame,
  OGD_FRAME_JSON,
  OgdFrameDecoder
} from '../../src/main/pod/search/ogd-frame-codec'
import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

// Runs against a real ogd build only: ORCA_E2E_OGD_BIN=/path/to/ogd. ORCA_E2E_OGD_REPO swaps the
// disposable repo for a real checkout and logs ripgrep vs ogd latency for it.
const ogdBin = process.env.ORCA_E2E_OGD_BIN
const benchRepo = process.env.ORCA_E2E_OGD_REPO
const ogdDir = path.join(os.tmpdir(), `orca-ogd-e2e-${process.pid}`)
const daemonSocket = path.join(ogdDir, 'ogd.sock')
// The app talks to a recording proxy, so the spec can prove which requests ogd answered.
const appSocket = path.join(ogdDir, 'app.sock')
const target = 'src/pod-search/OgdQuickOpenTarget.ts'

test.skip(!ogdBin || process.platform === 'win32', 'needs ORCA_E2E_OGD_BIN with a built ogd')
test.use({
  orcaAppExtraEnv: { POD_SEARCH_SOCKET: appSocket },
  minimumSeededWorktreeCount: 1,
  seededRepoPath: async ({ testRepoPath }, provide) => provide(benchRepo ?? testRepoPath)
})

let daemon: ChildProcess | null = null
let proxy: Server | null = null
const proxiedRequests: Record<string, unknown>[] = []
const proxiedOps = () => proxiedRequests.map((request) => request.op)

function startRecordingProxy(): Promise<Server> {
  const server = createServer((client: Socket) => {
    const upstream = createConnection(daemonSocket)
    const decoder = new OgdFrameDecoder()
    client.on('data', (chunk: Buffer) => {
      for (const frame of decoder.push(chunk)) {
        if (frame.kind === OGD_FRAME_JSON) {
          proxiedRequests.push(JSON.parse(frame.payload.toString('utf8')))
        }
      }
      upstream.write(chunk)
    })
    upstream.on('data', (chunk: Buffer) => client.write(chunk))
    client.on('close', () => upstream.destroy())
    upstream.on('close', () => client.destroy())
    client.on('error', () => upstream.destroy())
    upstream.on('error', () => client.destroy())
  })
  return new Promise((resolve) => server.listen(appSocket, () => resolve(server)))
}

let daemonFeatures: string[] = []

/** One request on a fresh connection, straight to the daemon. */
async function ogdRequest(message: Record<string, unknown>): Promise<Record<string, unknown>> {
  const socket = createConnection(daemonSocket)
  const decoder = new OgdFrameDecoder()
  const replies: Record<string, unknown>[] = []
  try {
    return await new Promise((resolve, reject) => {
      socket.on('error', reject)
      socket.on('data', (chunk: Buffer) => {
        for (const frame of decoder.push(chunk)) {
          if (frame.kind === OGD_FRAME_JSON) {
            replies.push(JSON.parse(frame.payload.toString('utf8')))
          }
        }
        if (replies.length === 2) {
          const features = replies[0].features
          daemonFeatures = Array.isArray(features) ? features.map(String) : []
          resolve(replies[1])
        }
      })
      socket.write(encodeOgdJsonFrame({ op: 'hello', proto: 1, client: 'orca-e2e', pid: 0 }))
      socket.write(encodeOgdJsonFrame({ ...message, id: 1 }))
    })
  } finally {
    socket.destroy()
  }
}

test.beforeAll(async () => {
  rmSync(ogdDir, { recursive: true, force: true })
  mkdirSync(ogdDir, { recursive: true })
  daemon = spawn(
    String(ogdBin),
    ['--socket', daemonSocket, '--state-dir', path.join(ogdDir, 'state'), '--idle-secs', '900'],
    { stdio: 'ignore' }
  )
  await expect.poll(() => existsSync(daemonSocket), { timeout: 10_000 }).toBe(true)
  proxy = await startRecordingProxy()
})

test.afterAll(async () => {
  daemon?.kill()
  await new Promise<void>((resolve) => (proxy ? proxy.close(() => resolve()) : resolve()))
  rmSync(ogdDir, { recursive: true, force: true })
})

async function useEngine(page: Page, engine: 'ogd' | 'rg', showGitIgnoredFiles: boolean) {
  await page.evaluate((settings) => window.__store?.getState().updateSettingsOrThrow(settings), {
    experimentalPodNativeSearch: engine === 'ogd',
    showGitIgnoredFiles
  })
}

/** Milliseconds from asking for the palette to a result row matching `expected`. */
async function quickOpenToResults(
  page: Page,
  openQuickOpen: () => Promise<void>,
  query: string,
  expected: string
): Promise<number> {
  await page.evaluate(() => Reflect.set(window, '__podQuickOpenStart', performance.now()))
  await openQuickOpen()
  const dialog = page.getByRole('dialog', { name: 'Go to file' })
  await dialog.locator('input[placeholder="Go to file..."]').fill(query)
  const handle = await page.waitForFunction(
    (text) => {
      const rows = document.querySelectorAll('[role="dialog"] [role="option"]')
      const hit = Array.from(rows).some((row) => row.textContent?.includes(text))
      return hit ? performance.now() - Number(Reflect.get(window, '__podQuickOpenStart')) : null
    },
    expected,
    { polling: 'raf', timeout: 30_000 }
  )
  const elapsed = Number(await handle.jsonValue())
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  return elapsed
}

async function textSearch(page: Page, rootPath: string, query: string) {
  return page.evaluate(
    async (args) => {
      const start = performance.now()
      const result = await window.api.fs.search({ ...args, maxResults: 2000 })
      return {
        ms: performance.now() - start,
        files: result.files.map((file) => file.relativePath).sort(),
        matches: result.totalMatches,
        truncated: result.truncated
      }
    },
    { rootPath, query }
  )
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return Math.round(sorted[Math.floor(sorted.length / 2)])
}

test('local quick open and file search are answered by ogd, and match ripgrep', async ({
  electronApp,
  orcaPage,
  seededRepoPath
}) => {
  test.setTimeout(benchRepo ? 600_000 : 180_000)
  const root = realpathSync(seededRepoPath)
  if (!benchRepo) {
    mkdirSync(path.join(root, path.dirname(target)), { recursive: true })
    writeFileSync(path.join(root, target), 'export const ogdQuickOpenNeedle = true\n')
  }
  const registered = await ogdRequest({ op: 'register', root, wait: true })
  expect(registered.ok).toBe(true)

  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  // Headless Playwright keyboard events bypass Electron's before-input-event shortcut path.
  const openQuickOpen = () =>
    electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('ui:openQuickOpen')
    })

  const pathQueries = benchRepo
    ? [
        ['package.json', 'package.json'],
        ['index.ts', 'index.ts'],
        ['button', 'utton']
      ]
    : [['OgdQuickOpenTarget', 'OgdQuickOpenTarget.ts']]
  const textQueries = benchRepo
    ? ['useEffect', 'TODO', 'export default function']
    : ['ogdQuickOpenNeedle']
  const runs = benchRepo ? 5 : 1
  const timings: Record<string, number> = {}
  const answers: Record<string, Awaited<ReturnType<typeof textSearch>>> = {}

  // What the client will hand to ogd; everything else must stay on ripgrep.
  const servesSearch = ['search.full_lines', 'search.max_filesize'].every((feature) =>
    daemonFeatures.includes(feature)
  )
  for (const [mode, engine, ignored] of [
    ['rg (gitignored shown)', 'rg', true],
    ['ogd (gitignored shown)', 'ogd', true],
    ['rg', 'rg', false],
    ['ogd', 'ogd', false]
  ] as const) {
    await useEngine(orcaPage, engine, ignored)
    const opsBefore = proxiedRequests.length
    for (const [query, expected] of pathQueries) {
      const samples: number[] = []
      for (let run = 0; run < runs; run++) {
        samples.push(await quickOpenToResults(orcaPage, openQuickOpen, query, expected))
      }
      timings[`${mode} quick open "${query}"`] = median(samples)
    }
    for (const query of textQueries) {
      const samples: number[] = []
      for (let run = 0; run < runs; run++) {
        const result = await textSearch(orcaPage, root, query)
        samples.push(result.ms)
        answers[`${mode}:${query}`] = result
      }
      timings[`${mode} search "${query}"`] = median(samples)
    }
    const ops = proxiedOps().slice(opsBefore)
    if (engine === 'ogd') {
      const servesPaths = !ignored || daemonFeatures.includes('fuzzy.ignored')
      expect(ops.includes('fuzzy')).toBe(servesPaths)
      expect(ops.includes('search')).toBe(servesSearch)
    } else {
      expect(ops.filter((op) => op === 'fuzzy' || op === 'search' || op === 'files')).toEqual([])
    }
  }

  for (const query of textQueries) {
    const [indexed, ripgrep] = [answers[`ogd:${query}`], answers[`rg:${query}`]]
    const withIgnored = answers[`ogd (gitignored shown):${query}`]
    expect({ ...withIgnored, ms: 0 }).toEqual({ ...indexed, ms: 0 })
    // Truncated pages hold whichever files each engine reached first.
    expect(indexed.truncated).toBe(ripgrep.truncated)
    if (!ripgrep.truncated) {
      expect({ files: indexed.files, matches: indexed.matches }).toEqual({
        files: ripgrep.files,
        matches: ripgrep.matches
      })
    }
  }
  if (!benchRepo) {
    expect(answers['ogd:ogdQuickOpenNeedle'].files).toEqual([target])
    // Opening a result tells ogd (frecency), and the next query ranks around the active file.
    await useEngine(orcaPage, 'ogd', false)
    await openQuickOpen()
    const dialog = orcaPage.getByRole('dialog', { name: 'Go to file' })
    await dialog.locator('input[placeholder="Go to file..."]').fill('OgdQuickOpenTarget')
    await dialog.getByRole('option').filter({ hasText: 'OgdQuickOpenTarget.ts' }).first().click()
    await expect(dialog).toBeHidden()
    await expect
      .poll(() => proxiedRequests.findLast((request) => request.op === 'touch'))
      .toMatchObject({ kind: 'open', paths: [path.join(root, target)] })
    await quickOpenToResults(orcaPage, openQuickOpen, 'OgdQuick', 'OgdQuickOpenTarget.ts')
    expect(proxiedRequests.findLast((request) => request.op === 'fuzzy')).toMatchObject({
      current: target
    })
  }
  const status = await ogdRequest({ op: 'status' })
  console.log(
    `[pod-native-search] ${JSON.stringify({ repo: root, features: daemonFeatures, timings, worktrees: status.worktrees }, null, 2)}`
  )
})
