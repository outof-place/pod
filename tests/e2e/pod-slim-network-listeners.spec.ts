/**
 * Fork-only (Pod): the desktop app opens no TCP listener beyond loopback. Pod cuts mobile, web
 * and LAN pairing (src/shared/product/features.ts `runtimeWebSocket`), so the runtime RPC
 * advertises only its unix socket. POD_BUILD_PROFILE=orca keeps upstream's WebSocket listener,
 * which E2E binds on every interface — that run proves the probe sees a wide listener.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { e2ePodFeatures } from './helpers/pod-build-profile'

test.skip(process.platform !== 'darwin', 'lsof-based listener census is macOS-only here')

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
    const output = execFileSync(
      'lsof',
      ['-nP', '-a', '-p', pids.join(','), '-iTCP', '-sTCP:LISTEN', '-Fn'],
      { encoding: 'utf8' }
    )
    return output
      .split('\n')
      .filter((line) => line.startsWith('n'))
      .map((line) => line.slice(1))
  } catch (error) {
    // Why: lsof exits 1 when nothing matches, which is the expected Pod result.
    if (error instanceof Error && 'status' in error && error.status === 1) {
      return []
    }
    throw error
  }
}

function isLoopbackAddress(address: string): boolean {
  return address.startsWith('127.') || address.startsWith('[::1]:')
}

test('the desktop runtime listens on TCP only when the profile keeps network pairing', async ({
  electronApp,
  orcaPage
}) => {
  await expect(orcaPage.locator('body')).toBeVisible()
  const { pid, userDataPath } = await electronApp.evaluate(({ app }) => ({
    pid: process.pid,
    userDataPath: app.getPath('userData')
  }))
  const metadataPath = path.join(userDataPath, 'orca-runtime.json')
  const readTransportKinds = (): string[] | null => {
    if (!existsSync(metadataPath)) {
      return null
    }
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'))
    return metadata.pid === pid
      ? metadata.transports.map((transport: { kind: string }) => transport.kind)
      : null
  }
  await expect.poll(readTransportKinds, { timeout: 30_000 }).not.toBeNull()

  const wideListeners = (): string[] =>
    tcpListenAddresses(processTree(pid)).filter((address) => !isLoopbackAddress(address))
  if (e2ePodFeatures.runtimeWebSocket) {
    expect(readTransportKinds()).toContain('websocket')
    await expect.poll(wideListeners, { timeout: 10_000 }).not.toEqual([])
    return
  }
  expect(readTransportKinds()).toEqual(['unix'])
  expect(wideListeners()).toEqual([])
})
