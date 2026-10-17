// Fork-only (Pod): the write that takes Pod's hooks and statusLine out of a Claude settings.json once
// they ride `--settings` (pod-claude-flag-settings.ts). It edits only Pod's entries in the file's own
// text, so the user's keys, JSONC comments and formatting stay byte for byte, backs the file up
// first, and logs exactly what it removed. A file without Pod's entries is never written.
import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  findNodeAtLocation,
  getNodeValue,
  parseTree,
  type JSONPath,
  type Node,
  type ParseError
} from 'jsonc-parser'
import {
  createManagedCommandMatcher,
  isPlainObject,
  removeManagedCommands,
  writeHooksJson,
  type HookDefinition
} from '../../agent-hooks/installer-utils'
import { removeManagedStatusLine } from '../../claude/hook-settings'

export const POD_CLAUDE_MIGRATION_LOG_FILE = 'claude-settings-migration.json'

export type PodClaudeSettingsRemoval = { path: JSONPath; value: unknown }
export type PodClaudeMigrationEntry = {
  at: string
  settingsPath: string
  backupPath: string
  removed: PodClaudeSettingsRemoval[]
}
type MigrationLog = { migrations: PodClaudeMigrationEntry[] }

const DIRECT_COMMAND_KEYS = ['command', 'bash', 'powershell'] as const

function parseObject(text: string): Node | null {
  const errors: ParseError[] = []
  const root = parseTree(text, errors, { allowTrailingComma: true })
  return errors.length === 0 && root?.type === 'object' ? root : null
}

