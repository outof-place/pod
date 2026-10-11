// Fork-only (Pod): the one-app runtime's log. POD_UI_HOST_LOG=<file>: a runtime LaunchServices
// started has no stdout; E2Es read this instead.
import { appendFileSync } from 'node:fs'

export function podUiHostLog(message: string): void {
  console.log(`[pod] ${message}`)
  const logFile = process.env.POD_UI_HOST_LOG
  if (logFile) {
    try {
      appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`)
    } catch {
      // A log that can't be written is no reason to stop.
    }
  }
}
