import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SimRecipeApp } from '../../../../shared/pod-sim/sim-recipe'
import { createSimFingerprints, parseSimFingerprint } from './sim-app-fingerprint'
import type { SimShell } from './sim-app-shell'

// Shaped like @expo/fingerprint 0.21.3's output on Portivo's mobile app (72 sources there).
function expoJson(hash: string, sources: object[]): string {
  return JSON.stringify({ sources, hash })
}

const APP: SimRecipeApp = {
  bundleId: 'com.example.app',
  path: 'apps/app',
  fingerprint: './node_modules/.bin/fingerprint fingerprint:generate --platform ios'
}

let root: string
let appDir: string

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pod-sim-fp-')))
  appDir = join(root, 'apps', 'app')
  await mkdir(join(appDir, 'assets'), { recursive: true })
  await mkdir(join(root, 'node_modules', 'expo'), { recursive: true })
  await writeFile(join(appDir, 'package.json'), '{}')
  await writeFile(join(appDir, 'app.config.ts'), 'export default {}')
  await writeFile(join(appDir, 'assets', 'icon.png'), 'png')
  await writeFile(join(root, 'node_modules', 'expo', 'package.json'), '{"version":"58.0.3"}')
  await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9')
  // The worktree as it was before this test: nothing in it changes while the first run runs.
  const before = new Date(Date.now() - 7_200_000)
  for (const path of [
    join(appDir, 'package.json'),
    join(appDir, 'app.config.ts'),
    join(appDir, 'assets', 'icon.png'),
    join(root, 'node_modules', 'expo', 'package.json'),
    join(root, 'pnpm-lock.yaml')
  ]) {
    await utimes(path, before, before)
  }
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** A fingerprint command that hashes nothing: it answers the next hash and counts its runs. */
function counting(hashes: string[]) {
  const runs: { cwd: string; env: NodeJS.ProcessEnv }[] = []
  const shell: SimShell = async (_command, options) => {
    runs.push({ cwd: options.cwd, env: options.env })
    const hash = hashes[Math.min(runs.length - 1, hashes.length - 1)]
    return {
      ok: true,
      code: 0,
      stderr: '',
      stdout: expoJson(hash, [
        {
          type: 'file',
          filePath: 'assets/icon.png',
          reasons: ['expoConfigExternalFile'],
          hash: 'a'
        },
        {
          type: 'package',
          name: 'expo',
          filePath: '../../node_modules/expo/package.json',
          reasons: ['package:expo'],
          hash: 'b'
        },
        { type: 'dir', filePath: 'ios', reasons: ['bareNativeDir'], hash: null },
        { type: 'contents', id: 'expoConfig', contents: '{}', reasons: ['expoConfig'], hash: 'c' }
      ])
    }
  }
  return { shell, runs }
}

let edits = 0

/** An edit made a while ago: a new mtime, away from the clock's resolution and from any run. */
async function touch(path: string, content?: string): Promise<void> {
  if (content !== undefined) {
    await writeFile(path, content)
  }
  edits += 1
  const earlier = new Date(Date.now() - 3_600_000 + edits * 1_000)
  await utimes(path, earlier, earlier)
}

describe('reading what a fingerprint command printed', () => {
  it('takes @expo/fingerprint JSON with its sources, or a bare hash', () => {
    expect(parseSimFingerprint(expoJson('6403326f', [{ type: 'file', filePath: 'a' }]))).toEqual({
      hash: '6403326f',
      sources: [{ type: 'file', filePath: 'a' }]
    })
    expect(parseSimFingerprint('warming up\nc118632b5d63\n')).toEqual({
      hash: 'c118632b5d63',
      sources: null
    })
  })

  it('refuses output that names no usable hash (a path, nothing, broken JSON)', () => {
    expect(parseSimFingerprint('')).toBeNull()
    expect(parseSimFingerprint('{"sources":[]}')).toBeNull()
    expect(parseSimFingerprint('{"hash":"../escape"}')).toBeNull()
    expect(parseSimFingerprint('{not json')).toBeNull()
  })
})

