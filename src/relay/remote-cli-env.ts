export function pickRemoteCliEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const picked: Record<string, string> = {}
  for (const key of [
    'POD_TERMINAL_HANDLE',
    'POD_WORKTREE_ID',
    'POD_PANE_KEY',
    'POD_AGENT_LAUNCH_TOKEN',
    'POD_WORKSPACE_ID',
    'POD_USER_DATA_PATH',
    'PATH',
    'Path'
  ]) {
    const value = env[key]
    if (typeof value === 'string') {
      picked[key] = value
    }
  }
  return picked
}
