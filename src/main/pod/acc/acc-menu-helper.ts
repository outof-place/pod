import type { ProcessResult, ProcessSpec } from '../../../shared/child-process/run-process'

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

/**
 * Puts the bundled helper's new binary to work after an update: a login item launchd already
 * runs keeps its old process through a re-registration, so it is ended and opened again.
 */
export async function restartAccMenuHelper(
  run: (spec: ProcessSpec) => Promise<ProcessResult>,
  helperApp: string
): Promise<void> {
  await run({ program: '/usr/bin/pkill', args: ['-x', ACC_MENU_HELPER_PROCESS], timeoutMs: 5000 })
  // -g: in the background, Pod keeps the focus
  await run({ program: '/usr/bin/open', args: ['-g', helperApp], timeoutMs: 10_000 })
}
