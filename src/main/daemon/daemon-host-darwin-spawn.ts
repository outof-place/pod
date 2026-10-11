import type { RelocatedDaemonHost } from './daemon-host-relocation'
import { materializeDarwinDaemonHost } from './daemon-host-darwin-clone'
import { reportDaemonHost } from './daemon-host-darwin-report'

// Why a budget: a slow disk must not hold the first terminal past the startup gate; the clone
// still finishes in the background for the next spawn.
const SPAWN_BUDGET_MS = 8_000

/** The clone for a daemon about to fork, or null (fork from the bundle) once the budget runs out. */
export async function darwinDaemonHostForSpawn(
  entryPath: string,
  budgetMs = SPAWN_BUDGET_MS
): Promise<RelocatedDaemonHost | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const budget = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), budgetMs)
  })
  try {
    const host = await Promise.race([materializeDarwinDaemonHost(entryPath), budget])
    if (host === 'late') {
      reportDaemonHost(
        'bundle',
        `no clone within ${budgetMs} ms; forking this daemon from the app bundle`
      )
      return null
    }
    return host
  } finally {
    clearTimeout(timer)
  }
}
