// A dev runtime and the installed Pod on one Mac share builds.json and metro.json. A record this
// runtime cannot read (a newer Pod's state or shape) is skipped and kept as it is, never a reason
// to refuse the whole file.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { SimRuntime } from '../pool/sim-pool-ports'
import {
  appsFor,
  BUNDLE,
  DEVICE,
  eventually,
  fakeBuildCommand,
  fakeDevice,
  freeBase,
  sandbox,
  scriptedFingerprints,
  thisRuntime,
  worktree,
  writeLeases,
  type Sandbox
} from './sim-app.test-support'

let box: Sandbox
let self: SimRuntime

beforeEach(async () => {
  box = await sandbox()
  self = await thisRuntime()
})

afterEach(async () => {
  await box.cleanup()
})

describe.skipIf(process.platform !== 'darwin')('files a newer Pod wrote too', () => {
  it('skips the records it cannot read, keeps them on its own writes, and leaves their port alone', async () => {
    const base = await freeBase()
    const counter = join(box.dir, 'builds-run')
    const root = await worktree(box, 'wt-a', {
      app: [
        'fingerprint: fp',
        'build:',
        `  command: ${JSON.stringify(fakeBuildCommand('build/Pod.app', counter))}`,
        '  output: build/*.app',
        'metro:',
        `  port: ${base}`,
        '  command: "true"'
      ].join('\n')
    })
    // A newer Pod's build in a state this one does not know, and its Metro record in a new shape.
    const newerBuild = {
      buildId: 'sb_other_cafe_new',
      appId: 'other',
      bundleId: 'com.example.other',
      fingerprint: 'cafe',
      state: 'paused',
      startedAt: Date.now(),
      by: { pid: 1, startedAt: 1 },
      future: { anything: true }
    }
    const newerServer = {
      worktreeRoot: join(box.dir, 'wt-newer'),
      appId: 'app',
      port: base + 300,
      endpoint: { kind: 'unix' }
    }
    await mkdir(join(box.home.root, 'clients'), { recursive: true })
    await writeFile(
      join(box.home.root, 'clients', 'builds.json'),
      JSON.stringify({ version: 1, builds: [newerBuild] })
    )
    await writeFile(
      join(box.home.root, 'metro.json'),
      JSON.stringify({ version: 1, servers: [newerServer] })
    )
    await writeLeases(box.home, self, [{ worktreeRoot: root, appId: 'app', holds: DEVICE }])
    const finished: string[] = []
    const apps = appsFor(box, self, {
      device: fakeDevice(),
      shell: scriptedFingerprints().shell,
      metroGraceMs: 0,
      onBuildFinished: (buildId) => finished.push(buildId)
    })
    const answer = await apps.prepare({ worktreeRoot: root })
    expect(answer.ok && answer.client.state).toBe('building')
    // The newer record's port is taken: this worktree gets the next one.
    expect(answer.ok && answer.metro?.port).toBe(base + 301)
    expect(answer.ok && answer.metroProblem).toBeUndefined()
    // The build's last write is checked too, and nothing writes into the sandbox after the test.
    await eventually(
      async () => finished,
      (list) => list.length === 1
    )

    const builds = z
      .object({ builds: z.array(z.looseObject({ bundleId: z.string() })) })
      .parse(JSON.parse(await readFile(join(box.home.root, 'clients', 'builds.json'), 'utf8')))
    expect(builds.builds).toContainEqual(newerBuild)
    expect(builds.builds.map((build) => build.bundleId)).toContain(BUNDLE)
    const metro = z
      .object({ servers: z.array(z.unknown()) })
      .parse(JSON.parse(await readFile(join(box.home.root, 'metro.json'), 'utf8')))
    expect(metro.servers).toContainEqual(newerServer)
    expect(metro.servers).toHaveLength(2)
    expect((await apps.builds()).map((build) => build.buildId)).not.toContain(newerBuild.buildId)
  })
})
