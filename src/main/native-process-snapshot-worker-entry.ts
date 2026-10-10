import { parentPort, workerData } from 'node:worker_threads'
import { loadNativeProcessInfoFrom } from '../shared/native-process-info'
import type {
  NativeProcessSnapshotRequest,
  NativeProcessSnapshotResponse
} from './native-process-snapshot-protocol'

if (!parentPort || typeof workerData !== 'string') {
  throw new Error('Native process snapshot worker requires an addon path and parent port')
}
const port = parentPort
const addon = loadNativeProcessInfoFrom(workerData)
if (!addon) {
  throw new Error('Native process snapshot addon could not be loaded')
}

port.on('message', (request: NativeProcessSnapshotRequest) => {
  let response: NativeProcessSnapshotResponse
  try {
    response =
      request.kind === 'cheap'
        ? { id: request.id, ok: true, kind: 'cheap', rows: addon.listProcesses() }
        : { id: request.id, ok: true, kind: 'full', rows: addon.listProcessesWithCommands() }
  } catch (error) {
    response = {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
  port.postMessage(response)
})
