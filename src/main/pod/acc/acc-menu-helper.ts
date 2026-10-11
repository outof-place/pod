import type { ProcessResult, ProcessSpec } from '@orca/process-host/process-spec'

// The claude-acc menu bar app; while it runs, Pod's own tray icon would be a second ring.
export const ACC_MENU_HELPER_PROCESS = 'ClaudeAcc'

export async function isAccMenuHelperRunning(
  run: (spec: ProcessSpec) => Promise<ProcessResult>
): Promise<boolean> {
  try {
    const result = await run({
      program: '/usr/bin/pgrep',
      args: ['-x', ACC_MENU_HELPER_PROCESS],
      timeoutMs: 5000
    })
    return result.code === 0
  } catch {
    return false
  }
}
