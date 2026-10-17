import { getNodeValue, parseTree, type ParseError } from 'jsonc-parser'
import { isDeepStrictEqual } from 'node:util'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/orca-user-data' } }))

import { removePodClaudeEntries, type PodClaudeCutRefusal } from './pod-claude-settings-migration'

const names = { hookScript: 'claude-hook.sh', statusLineScript: 'claude-statusline.sh' }
const CLIENT = '/Users/e2e/.orca/agent-hooks/pod-agent-hook'
const SHELL = '/bin/sh "$HOME/.orca/agent-hooks/claude-hook.sh"'
const STATUS = '/bin/sh "${HOME-}/.orca/agent-hooks/claude-statusline.sh"'
const EVENTS = ['PreToolUse', 'PostToolUse', 'Stop', 'SessionStart', 'Notification', 'PreCompact']

/** mulberry32: the same cases on every run, and a failing seed can be replayed. */
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Value = string | number | boolean | null | Value[] | { [key: string]: Value }
/** A value to render; `pod` marks Pod's own subtrees, which never get a user comment inside. */
type Draft = { value: Value; pod?: true; members?: [string, Draft][]; items?: Draft[] }

const leaf = (value: Value, pod?: true): Draft => ({ value, pod })
const object = (members: [string, Draft][], pod?: true): Draft => ({ value: null, members, pod })
const array = (items: Draft[], pod?: true): Draft => ({ value: null, items, pod })
const hook = (command: string, pod?: true): Draft =>
  object(
    [
      ['type', leaf('command', pod)],
      ['command', leaf(command, pod)]
    ],
    pod
  )

/** A settings file with Pod's and the user's entries mixed, and what it means without Pod's: the
 *  events that held only Pod's groups may go or stay empty, every other one stays as it was (a user's
 *  own empty event too). */
function settings(next: () => number): {
  draft: Draft
  userValue: unknown
  podOnlyEvents: Set<string>
  hooksPodOnly: boolean
} {
  const pick = <T>(items: T[]): T => items[Math.floor(next() * items.length)]
  const user: [string, Value][] = []
  const members: [string, Draft][] = []
  if (next() < 0.5) {
    members.push(['model', leaf('opus')])
    user.push(['model', 'opus'])
  }
  const hooks: [string, Draft][] = []
  const userHooks: [string, Value][] = []
  const podOnlyEvents = new Set<string>()
  for (const event of EVENTS.filter(() => next() < 0.6)) {
    const groups: Draft[] = []
    const userGroups: Value[] = []
    for (let count = 1 + Math.floor(next() * 3); count > 0; count -= 1) {
      const kind = pick(['pod', 'user', 'mixed'])
      if (kind === 'pod') {
        groups.push(object([['hooks', array([hook(pick([CLIENT, SHELL]), true)], true)]], true))
      } else if (kind === 'user') {
        const command = pick(['my-guard', 'say done', 'curl https://example.com//x'])
        groups.push(
          object([
            ['matcher', leaf('Bash')],
            ['hooks', array([hook(command)])]
          ])
        )
        userGroups.push({ matcher: 'Bash', hooks: [{ type: 'command', command }] })
      } else {
        const items = [hook('say mixed'), hook(CLIENT, true)]
        if (next() < 0.5) {
          items.reverse()
        }
        groups.push(object([['hooks', array(items)]]))
        userGroups.push({ hooks: [{ type: 'command', command: 'say mixed' }] })
      }
    }
    hooks.push([event, array(groups)])
    userHooks.push([event, userGroups])
    if (userGroups.length === 0) {
      podOnlyEvents.add(event)
    }
  }
  // A user's own empty event (r-orca on v5), anywhere among Pod's: it has to stay.
  if (next() < 0.35) {
    const at = Math.floor(next() * (hooks.length + 1))
    hooks.splice(at, 0, ['UserEmpty', array([])])
    userHooks.splice(at, 0, ['UserEmpty', []])
  }
  if (hooks.length > 0) {
    members.push(['hooks', object(hooks)])
    user.push(['hooks', Object.fromEntries(userHooks)])
  }
  const statusLine = pick(['pod', 'user', 'none'])
  if (statusLine === 'pod') {
    members.push([
      'statusLine',
      object(
        [
          ['type', leaf('command', true)],
          ['command', leaf(STATUS, true)]
        ],
        true
      )
    ])
  } else if (statusLine === 'user') {
    members.push([
      'statusLine',
      object([
        ['type', leaf('command')],
        ['command', leaf('ccstatusline')]
      ])
    ])
    user.push(['statusLine', { type: 'command', command: 'ccstatusline' }])
  }
  if (next() < 0.5) {
    members.push(['env', object([['MY_FLAG', leaf('1')]])])
    user.push(['env', { MY_FLAG: '1' }])
  }
  // Members in a random order: Pod's entries land first, last, alone and in between.
  for (let i = members.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1))
    ;[members[i], members[j]] = [members[j], members[i]]
  }
  const order = new Map(members.map(([key], index) => [key, index]))
  user.sort(([a], [b]) => order.get(a)! - order.get(b)!)
  return {
    draft: object(members),
    userValue: Object.fromEntries(user),
    podOnlyEvents,
    hooksPodOnly: userHooks.every(([event]) => podOnlyEvents.has(event))
  }
}

