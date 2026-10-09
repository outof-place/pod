import { e2eConfig } from '@/lib/e2e-config'

// E2E-only seam: writes a session notice into a pane the way Orca does, at a moment the test
// picks (real notices come at moments a test can't steer).
const writers = new Map<string, (text: string) => void>()

export function registerE2eTerminalSessionNotice(
  ptyId: string,
  write: (text: string) => void
): void {
  if (!e2eConfig.exposeStore || typeof window === 'undefined') {
    return
  }
  writers.set(ptyId, write)
  if (!Reflect.has(window, '__terminalSessionNotice')) {
    Reflect.set(window, '__terminalSessionNotice', {
      write: (id: string, text: string): boolean => {
        const writer = writers.get(id)
        writer?.(text)
        return writer !== undefined
      }
    })
  }
}
