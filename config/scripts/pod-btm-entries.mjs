#!/usr/bin/env node
// Read-only: Pod's entries in Background Task Management (System Settings > Login Items), from
// `sfltool dumpbtm`. Run it before and after an install, a move to one-app or an update, to catch
// a second "Pod" or an entry for a bundle that is gone. It never changes BTM: a stale entry can't
// be removed without `sfltool resetbtm`, which wipes everyone's.
//
// `sfltool dumpbtm` is NOT root-free: on macOS 27 authd puts an admin authorization dialog on the
// user's screen (2026-10-11, it also blocked a packaging smoke). So this script runs it only for a
// person at a terminal who passes --i-will-authorize; automation and tests read a saved dump.
//
//   node config/scripts/pod-btm-entries.mjs --i-will-authorize                 list
//   node config/scripts/pod-btm-entries.mjs --i-will-authorize --save before.json
//   node config/scripts/pod-btm-entries.mjs --i-will-authorize --compare before.json
//   node config/scripts/pod-btm-entries.mjs --dump dumpbtm.txt [--save … | --compare …]
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'

// Pod's bundle ids and labels (codes.pod.app, codes.pod.native, codes.pod.app.acc.*, codes.pod.rootd)
// and Pod Menu's, which kept claude-acc's id for its TCC grants
const POD_IDS = /(^|\.)(codes\.pod(\.|$)|com\.filip\.claude-acc\.menubar)/
const POD_PATHS = /\/(Pod|Pod Runtime|Pod Menu)\.app(\/|$)/
const FIELDS = ['Identifier', 'Bundle Identifier', 'Parent Identifier', 'Embedded Item Identifiers']

/** Every record of a dump, with the uid of the section it is in. */
export function parseBtmDump(text) {
  const records = []
  let uid = null
  let record = null
  for (const line of text.split('\n')) {
    const section = /Records for UID (-?\d+)/.exec(line)
    if (section) {
      uid = Number(section[1])
      record = null
      continue
    }
    if (/^ #\d+:$/.test(line)) {
      record = { uid }
      records.push(record)
      continue
    }
    const field = /^\s+([A-Z][A-Za-z ]+): (.*)$/.exec(line)
    if (record && field) {
      record[field[1]] = field[2]
    }
  }
  return records
}

/** Pod's records: by id or label, or by a URL or program inside one of Pod's bundles. */
export function podEntries(records) {
  return records.filter(
    (r) =>
      FIELDS.some((name) => POD_IDS.test(String(r[name] ?? '').replace(/^\d+\./, ''))) ||
      POD_PATHS.test(String(r.URL ?? '')) ||
      POD_PATHS.test(String(r['Executable Path'] ?? ''))
  )
}

/** BTM writes the user's home as /Users/<uid>/ and a bundle as a file URL. */
export function localPath(url, uid = process.getuid?.(), home = homedir()) {
  const path = decodeURIComponent(String(url).replace(/^file:\/\//, ''))
  return path.replace(/^\/Users\/(\d+)\//, (whole, id) => (Number(id) === uid ? `${home}/` : whole))
}

function key(r) {
  return `${r.uid}|${r.Identifier}|${r.URL}`
}

/**
 * What changed between two lists, and what looks wrong in the second: one identifier under two
 * URLs (a second "Pod" in Login Items), or a URL that no longer exists on disk.
 */
export function compareBtm(before, after, exists = existsSync) {
  const was = new Map(before.map((r) => [key(r), r]))
  const now = new Map(after.map((r) => [key(r), r]))
  const added = after.filter((r) => !was.has(key(r)))
  const removed = before.filter((r) => !now.has(key(r)))
  const changed = after.filter(
    (r) => was.has(key(r)) && was.get(key(r)).Disposition !== r.Disposition
  )
  const urls = new Map()
  for (const r of after) {
    const id = `${r.uid}|${r.Identifier}`
    urls.set(id, [...(urls.get(id) ?? []), r.URL])
  }
  const duplicates = [...urls]
    .filter(([, list]) => new Set(list).size > 1)
    .map(([id, list]) => ({ id, urls: list }))
  const missing = after.filter((r) => /^(\/|file:)/.test(r.URL ?? '') && !exists(localPath(r.URL)))
  return { added, removed, changed, duplicates, missing }
}

function line(r) {
  return `${r.Type ?? '?'} | ${r.Name ?? '?'} | ${r.Identifier ?? '?'} | ${r.URL ?? ''} | ${r.Disposition ?? ''}`
}

/** Why `sfltool` must not run now, or null: only with the flag, from a terminal a person sits at. */
export function sfltoolRefusal(args, interactive) {
  if (!args.includes('--i-will-authorize')) {
    return 'sfltool dumpbtm asks for an admin password on screen: pass --i-will-authorize, or --dump FILE'
  }
  return interactive
    ? null
    : 'sfltool dumpbtm needs a person at a terminal (stdin and stdout are not a TTY)'
}

function readDump(args) {
  const dump = args.indexOf('--dump')
  if (dump !== -1) {
    return readFileSync(args[dump + 1], 'utf8')
  }
  const refusal = sfltoolRefusal(args, Boolean(process.stdin.isTTY && process.stdout.isTTY))
  if (refusal) {
    console.error(refusal)
    return null
  }
  return execFileSync('/usr/bin/sfltool', ['dumpbtm'], { encoding: 'utf8', maxBuffer: 64 << 20 })
}

function main(args) {
  const dump = readDump(args)
  if (dump === null) {
    return 2
  }
  const entries = podEntries(parseBtmDump(dump))
  const save = args.indexOf('--save')
  if (save !== -1) {
    writeFileSync(args[save + 1], `${JSON.stringify(entries, null, 2)}\n`)
  }
  const compare = args.indexOf('--compare')
  if (compare === -1) {
    console.log(entries.length ? entries.map(line).join('\n') : 'no Pod entries in BTM')
    return 0
  }
  const result = compareBtm(JSON.parse(readFileSync(args[compare + 1], 'utf8')), entries)
  for (const [name, list] of Object.entries(result)) {
    console.log(`${name}: ${list.length}`)
    for (const item of list) {
      console.log(`  ${item.id ? `${item.id}: ${item.urls.join(', ')}` : line(item)}`)
    }
  }
  return result.duplicates.length || result.missing.length ? 1 : 0
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  process.exit(main(process.argv.slice(2)))
}
