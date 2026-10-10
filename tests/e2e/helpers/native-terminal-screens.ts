import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect } from './orca-app'
import { nativeScreenText } from './native-terminal-debug'

function normalizeScreen(text: string): string {
  const rows = text.split('\n').map((row) => row.trimEnd())
  while (rows.length > 0 && rows.at(-1) === '') {
    rows.pop()
  }
  return rows.join('\n')
}

// The xterm model's visible rows, as the native view should show them.
function xtermScreen(page: Page, ptyId: string): Promise<string> {
  return page.evaluate((id) => {
    const pane = [...(window.__paneManagers?.values() ?? [])]
      .flatMap((manager) => manager.getPanes())
      .find((candidate) => candidate.container.dataset.ptyId === id)
    if (!pane) {
      return ''
    }
    const buffer = pane.terminal.buffer.active
    const rows: string[] = []
    for (let y = buffer.viewportY; y < buffer.viewportY + pane.terminal.rows; y += 1) {
      const line = buffer.getLine(y)
      const text = line?.translateToString(true) ?? ''
      // Ghostty's screen text joins soft-wrapped rows into one logical line.
      if (line?.isWrapped && rows.length > 0) {
        rows[rows.length - 1] += text
      } else {
        rows.push(text)
      }
    }
    return rows.join('\n')
  }, ptyId)
}

// Whitespace-blind: the two disagree on which rows are soft-wrapped when a shell wraps its own
// prompt, while every visible character must still match in order.
export async function expectNativeScreenMatchesXterm(
  page: Page,
  app: ElectronApplication,
  ptyId: string,
  surfaceId: number
): Promise<void> {
  await expect
    .poll(
      async () => {
        const native = normalizeScreen(await nativeScreenText(app, surfaceId))
        const xterm = normalizeScreen(await xtermScreen(page, ptyId))
        return native.replace(/\s+/g, '') === xterm.replace(/\s+/g, '')
          ? 'identical'
          : `native:\n${native}\nxterm:\n${xterm}`
      },
      { timeout: 15_000 }
    )
    .toBe('identical')
}
