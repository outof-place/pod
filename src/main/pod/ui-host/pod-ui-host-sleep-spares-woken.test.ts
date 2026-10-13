// Fork-only (Pod): Close Terminals with the one-app window open, and a tab the user shows before the
// window's sleep is done. Its new PTY must outlive the runtime's part of that sleep (gate 4: the
// runtime stopped it again, and the shown tab's wake waited ~1 s behind that).
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }))

import { withDurableRuntimeStore } from '../../runtime/runtime-durable-store-fixture'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { FOLDER_WORKSPACE_INSTANCE_SEPARATOR } from '../../../shared/worktree/id'
import { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { sleepPodUiHostRuntimeTerminals } from './pod-ui-host-sleep'
import { beginPodUiHostWindowSleep, endPodUiHostWindowSleep } from './pod-ui-host-sleep-hold'

const REPO_ID = 'repo-1'
const FOLDER_PATH = '/tmp/pod-window-sleep'
const WORKTREE = `${REPO_ID}::${FOLDER_PATH}${FOLDER_WORKSPACE_INSTANCE_SEPARATOR}aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`
const BEFORE = `${WORKTREE}@@before`
const WOKEN = `${WORKTREE}@@woken`

function makeRuntime() {
  const meta: Record<string, Record<string, unknown>> = { [WORKTREE]: { hostId: 'local' } }
  const repo = {
    id: REPO_ID,
    path: FOLDER_PATH,
    displayName: 'pod-window-sleep',
    badgeColor: 'blue',
    addedAt: 1,
    kind: 'folder'
  } as const
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the store stub carries what the sleep transaction reads; the rest of Store is unreached.
  const store = withDurableRuntimeStore({
    getRepos: () => [repo],
    getRepo: (id: string) => (id === REPO_ID ? repo : undefined),
    getAllWorktreeMeta: () => meta,
    getWorktreeMeta: (worktreeId: string) => meta[worktreeId],
    setWorktreeMeta: (worktreeId: string, patch: Record<string, unknown>) => {
      meta[worktreeId] = { ...meta[worktreeId], ...patch }
      return meta[worktreeId]
    },
    getWorkspaceSession: () => getDefaultWorkspaceSession(),
    setWorkspaceSession: () => {},
    flushOrThrow: () => {}
  }) as never
  const runtime = new OrcaRuntimeService(store)
  const live = new Set([BEFORE])
  const stopped: string[] = []
  let onList: () => void = () => {}
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    stopAndWait: async (ptyId: string) => {
      stopped.push(ptyId)
      live.delete(ptyId)
      runtime.onPtyExit(ptyId, -1)
      return true
    },
    getForegroundProcess: async () => null,
    listProcesses: async () => {
      onList()
      return [...live].map((id) => ({ id, worktreeId: WORKTREE, cwd: FOLDER_PATH, title: 'zsh' }))
    }
  } as never)
  runtime.registerPty(BEFORE, WORKTREE)
  const wake = (): void => {
    live.add(WOKEN)
    runtime.registerPty(WOKEN, WORKTREE)
  }
  return { runtime, stopped, wake, whenListed: (run: () => void) => (onList = run) }
}

describe("the runtime's part of a one-app window's sleep", () => {
  afterEach(() => endPodUiHostWindowSleep(WORKTREE))

  it('stops what was live when the sleep began, and spares a tab the user woke during it', async () => {
    const { runtime, stopped, wake } = makeRuntime()
    beginPodUiHostWindowSleep(WORKTREE)
    // The user shows another tab while the renderer still stops its panes.
    wake()

    await sleepPodUiHostRuntimeTerminals(runtime, WORKTREE, true)

    expect(stopped).toEqual([BEFORE])
  })

  it('spares a tab woken while the runtime reads the process table (gate 4 round 2)', async () => {
    const { runtime, stopped, wake, whenListed } = makeRuntime()
    beginPodUiHostWindowSleep(WORKTREE)
    whenListed(() => {
      whenListed(() => {})
      wake()
    })

    await sleepPodUiHostRuntimeTerminals(runtime, WORKTREE, true)

    expect(stopped).toEqual([BEFORE])
  })

  it('spares nothing for a spawn after the sleep ended', async () => {
    const { runtime, stopped, wake } = makeRuntime()
    beginPodUiHostWindowSleep(WORKTREE)
    endPodUiHostWindowSleep(WORKTREE)
    wake()
    beginPodUiHostWindowSleep(WORKTREE)

    await sleepPodUiHostRuntimeTerminals(runtime, WORKTREE, true)

    expect(stopped.sort()).toEqual([BEFORE, WOKEN].sort())
  })
})