/** The draft as JSONC text: random blanks, CRLF or LF, trailing commas, and numbered user comments in
 *  every gap outside Pod's subtrees. */
function render(draft: Draft, next: () => number, comments: string[]): string {
  const newline = next() < 0.3 ? '\r\n' : '\n'
  const indentUnit = next() < 0.5 ? '\t' : '  '
  const gap = (depth: number, inPod: boolean): string => {
    const roll = next()
    const indent = newline + indentUnit.repeat(depth)
    if (inPod || roll < 0.35) {
      return roll < 0.2 ? '' : roll < 0.5 ? ' ' : indent
    }
    const id = `c${comments.length}`
    comments.push(id)
    return roll < 0.65
      ? `${indent}// ${id}${indent}`
      : roll < 0.85
        ? ` /* ${id} */ `
        : `${indent}/* ${id} */${indent}`
  }
  const write = (node: Draft, depth: number, inPod: boolean): string => {
    const pod = inPod || node.pod === true
    if (node.members || node.items) {
      const [open, close] = node.members ? ['{', '}'] : ['[', ']']
      const parts = node.members
        ? node.members.map(
            ([key, value]) =>
              `${JSON.stringify(key)}:${next() < 0.5 ? ' ' : ''}${write(value, depth + 1, pod)}`
          )
        : node.items!.map((item) => write(item, depth + 1, pod))
      if (parts.length === 0) {
        return `${open}${close}`
      }
      const body = parts
        .map((part) => `${gap(depth + 1, pod)}${part}${gap(depth + 1, pod)}`)
        .join(',')
      const trailing = !pod && next() < 0.2 ? `,${gap(depth + 1, pod)}` : ''
      return `${open}${body}${trailing}${gap(depth, pod)}${close}`
    }
    return JSON.stringify(node.value)
  }
  return write(draft, 0, false) + newline
}

/** A settings value as plain objects, without the Pod-only events left empty and without `hooks` when
 *  it held only those: a user's own empty event or `hooks` stays and is compared. */
function trimmed(value: unknown, podOnlyEvents: Set<string>, hooksPodOnly: boolean): unknown {
  const plain: unknown = structuredClone(value)
  if (plain === null || typeof plain !== 'object' || Array.isArray(plain)) {
    return plain
  }
  const record: Record<string, unknown> = Object.fromEntries(Object.entries(plain))
  const hooks = record.hooks
  if (hooks !== null && typeof hooks === 'object' && !Array.isArray(hooks)) {
    const kept = Object.entries(hooks).filter(
      ([event, groups]) =>
        !(podOnlyEvents.has(event) && Array.isArray(groups) && groups.length === 0)
    )
    if (kept.length > 0 || !hooksPodOnly) {
      record.hooks = Object.fromEntries(kept)
    } else {
      delete record.hooks
    }
  }
  return record
}

type Place = 'root' | 'event' | 'group' | 'hook' | 'other'

/** Names one member's key a second time, in an object picked by place first so each place gets its
 *  share: the root, `hooks` (an event twice), a group, a hook, or statusLine/env. */
function duplicateKey(draft: Draft, next: () => number): { place: Place; pod: boolean } {
  const found: { node: Draft; place: Place; pod: boolean }[] = []
  const walk = (node: Draft, path: (string | number)[], pod: boolean): void => {
    const inPod = pod || node.pod === true
    if (node.members && node.members.length > 0) {
      const inHooks = path[0] === 'hooks'
      const place: Place =
        path.length === 0
          ? 'root'
          : inHooks && path.length === 1
            ? 'event'
            : inHooks && path.length === 3
              ? 'group'
              : inHooks && path.length === 5
                ? 'hook'
                : 'other'
      found.push({ node, place, pod: inPod })
    }
    node.members?.forEach(([key, value]) => walk(value, [...path, key], inPod))
    node.items?.forEach((item, index) => walk(item, [...path, index], inPod))
  }
  walk(draft, [], false)
  const places = [...new Set(found.map(({ place }) => place))]
  if (places.length === 0) {
    draft.members!.push(['model', leaf('opus')], ['model', leaf('opus')])
    return { place: 'root', pod: false }
  }
  const place = places[Math.floor(next() * places.length)]
  const candidates = found.filter((entry) => entry.place === place)
  const { node, pod } = candidates[Math.floor(next() * candidates.length)]
  const members = node.members!
  const [key, value] = members[Math.floor(next() * members.length)]
  const copy: Draft = next() < 0.5 ? structuredClone(value) : leaf('dup', pod ? true : undefined)
  members.splice(Math.floor(next() * (members.length + 1)), 0, [key, copy])
  return { place, pod }
}

