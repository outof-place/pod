// The plist Pod writes against the real daemon: build.sh's helper, installed by the lifecycle (launchd
// faked), started from the plist's own ProgramArguments the way launchd starts it, then stopped.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { runProcess, spawnProcess } from '@orca/process-host'
import { runPodGoCacheLifecycle } from './pod-gocache-lifecycle'
import {
  fakeLaunchd,
  lifecycleFixture as fixture,
  removeLifecycleFixtures
} from './pod-gocache-lifecycle-fixture'

const REPO = join(__dirname, '../../../..')
// the plist's ExitTimeOut: launchd's SIGKILL comes after it
const EXIT_TIMEOUT_MS = 10_000

let root = ''
let built = ''

function readOwner(stateDir: string): { pid?: number; mode?: string; cacheDir?: string } | null {
  try {
    const owner: unknown = JSON.parse(readFileSync(join(stateDir, 'owner.json'), 'utf8'))
    return {
      pid: Reflect.get(Object(owner), 'pid'),
      mode: Reflect.get(Object(owner), 'mode'),
      cacheDir: Reflect.get(Object(owner), 'cacheDir')
    }
  } catch {
    return null
  }
}

async function until(what: string, ms: number, done: () => boolean): Promise<void> {
  const deadline = Date.now() + ms
  while (!done()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${ms} ms waiting for ${what}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

afterEach(removeLifecycleFixtures)

describe.skipIf(process.platform !== 'darwin')('pod-gocache plist against the real daemon', () => {
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'pod-gocache-daemon-'))
    built = join(root, 'pod-gocache')
    const build = await runProcess(
      {
        program: 'bash',
        args: [join(REPO, 'native/pod-gocache-macos/scripts/build.sh'), '--out', built],
        // a throwaway build cache: never the account's ~/Library/Caches/go-build
        env: { ...process.env, GOCACHE: join(root, 'build-cache') },
        timeoutMs: 300_000
      },
      'tail'
    )
    expect(build.code, build.stderr).toBe(0)
  }, 320_000)

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('starts from the written ProgramArguments on its temp cache and stops cleanly on SIGTERM', async () => {
    const f = fixture({ bundled: null })
    mkdirSync(join(f.bundledHelper, '..'), { recursive: true })
    copyFileSync(built, f.bundledHelper)
    mkdirSync(f.cacheDir, { recursive: true })

    await expect(runPodGoCacheLifecycle(f.input, fakeLaunchd().run)).resolves.toMatchObject({
      status: 'installed'
    })
    const plist = await runProcess({
      program: '/usr/bin/plutil',
      args: ['-convert', 'json', '-o', '-', f.plist]
    })
    const job: unknown = JSON.parse(plist.stdout)
    const programArguments: unknown = Reflect.get(Object(job), 'ProgramArguments')
    const workingDirectory: unknown = Reflect.get(Object(job), 'WorkingDirectory')
    if (!Array.isArray(programArguments) || typeof workingDirectory !== 'string') {
      throw new Error(`unexpected plist: ${plist.stdout}`)
    }
    const [program, ...args] = programArguments.map(String)
    expect(program).toBe(f.installedHelper)

    let stderr = ''
    const daemon = spawnProcess({
      program: program ?? '',
      args,
      cwd: workingDirectory,
      // launchd's environment for a per-user agent
      env: { HOME: f.home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
      stdio: ['ignore', 'ignore', 'pipe']
    })
    daemon.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    const exited = new Promise<number | null>((resolve) => daemon.once('exit', resolve))
    try {
      const stateDir = join(f.home, '.pod/gocache')
      const cacheDir = realpathSync(f.cacheDir)
      await until('owner.json from the daemon', 60_000, () => {
        const owner = readOwner(stateDir)
        if (daemon.exitCode !== null) {
          throw new Error(`the daemon exited ${daemon.exitCode}: ${stderr}`)
        }
        return owner?.pid === daemon.pid && owner?.cacheDir === cacheDir
      })

      const stopAt = Date.now()
      daemon.kill('SIGTERM')
      const code = await Promise.race([
        exited,
        new Promise<'late'>((resolve) => setTimeout(() => resolve('late'), EXIT_TIMEOUT_MS))
      ])
      expect(code, stderr).toBe(0)
      expect(Date.now() - stopAt).toBeLessThan(EXIT_TIMEOUT_MS)
      expect(readOwner(stateDir)).toMatchObject({ pid: daemon.pid, mode: 'observe', cacheDir })
    } finally {
      daemon.kill('SIGKILL')
    }
  }, 120_000)
})
