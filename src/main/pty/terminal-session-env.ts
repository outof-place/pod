// Fork-only (Pod): a runtime started from Terminal.app inherits that window's TERM_SESSION_ID (and
// SHELL_SESSION_* where exported). Its terminals and its login-shell probe would then restore and
// save that Terminal window's session (~/.zsh_sessions) and history at every shell exit. They
// aren't Pod's: dropped like an inherited NO_COLOR.
export function removeInheritedTerminalSessionEnv(env: Record<string, string | undefined>): void {
  delete env.TERM_SESSION_ID
  for (const key of Object.keys(env)) {
    if (key.startsWith('SHELL_SESSION_')) {
      delete env[key]
    }
  }
}
