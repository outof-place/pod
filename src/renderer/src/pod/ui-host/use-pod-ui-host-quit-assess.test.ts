import { describe, expect, it, vi } from 'vitest'

type RunningWork = { kind: 'none' | 'running' | 'unverifiable' }

const mocks = vi.hoisted(() => {
  const openFiles: { isDirty: boolean }[] = []
  const runningWork = vi.fn(async (): Promise<RunningWork> => ({ kind: 'none' }))
  return { openFiles, runningWork }
})

vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ openFiles: mocks.openFiles }) }
}))
vi.mock('@/components/terminal/window-close-running-work', () => ({
  assessWindowCloseRunningWork: mocks.runningWork
}))

const { assessPodUiHostQuit } = await import('./use-pod-ui-host-quit-assess')

describe('assessPodUiHostQuit', () => {
  it('counts dirty editor tabs and asks about remote work as a quit does', async () => {
    mocks.openFiles = [{ isDirty: true }, { isDirty: false }, { isDirty: true }]
    mocks.runningWork.mockResolvedValueOnce({ kind: 'unverifiable' })
    expect(await assessPodUiHostQuit()).toEqual({ unsavedFiles: 2, remoteWork: 'unverifiable' })
    expect(mocks.runningWork).toHaveBeenCalledWith({ isQuitting: true })
  })

  it('finds nothing to lose in a clean window', async () => {
    mocks.openFiles = []
    expect(await assessPodUiHostQuit()).toEqual({ unsavedFiles: 0, remoteWork: 'none' })
  })
})
