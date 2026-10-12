// Fork-only (Pod): what a stdio MCP server costs per Claude session, read off the copies running
// now: the server processes under each `claude` process, with their children (npx's node), by
// physical footprint (top's MEM, which counts compressed pages that RSS leaves out).
import { basename } from 'node:path'
import { runProcess } from '@orca/process-host'
import { isWrapped, originalCommand, type McpServerEntry } from './mcp-lazy-entries'

export type McpServerCost = { megabytes: number; sessions: number }

type Proc = { pid: number; ppid: number; command: string }

const LAUNCHERS = new Set([
  'npx',
  'node',
  'nodejs',
  'bun',
  'bunx',
  'deno',
  'uv',
  'uvx',
  'python',
  'python3',
  'pipx'
])

/** What a server's process command line contains: the package or script a launcher runs, else the binary. */
export function serverNeedle(entry: McpServerEntry): string | null {
  const original = originalCommand(entry)
  if (!original) {
    return null
  }
  if (LAUNCHERS.has(basename(original.command))) {
    const target = original.args.find(
      (arg) => !arg.startsWith('-') && arg !== 'run' && arg !== 'exec'
    )
    return target ? basename(target).replace(/(.)@[^@/]*$/, '$1') : null
  }
  return basename(original.command)
}

export function parseProcessTable(text: string): Proc[] {
  const out: Proc[] = []
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (match) {
      out.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] })
    }
  }
  return out
}

/** top's MEM column (`102M`, `7660K`, `1.2G`, with a trailing `+`/`-`) in megabytes. */
export function parseTopMemory(text: string): Map<number, number> {
  const out = new Map<number, number>()
  const units: Record<string, number> = { B: 1 / 1048576, K: 1 / 1024, M: 1, G: 1024 }
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+([\d.]+)([BKMG])[+-]?\s*$/.exec(line)
    if (match) {
      out.set(Number(match[1]), Number(match[2]) * units[match[3]])
    }
  }
  return out
}

function descendants(procs: Proc[], root: number): number[] {
  const out = [root]
  for (let i = 0; i < out.length; i++) {
    for (const proc of procs) {
      if (proc.ppid === out[i]) {
        out.push(proc.pid)
      }
    }
  }
  return out
}

/** The servers' cost per Claude session now running them; servers with no running copy are left out. */
export async function measureMcpServers(
  servers: Readonly<Record<string, McpServerEntry>>
): Promise<Record<string, McpServerCost>> {
  if (process.platform !== 'darwin') {
    return {}
  }
  const table = await runProcess({
    program: '/bin/ps',
    args: ['-axww', '-o', 'pid=,ppid=,command='],
    timeoutMs: 10_000,
    maxOutputBytes: 8 << 20
  })
  const procs = parseProcessTable(table.stdout)
  const sessions = procs.filter((proc) => basename(proc.command.split(' ')[0]) === 'claude')
  const trees = new Map<string, number[][]>()
  for (const [name, entry] of Object.entries(servers)) {
    const needle = isWrapped(entry) ? null : serverNeedle(entry)
    if (!needle) {
      continue
    }
    for (const session of sessions) {
      const server = procs.find(
        (proc) => proc.ppid === session.pid && proc.command.includes(needle)
      )
      if (server) {
        trees.set(name, [...(trees.get(name) ?? []), descendants(procs, server.pid)])
      }
    }
  }
  const pids = [...trees.values()].flat(2)
  if (pids.length === 0) {
    return {}
  }
  const top = await runProcess({
    program: '/usr/bin/top',
    args: ['-l', '1', '-stats', 'pid,mem', ...pids.flatMap((pid) => ['-pid', String(pid)])],
    timeoutMs: 15_000,
    maxOutputBytes: 1 << 20
  })
  const memory = parseTopMemory(top.stdout)
  const out: Record<string, McpServerCost> = {}
  for (const [name, perSession] of trees) {
    const totals = perSession.map((tree) =>
      tree.reduce((sum, pid) => sum + (memory.get(pid) ?? 0), 0)
    )
    out[name] = {
      megabytes: Math.round(totals.reduce((a, b) => a + b, 0) / totals.length),
      sessions: totals.length
    }
  }
  return out
}