describe('a worktree app’s fingerprint, kept against what it hashed', () => {
  it('runs the command once and answers repeat calls from what it kept', async () => {
    const { shell, runs } = counting(['aaa111'])
    const fingerprints = createSimFingerprints({ shell, env: { PATH: '/usr/bin' } })
    const input = { worktreeRoot: root, appId: 'app', app: { ...APP, env: { APP_VARIANT: 'dev' } } }
    const first = await fingerprints.of(input)
    const second = await fingerprints.of(input)
    expect(first).toMatchObject({ ok: true, hash: 'aaa111', cached: false })
    expect(second).toMatchObject({ ok: true, hash: 'aaa111', cached: true })
    expect(runs).toHaveLength(1)
    // In the app's folder, with the recipe's env over the runtime's.
    expect(runs[0].cwd).toBe(appDir)
    expect(runs[0].env).toMatchObject({ PATH: '/usr/bin', APP_VARIANT: 'dev' })
  })

  it('runs again when a source it listed, a config file or the lockfile changes', async () => {
    const { shell, runs } = counting(['h1', 'h2', 'h3', 'h4', 'h5'])
    const fingerprints = createSimFingerprints({ shell })
    const input = { worktreeRoot: root, appId: 'app', app: APP }
    expect((await fingerprints.of(input)).ok).toBe(true)
    await touch(join(appDir, 'assets', 'icon.png'), 'new icon')
    expect(await fingerprints.of(input)).toMatchObject({ hash: 'h2', cached: false })
    await touch(join(root, 'node_modules', 'expo', 'package.json'), '{"version":"58.0.4"}')
    expect(await fingerprints.of(input)).toMatchObject({ hash: 'h3', cached: false })
    // A new .env file: expo config reads it, @expo/fingerprint does not list it.
    await writeFile(join(appDir, '.env.local'), 'TENANT_ID=sea')
    expect(await fingerprints.of(input)).toMatchObject({ hash: 'h4', cached: false })
    await touch(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n# reinstalled')
    expect(await fingerprints.of(input)).toMatchObject({ hash: 'h5', cached: false })
    expect(runs).toHaveLength(5)
  })

  it('keeps its answer while app code, Metro’s files and the gitignored ios folder change', async () => {
    const { shell, runs } = counting(['same'])
    const fingerprints = createSimFingerprints({ shell })
    const input = { worktreeRoot: root, appId: 'app', app: APP }
    await fingerprints.of(input)
    await mkdir(join(appDir, 'src'), { recursive: true })
    await writeFile(join(appDir, 'src', 'screen.tsx'), 'export {}')
    await mkdir(join(appDir, '.expo'), { recursive: true })
    await writeFile(join(appDir, 'uniwind-types.d.ts'), '// written at every Metro start')
    await mkdir(join(appDir, 'ios', 'build'), { recursive: true })
    expect(await fingerprints.of(input)).toMatchObject({ hash: 'same', cached: true })
    expect(runs).toHaveLength(1)
  })

  it('shares one run between calls made at once', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { shell: inner, runs } = counting(['once'])
    const shell: SimShell = async (command, options) => {
      await gate
      return inner(command, options)
    }
    const fingerprints = createSimFingerprints({ shell })
    const input = { worktreeRoot: root, appId: 'app', app: APP }
    const calls = [fingerprints.of(input), fingerprints.of(input), fingerprints.of(input)]
    release()
    expect((await Promise.all(calls)).map((answer) => answer.ok && answer.hash)).toEqual([
      'once',
      'once',
      'once'
    ])
    expect(runs).toHaveLength(1)
  })

  it('does not keep an answer when what it hashed changed while it ran', async () => {
    const { shell: inner, runs } = counting(['during', 'after'])
    const shell: SimShell = async (command, options) => {
      // An install lands mid-run: the answer may describe either state.
      await writeFile(join(root, 'pnpm-lock.yaml'), `lockfileVersion: 9\n# ${runs.length}`)
      return inner(command, options)
    }
    const fingerprints = createSimFingerprints({ shell })
    const input = { worktreeRoot: root, appId: 'app', app: APP }
    await fingerprints.of(input)
    await fingerprints.of(input)
    expect(runs).toHaveLength(2)
  })

  it('says why when the command fails or prints no hash', async () => {
    const failing = createSimFingerprints({
      shell: async () => ({
        ok: true,
        code: 1,
        stdout: '',
        stderr: 'Cannot find module expo/config'
      })
    })
    expect(await failing.of({ worktreeRoot: root, appId: 'app', app: APP })).toEqual({
      ok: false,
      message: 'the fingerprint command exited 1: Cannot find module expo/config'
    })
    const silent = createSimFingerprints({
      shell: async () => ({ ok: true, code: 0, stdout: 'done', stderr: '' })
    })
    expect(await silent.of({ worktreeRoot: root, appId: 'app', app: APP })).toMatchObject({
      ok: false
    })
  })
})
