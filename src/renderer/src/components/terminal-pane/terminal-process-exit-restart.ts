import type { PaneProcessExit, PtyPaneStartup } from './pty-connection-types'

export function resolveTerminalProcessExitRestartStartup(
  processExit: PaneProcessExit
): PtyPaneStartup {
  return processExit.reason === 'git-bash-console-capacity' ? processExit.startup : null
}

/** Fork-only (Pod): only a restart that names no startup (Codex's account switch) starts Codex; an
 *  exit restart's null is a plain shell, which `??` would have turned into Codex too. */
export function resolvePaneRestartStartup(
  restartStartup: PtyPaneStartup | undefined,
  codexStartup: () => PtyPaneStartup
): PtyPaneStartup {
  return restartStartup === undefined ? codexStartup() : restartStartup
}
