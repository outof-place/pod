import { getNativeProcessInfo } from '../../../shared/native-process-info'
import type { PodTidyProcess } from '../../../shared/pod-workspace-tidy-types'
import { isPathInsideRoot } from './workspace-root-path'

export type ProcessCwdReader = {
  listPids(): Promise<number[]> | number[]
  readCwd(pid: number): string | null
  /** Names for the few pids that matched; empty when the kernel withholds them. */
  readNames(pids: readonly number[]): Promise<Map<number, string>>
}

export function createNativeProcessCwdReader(): ProcessCwdReader | null {
  const native = getNativeProcessInfo()
  if (!native) {
    return null
  }
  return {
    listPids: async () => (await native.listProcesses()).map((row) => row.pid),
    readCwd: (pid) => native.readProcessCwd(pid),
    readNames: async (pids) => {
      const wanted = new Set(pids)
      const names = new Map<number, string>()
      for (const row of await native.listProcessesWithCommands()) {
        if (wanted.has(row.pid)) {
          names.set(row.pid, row.name)
        }
      }
      return names
    }
  }
}

/**
 * Which processes have their working directory inside each folder: proc_pidinfo per pid, no
 * lsof. Another user's processes answer null and are skipped, so this is a lower bound.
 */
export async function findProcessesInside(
  reader: ProcessCwdReader,
  folders: readonly string[],
  ownPid: number = process.pid
): Promise<Map<string, PodTidyProcess[]>> {
  const byFolder = new Map<string, PodTidyProcess[]>(folders.map((folder) => [folder, []]))
  if (folders.length === 0) {
    return byFolder
  }
  const hits: { pid: number; folder: string }[] = []
  for (const pid of await reader.listPids()) {
    if (pid === ownPid || pid <= 1) {
      continue
    }
    const cwd = reader.readCwd(pid)
    if (!cwd) {
      continue
    }
    for (const folder of folders) {
      if (isPathInsideRoot(cwd, folder)) {
        hits.push({ pid, folder })
      }
    }
  }
  if (hits.length === 0) {
    return byFolder
  }
  const names = await reader.readNames(hits.map((hit) => hit.pid))
  for (const hit of hits) {
    byFolder.get(hit.folder)?.push({ pid: hit.pid, name: names.get(hit.pid) ?? '' })
  }
  return byFolder
}
