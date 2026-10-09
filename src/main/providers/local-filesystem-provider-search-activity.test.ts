import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import {
  setExternalWorkspaceSearchProvider,
  type ExternalWorkspaceSearchProvider
} from '../search/external-workspace-search-provider'
import { createLocalFilesystemProvider } from './local-filesystem-provider'

let root: string
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: writeFile reads nothing from the store; authorization is the injected stub.
const store = { getSettings: () => ({}) } as unknown as Store

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-local-fs-search-activity-'))
})
afterEach(async () => {
  setExternalWorkspaceSearchProvider(null)
  await rm(root, { recursive: true, force: true })
})

it('tells the search index about a runtime save, with the authorized path', async () => {
  const fileActivity = vi.fn()
  const index: ExternalWorkspaceSearchProvider = {
    listFiles: async () => null,
    searchFilePaths: async () => null,
    searchText: async () => null,
    supportsRankedPathSearch: async () => false,
    worktreeAdded: () => undefined,
    worktreeRemoved: () => undefined,
    fileActivity
  }
  setExternalWorkspaceSearchProvider(index)
  const authorized = join(root, 'saved.ts')
  const provider = createLocalFilesystemProvider({
    requireStore: () => store,
    resolveAuthorizedPath: async () => authorized
  })
  await provider.writeFile(join(root, 'link', 'saved.ts'), 'export {}\n')
  expect(await readFile(authorized, 'utf8')).toBe('export {}\n')
  expect(fileActivity.mock.calls).toEqual([[{ filePath: authorized, kind: 'write' }]])
})
