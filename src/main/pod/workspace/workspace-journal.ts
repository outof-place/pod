import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { PodAdoptRecord, PodTidyArchive } from '../../../shared/pod-workspace-tidy-types'

/** What Pod changed in the workspace, kept so each change can be undone. */
export type WorkspaceJournalData = { archives: PodTidyArchive[]; adoptions: PodAdoptRecord[] }

const EMPTY: WorkspaceJournalData = { archives: [], adoptions: [] }

function isJournal(value: unknown): value is WorkspaceJournalData {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray(Reflect.get(value, 'archives')) &&
    Array.isArray(Reflect.get(value, 'adoptions'))
  )
}

export function createWorkspaceJournal(path: string) {
  let queue: Promise<unknown> = Promise.resolve()

  const read = async (): Promise<WorkspaceJournalData> => {
    try {
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
      return isJournal(parsed) ? parsed : { ...EMPTY }
    } catch {
      return { archives: [], adoptions: [] }
    }
  }

  /** Serialized read-modify-write; the file is replaced by rename so a crash leaves the old one. */
  const update = <T>(change: (data: WorkspaceJournalData) => T): Promise<T> => {
    const run = queue.then(async () => {
      const data = await read()
      const result = change(data)
      await mkdir(dirname(path), { recursive: true })
      const temp = `${path}.${process.pid}.tmp`
      await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
      await rename(temp, path)
      return result
    })
    queue = run.catch(() => undefined)
    return run
  }

  return { read, update }
}

export type WorkspaceJournal = ReturnType<typeof createWorkspaceJournal>

export function workspaceJournalPath(userDataDir: string): string {
  return join(userDataDir, 'pod-workspace', 'journal.json')
}