describe('the settings cut on generated files (fuzz)', () => {
  it('always leaves valid JSONC with every user entry and comment, and none of Pod', () => {
    const failures: string[] = []
    // What the cases covered: a fuzz that drifted into trivial files must fail too.
    const seen = {
      podRemoved: 0,
      comments: 0,
      crlf: 0,
      trailingComma: 0,
      lineCommentBeforeClose: 0,
      userEmptyEvent: 0
    }
    for (let seed = 1; seed <= 600; seed += 1) {
      const next = random(seed)
      const { draft, userValue, podOnlyEvents, hooksPodOnly } = settings(next)
      seen.userEmptyEvent += JSON.stringify(userValue).includes('"UserEmpty":[]') ? 1 : 0
      const comments: string[] = []
      const text = render(draft, next, comments)
      const errors: ParseError[] = []
      parseTree(text, errors, { allowTrailingComma: true })
      if (errors.length > 0) {
        failures.push(`seed ${seed}: the generator wrote invalid JSONC`)
        continue
      }
      const result = removePodClaudeEntries(text, names)
      seen.comments += comments.length > 0 ? 1 : 0
      seen.crlf += text.includes('\r\n') ? 1 : 0
      seen.trailingComma += /,\s*(\/\*[^*]*\*\/\s*)*[\]}]/.test(text) ? 1 : 0
      seen.lineCommentBeforeClose += /\/\/ c\d+\r?\n[ \t]*[\]}]/.test(text) ? 1 : 0
      seen.podRemoved += (result?.removed.length ?? 0) > 0 ? 1 : 0
      if (!result) {
        failures.push(`seed ${seed}: refused`)
        continue
      }
      const outErrors: ParseError[] = []
      const root = parseTree(result.text, outErrors, { allowTrailingComma: true })
      if (outErrors.length > 0 || !root) {
        failures.push(`seed ${seed}: the result doesn't parse`)
        continue
      }
      const trim = (value: unknown): unknown => trimmed(value, podOnlyEvents, hooksPodOnly)
      if (!isDeepStrictEqual(trim(getNodeValue(root)), trim(userValue))) {
        failures.push(`seed ${seed}: the user's entries changed`)
      }
      const lost = comments.filter((id) => !new RegExp(`(//|/\\*) ${id}\\b`).test(result.text))
      if (lost.length > 0) {
        failures.push(`seed ${seed}: comments lost: ${lost.join(' ')}`)
      }
      if (removePodClaudeEntries(result.text, names)?.removed.length !== 0) {
        failures.push(`seed ${seed}: Pod's entries left`)
      }
    }
    expect(failures).toEqual([])
    expect(seen.podRemoved).toBeGreaterThan(450)
    expect(seen.comments).toBeGreaterThan(450)
    expect(seen.crlf).toBeGreaterThan(100)
    expect(seen.trailingComma).toBeGreaterThan(100)
    expect(seen.lineCommentBeforeClose).toBeGreaterThan(100)
    expect(seen.userEmptyEvent).toBeGreaterThan(150)
  })

  it('refuses every file that names a key twice, at any depth, and never throws', () => {
    const failures: string[] = []
    const seen = { root: 0, event: 0, group: 0, hook: 0, other: 0, pod: 0 }
    for (let seed = 1; seed <= 400; seed += 1) {
      const next = random(seed)
      const { draft } = settings(next)
      const { place, pod } = duplicateKey(draft, next)
      seen[place] += 1
      seen.pod += pod ? 1 : 0
      const text = render(draft, next, [])
      const errors: ParseError[] = []
      parseTree(text, errors, { allowTrailingComma: true })
      if (errors.length > 0) {
        failures.push(`seed ${seed}: the generator wrote invalid JSONC`)
        continue
      }
      const refusal: PodClaudeCutRefusal = {}
      try {
        const result = removePodClaudeEntries(text, names, refusal)
        if (result !== null || refusal.reason !== 'duplicate keys') {
          failures.push(`seed ${seed}: a ${place} key twice gave ${refusal.reason ?? 'a cut'}`)
        }
      } catch (error) {
        failures.push(`seed ${seed}: threw ${String(error)}`)
      }
    }
    expect(failures).toEqual([])
    for (const place of ['root', 'event', 'group', 'hook', 'other', 'pod'] as const) {
      expect(seen[place], place).toBeGreaterThan(50)
    }
  })
})
