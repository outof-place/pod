import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { OgdClient } from './ogd-client'
import { startOgdMockServer, type OgdMockServer } from './ogd-mock-server'
import { readOgdIndexStatus } from './pod-search-index-status'

let base: string
let mock: OgdMockServer | null = null
let client: OgdClient | null = null

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'pod-index-status-')))
  mkdirSync(join(base, 'repo'))
  mkdirSync(join(base, 'building'))
  symlinkSync(join(base, 'repo'), join(base, 'repo-link'))
})

afterEach(async () => {
  client?.close()
  await mock?.close()
  rmSync(base, { recursive: true, force: true })
})

it('reports a root from ogd status by realpath, and null for roots ogd does not hold', async () => {
  mock = await startOgdMockServer({
    handle: () => ({
      message: {
        worktrees: [
          // Still building, with no pending events yet: not settled.
          { root: join(base, 'building'), state: 'building', unsettled: null },
          {
            root: join(base, 'repo'),
            state: 'ready',
            docs: 18_602,
            generation: 4,
            unsettled: null,
            build_ms: 912
          }
        ]
      }
    })
  })
  client = new OgdClient({ socketPath: mock.socketPath, client: 'orca/test', timeoutMs: 500 })
  expect(await readOgdIndexStatus(client, join(base, 'repo-link'))).toEqual({
    state: 'ready',
    docs: 18_602,
    generation: 4,
    settled: true,
    buildMs: 912
  })
  expect(await readOgdIndexStatus(client, join(base, 'building'))).toMatchObject({
    state: 'building',
    settled: false
  })
  expect(await readOgdIndexStatus(client, base)).toBeNull()
  expect(await readOgdIndexStatus(client, join(base, 'missing'))).toBeNull()
})