/** The next of Pod's entries, deepest first so earlier indexes stay valid; null when none is left. */
function nextRemoval(
  root: Node,
  isManaged: (command: string | undefined) => boolean,
  statusLineScript: string
): JSONPath | null {
  const hooks = findNodeAtLocation(root, ['hooks'])
  for (const property of hooks?.type === 'object' ? (hooks.children ?? []) : []) {
    const [key, groups] = property.children ?? []
    const event = String(key?.value)
    if (groups?.type !== 'array') {
      continue
    }
    for (let index = (groups.children?.length ?? 0) - 1; index >= 0; index -= 1) {
      const group: unknown = getNodeValue(groups.children![index])
      if (!isPlainObject(group)) {
        continue
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a plain object, read only through optional fields.
      const definition = group as HookDefinition
      const cleaned = removeManagedCommands([definition], isManaged)
      if (cleaned.length === 1 && cleaned[0] === definition) {
        continue
      }
      if (cleaned.length === 0) {
        return ['hooks', event, index]
      }
      const nested = Array.isArray(definition.hooks) ? definition.hooks : []
      for (let hook = nested.length - 1; hook >= 0; hook -= 1) {
        if (removeManagedCommands([{ hooks: [nested[hook]] }], isManaged).length === 0) {
          return ['hooks', event, index, 'hooks', hook]
        }
      }
      const direct = DIRECT_COMMAND_KEYS.find((name) => isManaged(definition[name]))
      if (direct) {
        return ['hooks', event, index, direct]
      }
    }
  }
  const config: unknown = getNodeValue(root)
  if (isPlainObject(config) && removeManagedStatusLine(config, statusLineScript).changed) {
    return ['statusLine']
  }
  return null
}

type Gap = { kind: 'blank' | 'comment' | 'comma'; start: number; end: number }

/** The text between two siblings, or a bracket and a member, as blanks, comments and commas; null
 *  for anything else. */
function gapParts(text: string, from: number, to: number): Gap[] | null {
  const parts: Gap[] = []
  for (let at = from; at < to;) {
    const start = at
    if (text[at] === ',') {
      at += 1
      parts.push({ kind: 'comma', start, end: at })
    } else if (text.startsWith('//', at)) {
      // Why up to the line break: the break is a blank, so a cut can take it and keep the comment.
      const line = text.indexOf('\n', at)
      at = line === -1 || line > to ? to : text[line - 1] === '\r' ? line - 1 : line
      parts.push({ kind: 'comment', start, end: at })
    } else if (text.startsWith('/*', at)) {
      const close = text.indexOf('*/', at + 2)
      if (close === -1 || close + 2 > to) {
        return null
      }
      at = close + 2
      parts.push({ kind: 'comment', start, end: at })
    } else if (/\s/.test(text[at])) {
      while (at < to && /\s/.test(text[at])) {
        at += 1
      }
      parts.push({ kind: 'blank', start, end: at })
    } else {
      return null
    }
  }
  return parts
}

function hasComment(text: string, node: Node): boolean {
  // Why the inside only: an emptied container's brackets hold nothing but blanks and comments.
  const parts = gapParts(text, node.offset + 1, node.offset + node.length - 1)
  return parts === null || parts.some((part) => part.kind === 'comment')
}

/** `text` without the member or element at `path`. Not jsonc-parser's modify: that rewrites the
 *  whitespace before a closing bracket. This cuts the node with one comma and the blanks beside
 *  it: the comma and blanks after it when it is not the last, else the blanks before it and the
 *  previous sibling's comma. Every other byte stays, a user's comment around it included. */
function cut(text: string, root: Node, path: JSONPath): string | null {
  const node = findNodeAtLocation(root, path)
  const target = node?.parent?.type === 'property' ? node.parent : node
  const container = target?.parent
  const siblings = container?.children ?? []
  const index = target ? siblings.indexOf(target) : -1
  if (!target || !container || index === -1) {
    return null
  }
  const end = target.offset + target.length
  if (index < siblings.length - 1) {
    const parts = gapParts(text, end, siblings[index + 1].offset)
    const comma = parts?.findIndex((part) => part.kind === 'comma') ?? -1
    if (!parts || comma === -1) {
      return null
    }
    const before = parts.slice(0, comma).some((part) => part.kind === 'comment')
      ? text.slice(end, parts[comma].start)
      : ''
    const stop = parts[comma + 1]?.kind === 'blank' ? parts[comma + 1].end : parts[comma].end
    return text.slice(0, target.offset) + before + text.slice(stop)
  }
  const previous = index > 0 ? siblings[index - 1] : null
  const parts = gapParts(
    text,
    previous ? previous.offset + previous.length : container.offset + 1,
    target.offset
  )
  if (!parts) {
    return null
  }
  const last = parts.at(-1)
  const from = last?.kind === 'blank' ? last.start : target.offset
  if (!previous) {
    return text.slice(0, from) + text.slice(end)
  }
  const comma = parts.find((part) => part.kind === 'comma')
  if (!comma) {
    return null
  }
  return text.slice(0, comma.start) + text.slice(comma.end, from) + text.slice(end)
}

/** The text without Pod's entries, and what went; null when the text isn't a JSONC object. */
export function removePodClaudeEntries(
  text: string,
  names: { hookScript: string; statusLineScript: string }
): { text: string; removed: PodClaudeSettingsRemoval[] } | null {
  const isManaged = createManagedCommandMatcher(names.hookScript)
  let root = parseObject(text)
  if (!root) {
    return null
  }
  const emptied = new Set<string>()
  const removed: PodClaudeSettingsRemoval[] = []
  for (let path = nextRemoval(root, isManaged, names.statusLineScript); path;) {
    removed.push({ path, value: getNodeValue(findNodeAtLocation(root, path)!) })
    if (path[0] === 'hooks' && path.length > 1) {
      emptied.add(String(path[1]))
    }
    const next = cut(text, root, path)
    root = next === null || next === text ? null : parseObject(next)
    if (!root) {
      return null
    }
    text = next!
    path = nextRemoval(root, isManaged, names.statusLineScript)
  }
  // Events, then `hooks` itself, that Pod's removals left empty. One that holds a user's comment stays.
  for (const event of emptied) {
    const groups = findNodeAtLocation(root, ['hooks', event])
    if (
      groups?.type === 'array' &&
      (groups.children?.length ?? 0) === 0 &&
      !hasComment(text, groups)
    ) {
      text = cut(text, root, ['hooks', event]) ?? text
      root = parseObject(text)!
    }
  }
  const hooks = findNodeAtLocation(root, ['hooks'])
  if (
    emptied.size > 0 &&
    hooks?.type === 'object' &&
    (hooks.children?.length ?? 0) === 0 &&
    !hasComment(text, hooks)
  ) {
    text = cut(text, root, ['hooks']) ?? text
  }
  return { text, removed }
}

function readLog(path: string): MigrationLog {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (isPlainObject(parsed) && Array.isArray(parsed.migrations)) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only this module writes the log.
      return parsed as MigrationLog
    }
  } catch {
    // Missing or unreadable: no migration recorded.
  }
  return { migrations: [] }
}

export function readPodClaudeMigrations(agentHooksDir: string): PodClaudeMigrationEntry[] {
  return readLog(join(agentHooksDir, POD_CLAUDE_MIGRATION_LOG_FILE)).migrations
}

/** Takes Pod's entries out of `settingsPath`: backup, write, log. Null when there was nothing to do. */
export function migratePodClaudeSettings(
  settingsPath: string,
  agentHooksDir: string,
  names: { hookScript: string; statusLineScript: string },
  now: Date = new Date()
): PodClaudeMigrationEntry | null {
  if (!existsSync(settingsPath)) {
    return null
  }
  const original = readFileSync(settingsPath, 'utf8')
  const result = removePodClaudeEntries(original, names)
  if (!result || result.removed.length === 0) {
    return null
  }
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  const backupPath = join(agentHooksDir, `claude-settings.${stamp}.backup.json`)
  copyFileSync(settingsPath, backupPath)
  chmodSync(backupPath, 0o600)
  writeHooksJson(settingsPath, {}, { serialized: result.text, preserveMode: true })
  const entry = { at: now.toISOString(), settingsPath, backupPath, removed: result.removed }
  const logPath = join(agentHooksDir, POD_CLAUDE_MIGRATION_LOG_FILE)
  const log = readLog(logPath)
  log.migrations.push(entry)
  writeFileSync(logPath, `${JSON.stringify(log, null, 2)}\n`, { mode: 0o600 })
  return entry
}
