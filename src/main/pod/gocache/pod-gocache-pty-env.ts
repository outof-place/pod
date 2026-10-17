// A local terminal's GOCACHEPROG. Its own module: the PTY env assembly imports it, and nothing of
// the install lifecycle comes with it.
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { podGoCacheHelperPath } from './pod-gocache-paths'
import {
  POD_GOCACHE_ENV,
  isPodGoCacheOff,
  isPodGoCacheTerminalEnvOptedIn
} from './pod-gocache-switch'

// Off until a runtime that runs the install lifecycle hands over the setting (installPodGoCache):
// orcad and unit tests never inject a machine-dependent GOCACHEPROG.
let settingOn: () => boolean = () => false

/** installPodGoCache hands over the setting's reader. */
export function setPodGoCacheSettingReader(isOn: () => boolean): void {
  settingOn = isOn
}

/** One field of cmd/internal/quoted.Split: bare, or in quotes it cannot contain. */
function goQuotedField(value: string): string | null {
  if (!/[\s'"]/.test(value)) {
    return value
  }
  if (!value.includes("'")) {
    return `'${value}'`
  }
  return value.includes('"') ? null : `"${value}"`
}

/**
 * go starts the helper for every command, and a missing one is fatal to each (cache/prog.go).
 * Never throws: a folder it cannot read must cost the terminal its GOCACHEPROG, not its spawn.
 */
function isRunnable(path: string): boolean {
  try {
    const stat = statSync(path, { throwIfNoEntry: false })
    return stat?.isFile() === true && (stat.mode & 0o111) !== 0
  } catch {
    return false
  }
}

/** GOCACHEPROG for a local macOS terminal only (never WSL; SSH never reaches the assembly); any value Pod did not set is the user's and wins. */
export function applyPodGoCachePtyEnv(env: Record<string, string>, opts: { isWsl: boolean }): void {
  const helper = podGoCacheHelperPath(homedir())
  const field = goQuotedField(helper)
  const value = field === null ? null : `${field} prog`
  // daemon-backed spawns pass only overrides here; the PTY inherits the rest from Pod's env
  const inherited = env.GOCACHEPROG ?? process.env.GOCACHEPROG
  if (inherited !== undefined && inherited !== value) {
    return
  }
  const on =
    value !== null &&
    process.platform === 'darwin' &&
    !opts.isWsl &&
    isPodGoCacheTerminalEnvOptedIn(process.env) &&
    !isPodGoCacheOff(process.env[POD_GOCACHE_ENV]) &&
    settingOn() &&
    isRunnable(helper)
  if (on) {
    env.GOCACHEPROG = value
  } else if (env.GOCACHEPROG !== undefined) {
    delete env.GOCACHEPROG
  }
}
