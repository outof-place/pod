import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type {
  PodAdoptRecord,
  PodTidyArchive,
  PodTidyTrashed,
  PodTuneRecord
} from '../../../shared/pod-workspace-tidy-types'

/** What Pod changed in the workspace, kept so each change can be undone. */
export type WorkspaceJournalData = {
  archives: PodTidyArchive[]
  trashed: PodTidyTrashed[]
  adoptions: PodAdoptRecord[]
  tunes: PodTuneRecord[]
}

// Pod alone writes this file; a list an older Pod lacks, or one that doesn't parse, starts empty.
const JournalFile = z.object({
  archives: z.array(z.custom<PodTidyArchive>()).catch([]),
  trashed: z.array(z.custom<PodTidyTrashed>()).catch([]),
  adoptions: z.array(z.custom<PodAdoptRecord>()).catch([]),
  tunes: z.array(z.custom<PodTuneRecord>()).catch([])
})

function normalize(value: unknown): WorkspaceJournalData {
  return JournalFile.catch({ archives: [], trashed: [], adoptions: [], tunes: [] }).parse(value)
}

export function createWorkspaceJournal(path: string) {
  let queue: Promise<unknown> = Promise.resolve()

  const read = async (): Promise<WorkspaceJournalData> => {
    try {
      return normalize(JSON.parse(await readFile(path, 'utf8')))
    } catch {
      return normalize(null)
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

/** The workspace state dir: the journal lives in the runtime profile, beside its other state. */
export function workspaceJournalPath(userDataDir: string): string {
  return join(userDataDir, 'pod-workspace', 'journal.json')
}
