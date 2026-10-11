import { existsSync } from 'node:fs'
import { runProcess } from '@orca/process-host'
import type { ProcessResult } from '@orca/process-host/process-spec'

const TASKPOLICY_PATH = '/usr/sbin/taskpolicy'

/** How a daemon-host tool runs: at background priority off the spawn path, stopped when the app quits. */
export type HostToolMode = { background?: boolean; signal?: AbortSignal }

// Why background: the deferred clone and prune must not compete with terminal attach after an update;
// a spawn waiting for its clone keeps the default priority.
export function runHostTool(
  program: string,
  args: string[],
  timeoutMs: number,
  mode: HostToolMode = {}
): Promise<ProcessResult> {
  const background = mode.background === true && existsSync(TASKPOLICY_PATH)
  return runProcess({
    program: background ? TASKPOLICY_PATH : program,
    args: background ? ['-b', program, ...args] : args,
    timeoutMs,
    ...(mode.signal ? { signal: mode.signal } : {})
  })
}
