import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { NativeProcessRow, NativeTerminalProcessRow } from '../shared/native-process-info'
import type { WorkerThreadFactory } from './lazy-worker-thread-host'
import { currentWorkerEntryLayout, resolveWorkerThreadEntryPath } from './worker-thread-entry-path'
import { WorkerThreadRequestQueue } from './worker-thread-request-queue'
import type {
  NativeProcessSnapshotRequest,
  NativeProcessSnapshotResponse
} from './native-process-snapshot-protocol'

export const NATIVE_PROCESS_SNAPSHOT_ENTRY_FILENAME = 'native-process-snapshot-worker-entry.js'

export function nativeProcessSnapshotWorkerFactory(addonPath: string): WorkerThreadFactory {
  return () => {
    const layout = currentWorkerEntryLayout(__dirname)
    const workerPath = resolveWorkerThreadEntryPath(
      {
        ...layout,
        isPackaged:
          layout.isPackaged ||
          (layout.resourcesPath !== undefined && existsSync(join(layout.resourcesPath, 'app.asar')))
      },
      NATIVE_PROCESS_SNAPSHOT_ENTRY_FILENAME
    )
    if (!existsSync(workerPath)) {
      throw new Error(`Native process snapshot worker entry not found: ${workerPath}`)
    }
    return new Worker(workerPath, { workerData: addonPath })
  }
}

/** Kernel table and argv reads can block for seconds on the first TTY-name lookup. */
export class NativeProcessSnapshotClient {
  private readonly requests: WorkerThreadRequestQueue<
    NativeProcessSnapshotRequest,
    NativeProcessSnapshotResponse
  >

  constructor(factory: WorkerThreadFactory) {
    this.requests = new WorkerThreadRequestQueue({
      factory,
      idleTeardownMs: 5 * 60_000,
      maxConsecutiveDeaths: 2,
      queueCap: {
        maxQueuedCalls: 4,
        describeFull: () => 'Native process snapshot queue is full'
      },
      awaitRetirement: true,
      createUnavailableError: (message) => new Error(message),
      describeTimeout: (ms) => `Native process snapshot timed out after ${ms}ms`,
      describeExit: (code) => `Native process snapshot worker exited with code ${code}`,
      describeCrashLoop: (error) => `Native process snapshot worker failed repeatedly: ${error}`,
      onUnavailable: () => {}
    })
  }

  async listProcesses(): Promise<NativeProcessRow[]> {
    const response = await this.capture('cheap')
    if (response.kind !== 'cheap') {
      throw new Error('Native process snapshot returned the wrong column set')
    }
    return response.rows
  }

  async listProcessesWithCommands(): Promise<NativeTerminalProcessRow[]> {
    const response = await this.capture('full')
    if (response.kind !== 'full') {
      throw new Error('Native process snapshot returned the wrong column set')
    }
    return response.rows
  }

  dispose(): void {
    this.requests.dispose()
  }

  private async capture(kind: 'cheap' | 'full') {
    const response = await this.requests.dispatch((id) => ({ id, kind }), 15_000)
    if (!response.ok) {
      throw new Error(response.error)
    }
    return response
  }
}
