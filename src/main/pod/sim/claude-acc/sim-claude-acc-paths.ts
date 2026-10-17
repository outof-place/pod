// Fork-only (Pod): where claude-acc keeps what the pool reads and writes: its executable, its
// guard's state file and the lease directory its guard reads (devguard.json `simulator_leases`,
// default portivo-mobile's; janitor.expand resolves `~`).
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveExecutableCommand } from '../../../../shared/node-cli-command-resolution'

export type ClaudeAccPaths = Readonly<{
  binary: string | null
  stateFile: string
  configFile: string
}>

export function claudeAccPaths(home: string = homedir()): ClaudeAccPaths {
  const state = join(home, '.local', 'share', 'claude-acc')
  return {
    binary: resolveExecutableCommand('claude-acc', { homePath: home }),
    stateFile: join(state, 'devguard-state.json'),
    configFile: join(state, 'devguard.json')
  }
}

export async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

/** The guard's lease directory: its config's `simulator_leases`, else portivo-mobile's. */
export async function claudeAccLeaseDirectory(
  paths: ClaudeAccPaths,
  home: string = homedir()
): Promise<string> {
  let configured: unknown
  try {
    configured = JSON.parse((await readTextOrNull(paths.configFile)) ?? '{}').simulator_leases
  } catch {
    configured = undefined
  }
  const raw =
    typeof configured === 'string' && configured !== ''
      ? configured
      : '~/.cache/portivo-mobile/leases'
  return raw === '~' || raw.startsWith('~/') ? join(home, raw.slice(1)) : raw
}
