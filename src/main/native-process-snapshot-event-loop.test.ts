import { execFileSync } from 'node:child_process'
import { isBuiltin } from 'node:module'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

describe.runIf(process.platform === 'darwin')('native process snapshot worker', () => {
  let scratch = ''
  let harnessPath = ''

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'orca-native-snapshot-loop-'))
    const addonPath = join(
      scratch,
      'native',
      'proc-info-darwin',
      '.build',
      'release',
      'orca-proc-info.node'
    )
    execFileSync(
      process.execPath,
      ['config/scripts/build-proc-info-macos.mjs', '--single-arch', '--output', addonPath],
      { stdio: 'inherit' }
    )
    const harnessSource = join(scratch, 'harness.ts')
    harnessPath = join(scratch, 'harness.js')
    writeFileSync(
      harnessSource,
      `import { performance } from 'node:perf_hooks'
import { getNativeProcessInfo } from ${JSON.stringify(resolve('src/shared/native-process-info.ts'))}
import { setAppEnvironment } from ${JSON.stringify(resolve('src/shared/app-environment.ts'))}

async function main() {
  if (getNativeProcessInfo() !== null) throw new Error('An uninitialized host loaded an addon')
  const shutdown = []
  setAppEnvironment({
    getAppPath: () => ${JSON.stringify(scratch)},
    isPackaged: () => false,
    onWillQuit: (callback) => shutdown.push(callback),
    getPath: () => '', getVersion: () => '', getAppMetrics: () => [], exit: () => {}
  })
  const native = getNativeProcessInfo()
  if (!native) throw new Error('Initializing the app environment did not enable its addon')
  let ticks = 0, maxGap = 0, last = performance.now()
  const heartbeat = setInterval(() => {
    const now = performance.now()
    maxGap = Math.max(maxGap, now - last)
    last = now
    ticks++
    native.readProcess(process.pid)
  }, 5)
  const captures = []
  try {
    for (let i = 0; i < 2; i++) {
      const cheap = await native.listProcesses()
      const full = await native.listProcessesWithCommands()
      const own = full.find((row) => row.pid === process.pid)
      if (own?.ppid !== process.ppid || !own.command || !own.startTime) {
        throw new Error('Worker capture lost process identity or argv')
      }
      captures.push({ cheapCount: cheap.length, fullCount: full.length })
    }
  } finally {
    clearInterval(heartbeat)
    shutdown.forEach((callback) => callback())
  }
  console.log(JSON.stringify({ ticks, maxGap, captures }))
}
main().catch((error) => { console.error(error); process.exitCode = 1 })`
    )
    await build({
      configFile: false,
      logLevel: 'silent',
      build: {
        ssr: true,
        outDir: scratch,
        emptyOutDir: false,
        rollupOptions: {
          input: {
            harness: harnessSource,
            'native-process-snapshot-worker-entry': resolve(
              'src/main/native-process-snapshot-worker-entry.ts'
            )
          },
          external: isBuiltin,
          output: {
            format: 'cjs',
            entryFileNames: '[name].js',
            chunkFileNames: 'chunks/[name]-[hash].js'
          }
        }
      }
    })
  }, 120_000)

  afterAll(() => rmSync(scratch, { force: true, recursive: true }))

  it('keeps timers running during cold and warm kernel captures through the real loader', () => {
    const result = JSON.parse(
      execFileSync(process.execPath, [harnessPath], {
        encoding: 'utf8',
        timeout: 60_000,
        env: {
          ...process.env,
          ORCA_BACKGROUND_LAUNCH: '1',
          ORCA_DISABLE_NATIVE_PROCESS_INFO: '0'
        }
      })
    )
    expect(result.captures).toHaveLength(2)
    for (const capture of result.captures) {
      expect(capture.cheapCount).toBeGreaterThan(0)
      expect(capture.fullCount).toBeGreaterThan(0)
    }
    expect(result.ticks).toBeGreaterThan(2)
    expect(result.maxGap).toBeLessThan(250)
  }, 120_000)
})
