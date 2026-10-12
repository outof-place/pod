// Fork-only (Pod): the user-scope MCP servers of ~/.claude.json, read here and written in place,
// as Claude Code itself writes the file (or through its `claude mcp` CLI when the file isn't in that
// format). Entry env values are copied as they are and never logged.
import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { runProcess } from '@orca/process-host'
import type { McpServerEntry } from './mcp-lazy-entries'

const KEEP_BACKUPS = 5
const CLI_TIMEOUT_MS = 30_000

export function claudeJsonPath(home = homedir()): string {
  return join(home, '.claude.json')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The `mcpServers` of the user scope; {} when the file or the key is missing. */
export function readUserMcpServers(path = claudeJsonPath()): Record<string, McpServerEntry> {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return {}
    }
    throw new Error(`mcp-lazy: ${path} is unreadable`)
  }
  const servers = isRecord(parsed) ? parsed.mcpServers : undefined
  const out: Record<string, McpServerEntry> = {}
  if (isRecord(servers)) {
    for (const [name, entry] of Object.entries(servers)) {
      if (isRecord(entry)) {
        out[name] = entry
      }
    }
  }
  return out
}

/** A 0600 copy before the first change of a run; the newest few are kept. */
export function backupClaudeJson(backupDir: string, path = claudeJsonPath()): string {
  mkdirSync(backupDir, { recursive: true, mode: 0o700 })
  const target = join(backupDir, `claude.json.${new Date().toISOString().replaceAll(':', '-')}`)
  copyFileSync(path, target)
  chmodSync(target, 0o600)
  const backups = listBackups(backupDir)
  for (const old of backups.slice(KEEP_BACKUPS)) {
    rmSync(old, { force: true })
  }
  return target
}

/** Newest first. */
export function listBackups(backupDir: string): string[] {
  try {
    return readdirSync(backupDir)
      .filter((name) => name.startsWith('claude.json.'))
      .map((name) => join(backupDir, name))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  } catch {
    return []
  }
}

export type ClaudeMcpWriter = (name: string, entry: McpServerEntry) => Promise<void>

/** Replaces one user-scope entry through Claude Code's CLI (`claudePath`), on ~/.claude.json. */
export function claudeCliWriter(claudePath: string, home = homedir()): ClaudeMcpWriter {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home }
  // Why: with CLAUDE_CONFIG_DIR the CLI would write that folder's file, not ~/.claude.json.
  delete env.CLAUDE_CONFIG_DIR
  env.PATH = [dirname(claudePath), env.PATH].filter(Boolean).join(delimiter)
  const run = async (args: string[]): Promise<{ code: number | null; stderr: string }> => {
    const result = await runProcess({
      program: claudePath,
      args,
      cwd: home,
      env,
      timeoutMs: CLI_TIMEOUT_MS,
      maxOutputBytes: 16_384
    })
    return {
      code: result.timedOut ? null : result.code,
      stderr: result.stderr
    }
  }
  return async (name, entry) => {
    // A missing entry is fine to remove; the add below decides.
    await run(['mcp', 'remove', '-s', 'user', name])
    const added = await run(['mcp', 'add-json', '-s', 'user', name, JSON.stringify(entry)])
    if (added.code !== 0) {
      // stderr names the server and the reason; it carries no entry values.
      throw new Error(
        `claude mcp add-json ${name} failed (${added.code}): ${added.stderr.trim().slice(0, 200)}`
      )
    }
  }
}

const IN_PLACE_ATTEMPTS = 5

/** Claude Code writes ~/.claude.json as `JSON.stringify(config, null, 2)` (no trailing newline). */
function claudeFormat(document: unknown): string {
  return JSON.stringify(document, null, 2)
}

/**
 * Replaces one user-scope entry where it stands, so every other byte stays: the file must read
 * back as Claude Code writes it and be no symlink, else the CLI writer takes over (`fallback`). Claude Code takes no
 * lock on the file (2.1.296 writes through a held ~/.claude.json.lock), so this does what its own
 * writes do: temp + rename, and only while the file still holds the bytes read.
 */
export function inPlaceWriter(
  fallback: ClaudeMcpWriter | null,
  path = claudeJsonPath()
): ClaudeMcpWriter {
  return async (name, entry) => {
    for (let attempt = 0; attempt < IN_PLACE_ATTEMPTS; attempt++) {
      const text = readFileSync(path, 'utf8')
      const document: unknown = JSON.parse(text)
      if (
        !isRecord(document) ||
        claudeFormat(document) !== text ||
        lstatSync(path).isSymbolicLink()
      ) {
        if (!fallback) {
          throw new Error(
            "~/.claude.json is not in Claude Code's own format, and no claude CLI was found"
          )
        }
        return fallback(name, entry)
      }
      const servers = isRecord(document.mcpServers) ? document.mcpServers : {}
      servers[name] = entry
      document.mcpServers = servers
      const temp = `${path}.${process.pid}-${randomUUID()}.tmp`
      try {
        writeFileSync(temp, claudeFormat(document), { mode: 0o600 })
        if (readFileSync(path, 'utf8') !== text) {
          continue
        }
        renameSync(temp, path)
        return
      } finally {
        rmSync(temp, { force: true })
      }
    }
    throw new Error(`~/.claude.json kept changing; ${name} was left as it was`)
  }
}

export type ApplyResult = { changed: string[]; errors: string[] }

/**
 * Writes `planned` entry by entry, then checks that those entries are as planned and that every
 * other user-scope entry is as it was. A mismatch puts the changed entries back.
 */
export async function writeMcpServers(
  before: Readonly<Record<string, McpServerEntry>>,
  planned: Readonly<Record<string, McpServerEntry>>,
  write: ClaudeMcpWriter,
  path = claudeJsonPath()
): Promise<ApplyResult> {
  const changed: string[] = []
  const errors: string[] = []
  for (const [name, entry] of Object.entries(planned)) {
    try {
      await write(name, entry)
      changed.push(name)
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }
  const after = readUserMcpServers(path)
  const wrong = Object.keys({ ...before, ...after }).filter((name) => {
    const want = name in planned && changed.includes(name) ? planned[name] : before[name]
    return !isDeepStrictEqual(after[name], want)
  })
  if (wrong.length > 0) {
    errors.push(
      `~/.claude.json differs from the plan in ${wrong.join(', ')}; changed entries put back`
    )
    for (const name of changed) {
      if (before[name]) {
        await write(name, before[name]).catch(() => {})
      }
    }
    return { changed: [], errors }
  }
  if (changed.length > 0) {
    chmodSync(path, 0o600)
  }
  return { changed, errors }
}
