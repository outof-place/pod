// Fork-only (Pod): the write that takes Pod's hooks and statusLine out of a Claude settings.json once
// they ride `--settings` (pod-claude-flag-settings.ts). It edits only Pod's entries in the file's own
// text, so the user's keys, JSONC comments and formatting stay byte for byte, backs the file up
// first, and logs exactly what it removed. A file without Pod's entries is never written.
import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
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
import { cutMember, hasComment } from './pod-claude-settings-jsonc-cut'

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

/** Why removePodClaudeEntries gave null: the first check that failed. */
export type PodClaudeCutRefusal = {
  reason?:
    | 'not a JSONC object'
    | 'duplicate keys'
    | 'no safe cut'
    | 'unparsable result'
    | 'changed meaning'
    | 'unexpected error'
}

/** Whether any object in the tree names a key twice: paths there resolve to the first one only. */
function hasDuplicateKeys(node: Node): boolean {
  if (node.type === 'object') {
    const keys = new Set<string>()
    for (const property of node.children ?? []) {
      const key = String(property.children?.[0]?.value)
      if (keys.has(key)) {
        return true
      }
      keys.add(key)
    }
  }
  return (node.children ?? []).some(hasDuplicateKeys)
}

/** The text without Pod's entries, and what went; null (the reason in `refusal`) when the text isn't
 *  a JSONC object or no cut keeps the rest of it as it was. */
export function removePodClaudeEntries(
  text: string,
  names: { hookScript: string; statusLineScript: string },
  refusal: PodClaudeCutRefusal = {}
): { text: string; removed: PodClaudeSettingsRemoval[] } | null {
  try {
    const root = parseObject(text)
    if (!root) {
      refusal.reason = 'not a JSONC object'
      return null
    }
    // Why: with a key twice (`"Stop": [], "Stop": [...]`) a removal's path names another node than the
    // one it came from.
    if (hasDuplicateKeys(root)) {
      refusal.reason = 'duplicate keys'
      return null
    }
    return cutPodEntries(text, root, names, refusal)
  } catch {
    // Why: the main process reads the user's own file here; a pathological one (parseTree recurses, so
    // a few thousand nested brackets overflow the stack) must never throw.
    refusal.reason = 'unexpected error'
    return null
  }
}

function cutPodEntries(
  text: string,
  start: Node,
  names: { hookScript: string; statusLineScript: string },
  refusal: PodClaudeCutRefusal
): { text: string; removed: PodClaudeSettingsRemoval[] } | null {
  const isManaged = createManagedCommandMatcher(names.hookScript)
  let root: Node | null = start
  const original: unknown = getNodeValue(root)
  const emptied = new Set<string>()
  const removed: PodClaudeSettingsRemoval[] = []
  for (let path = nextRemoval(root, isManaged, names.statusLineScript); path;) {
    removed.push({ path, value: getNodeValue(findNodeAtLocation(root, path)!) })
    if (path[0] === 'hooks' && path.length > 1) {
      emptied.add(String(path[1]))
    }
    const next = cutMember(text, root, path)
    if (next === null || next === text) {
      refusal.reason = 'no safe cut'
      return null
    }
    root = parseObject(next)
    if (!root) {
      refusal.reason = 'unparsable result'
      return null
    }
    text = next
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
      text = cutMember(text, root, ['hooks', event]) ?? text
      const reparsed = parseObject(text)
      if (!reparsed) {
        refusal.reason = 'unparsable result'
        return null
      }
      root = reparsed
    }
  }
  const hooks = findNodeAtLocation(root, ['hooks'])
  if (
    emptied.size > 0 &&
    hooks?.type === 'object' &&
    (hooks.children?.length ?? 0) === 0 &&
    !hasComment(text, hooks)
  ) {
    text = cutMember(text, root, ['hooks']) ?? text
  }
  // Why: the text is written to the user's own settings.json; one that doesn't parse, or means more
  // or less than the original minus Pod's entries, is never written. The compare is by value
  // (getNodeValue drops comments): that comments stay is the cut's own work, held by its fuzz test.
  const final = parseObject(text)
  if (!final) {
    refusal.reason = 'unparsable result'
    return null
  }
  // Why structuredClone: getNodeValue builds null-prototype objects, which a strict compare tells apart.
  if (
    !isDeepStrictEqual(
      structuredClone(getNodeValue(final)),
      expectedSettings(original, removed, emptied, final)
    )
  ) {
    refusal.reason = 'changed meaning'
    return null
  }
  return { text, removed }
}

/** `value` with each removal's path taken out, in the order the cut took them. */
function withoutRemovals(value: unknown, removals: PodClaudeSettingsRemoval[]): unknown {
  const copy: unknown = structuredClone(value)
  for (const { path } of removals) {
    const parent = path
      .slice(0, -1)
      .reduce<unknown>(
        (node, key) =>
          Array.isArray(node) && typeof key === 'number'
            ? node[key]
            : isPlainObject(node) && typeof key === 'string'
              ? node[key]
              : undefined,
        copy
      )
    const key = path.at(-1)
    if (Array.isArray(parent) && typeof key === 'number') {
      parent.splice(key, 1)
    } else if (isPlainObject(parent) && typeof key === 'string') {
      Reflect.deleteProperty(parent, key)
    }
  }
  return copy
}

/** What the cut text has to mean: the original without each removal, then without the events and the
 *  `hooks` the cleanup took out, only where Pod's removals emptied them. A user's own empty event or
 *  `hooks` stays in it, so a cut that took one would not pass. */
function expectedSettings(
  original: unknown,
  removed: PodClaudeSettingsRemoval[],
  emptied: Set<string>,
  final: Node
): unknown {
  const expected = withoutRemovals(original, removed)
  if (!isPlainObject(expected) || !isPlainObject(expected.hooks)) {
    return expected
  }
  const hooks = expected.hooks
  for (const event of emptied) {
    const groups = hooks[event]
    if (
      Array.isArray(groups) &&
      groups.length === 0 &&
      !findNodeAtLocation(final, ['hooks', event])
    ) {
      Reflect.deleteProperty(hooks, event)
    }
  }
  if (
    emptied.size > 0 &&
    Object.keys(hooks).length === 0 &&
    !findNodeAtLocation(final, ['hooks'])
  ) {
    Reflect.deleteProperty(expected, 'hooks')
  }
  return expected
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
