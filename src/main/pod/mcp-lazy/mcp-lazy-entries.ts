// Fork-only (Pod): wrapping a stdio MCP server of ~/.claude.json in mcp-lazy and back. The wrapped
// entry needs no Pod: `sh -c` runs the shim when present, else the original command, which rides in
// the wrapper's arguments so unwrapping restores it exactly.
import { basename } from 'node:path'

/** One `mcpServers` entry as Claude Code keeps it; unknown keys ride along untouched. */
export type McpServerEntry = {
  type?: unknown
  command?: unknown
  args?: unknown
  env?: unknown
  [key: string]: unknown
}

export type McpLazySetting = { enabled: boolean; servers: string[] }

export type McpLazyPlan = {
  /** Plain entries to put behind the shim. */
  wrap: string[]
  /** Wrapped entries to give back their own command. */
  unwrap: string[]
}

const SHELL = '/bin/sh'
// Why no `${`: Claude Code expands `${VAR}` and `${VAR:-default}` anywhere in an MCP entry.
const SCRIPT_TAIL = '; [ -x "$s" ] && exec "$s" "$0" -- "$@"; exec "$@"'
const SCRIPT = /^s='((?:[^']|'\\'')*)'; \[ -x "\$s" \] && exec "\$s" "\$0" -- "\$@"; exec "\$@"$/

/** Launchers whose servers bring a whole runtime per session (node, Python, a JVM, a container). */
const HEAVY_LAUNCHERS = new Set([
  'npx',
  'node',
  'nodejs',
  'bun',
  'bunx',
  'deno',
  'npm',
  'pnpm',
  'yarn',
  'uv',
  'uvx',
  'python',
  'python3',
  'pipx',
  'ruby',
  'java',
  'docker',
  'podman'
])
const HEAVY_SCRIPT = /\.(?:c|m)?js$|\.ts$|\.py$|\.jar$/

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null
}

function quote(path: string): string {
  return `'${path.replaceAll("'", "'\\''")}'`
}

/** The `sh -c` script that runs `shimPath` when it can and the original command otherwise. */
export function wrapScript(shimPath: string): string {
  if (shimPath.includes('${')) {
    throw new Error(`mcp-lazy: ${shimPath} would be expanded by Claude Code`)
  }
  return `s=${quote(shimPath)}${SCRIPT_TAIL}`
}

/** The shim path a wrapped entry names, or null for any other entry. */
export function wrappedShimPath(entry: McpServerEntry): string | null {
  const args = stringArray(entry.args)
  if (entry.command !== SHELL || !args || args.length < 4 || args[0] !== '-c') {
    return null
  }
  const match = SCRIPT.exec(args[1])
  return match ? match[1].replaceAll("'\\''", "'") : null
}

export function isWrapped(entry: McpServerEntry): boolean {
  return wrappedShimPath(entry) !== null
}

/** A stdio server with a command of its own: the only kind a shim can stand in for. */
export function isWrappable(entry: McpServerEntry): boolean {
  if (isWrapped(entry)) {
    return false
  }
  const stdio = entry.type === undefined || entry.type === 'stdio'
  return (
    stdio &&
    typeof entry.command === 'string' &&
    entry.command !== '' &&
    (entry.args === undefined || stringArray(entry.args) !== null)
  )
}

/** The command line the entry runs, wrapped or not. */
export function originalCommand(entry: McpServerEntry): { command: string; args: string[] } | null {
  if (isWrapped(entry)) {
    const args = stringArray(entry.args) ?? []
    return { command: args[3], args: args.slice(4) }
  }
  return typeof entry.command === 'string'
    ? { command: entry.command, args: stringArray(entry.args) ?? [] }
    : null
}

export function wrapEntry(name: string, entry: McpServerEntry, shimPath: string): McpServerEntry {
  const original = originalCommand(entry)
  if (!original || !isWrappable(entry)) {
    throw new Error(`mcp-lazy: ${name} is not a plain stdio server`)
  }
  return {
    ...entry,
    type: 'stdio',
    command: SHELL,
    args: ['-c', wrapScript(shimPath), name, original.command, ...original.args]
  }
}

export function unwrapEntry(entry: McpServerEntry): McpServerEntry {
  const original = originalCommand(entry)
  if (!original || !isWrapped(entry)) {
    return entry
  }
  return { ...entry, command: original.command, args: original.args }
}

/** Whether the server likely costs a runtime per session (the one-time hint and the badge). */
export function isHeavy(entry: McpServerEntry): boolean {
  const original = originalCommand(entry)
  if (!original) {
    return false
  }
  return (
    HEAVY_LAUNCHERS.has(basename(original.command)) ||
    original.args.some((arg) => HEAVY_SCRIPT.test(arg)) ||
    HEAVY_SCRIPT.test(original.command)
  )
}

/**
 * What to change in `servers` for `setting`. At startup only wraps: two Pods with different
 * settings (a dev build, another profile) would otherwise undo each other at every launch. A
 * change of the setting also unwraps what it no longer names, or everything when it is off.
 */
export function planMcpLazy(
  servers: Readonly<Record<string, McpServerEntry>>,
  setting: McpLazySetting,
  shimPath: string,
  moment: 'startup' | 'change'
): McpLazyPlan {
  const chosen = new Set(setting.enabled ? setting.servers : [])
  const wrap: string[] = []
  const unwrap: string[] = []
  for (const [name, entry] of Object.entries(servers)) {
    const shim = wrappedShimPath(entry)
    if (chosen.has(name)) {
      if (shim === null && isWrappable(entry)) {
        wrap.push(name)
      } else if (shim !== null && shim !== shimPath) {
        // Wrapped by another install (the shim moved): unwrap, then wrap with this one.
        unwrap.push(name)
        wrap.push(name)
      }
    } else if (shim !== null && moment === 'change') {
      unwrap.push(name)
    }
  }
  return { wrap, unwrap }
}

/** The entry each name should have once `plan` is applied. */
export function plannedEntries(
  servers: Readonly<Record<string, McpServerEntry>>,
  plan: McpLazyPlan,
  shimPath: string
): Record<string, McpServerEntry> {
  const out: Record<string, McpServerEntry> = {}
  for (const name of new Set([...plan.unwrap, ...plan.wrap])) {
    let entry = servers[name]
    if (plan.unwrap.includes(name)) {
      entry = unwrapEntry(entry)
    }
    if (plan.wrap.includes(name)) {
      entry = wrapEntry(name, entry, shimPath)
    }
    out[name] = entry
  }
  return out
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function normalizeMcpLazySetting(value: unknown): McpLazySetting {
  const record = isRecord(value) ? value : {}
  const servers = stringArray(record.servers) ?? []
  return {
    enabled: record.enabled === true,
    servers: [...new Set(servers.filter((name) => name !== '' && name.length <= 256))].slice(0, 64)
  }
}
