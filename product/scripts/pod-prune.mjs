#!/usr/bin/env node
// Generated layer (pod-stack.json "generated"): removes the files Pod inherits from Orca but never
// ships, builds or runs, as listed in product/prune-manifest.json. It runs on the assembled stack
// after every assembly and upstream sync, so an upstream change to a pruned file never conflicts.
//
//   node product/scripts/pod-prune.mjs --plan    print what would go, and what is held back
//   node product/scripts/pod-prune.mjs --apply   delete it
//   node product/scripts/pod-prune.mjs --check   exit 1 if anything is left to delete
//   POD_PRUNE_LIST=1 with --plan also lists every file it would delete.
//
// A file a manifest entry matches is pruned only when no kept file refers to it. Kept files are
// scanned for repo paths, relative imports and unique file names; a match holds the file back, and
// a held file's own references hold others in turn. So a new upstream test that reads a pruned
// workflow keeps that workflow instead of breaking. Paths under "protect" can never be pruned:
// a manifest entry matching one is an error (exit 2). Ratchet baselines under "baselines" never
// hold anything: --apply drops their entries for pruned files, so no gate fails on a stale entry.
//
// Needs only Node 22+ and git; no dependencies, so it runs in a bare checkout.
import { execFileSync } from 'node:child_process'
import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  rmdirSync,
  writeFileSync
} from 'node:fs'
import { posix } from 'node:path'

const MANIFEST = 'product/prune-manifest.json'
const SELF = 'product/scripts/pod-prune.mjs'
const CODE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json']
const MAX_SCAN_BYTES = 8 << 20

const mode = process.argv[2]
if (!['--plan', '--apply', '--check'].includes(mode)) {
  console.error('usage: pod-prune.mjs --plan | --apply | --check')
  process.exit(1)
}

function fail(message) {
  console.error(`pod-prune: ${message}`)
  process.exit(2)
}

// `**` crosses directories, `*` and `?` stay inside one segment, `{a,b}` is an alternative.
function globToRegExp(glob) {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      const slash = glob[i + 2] === '/'
      out += slash ? '(?:.*/)?' : '.*'
      i += slash ? 2 : 1
    } else if (c === '*') {
      out += '[^/]*'
    } else if (c === '?') {
      out += '[^/]'
    } else if (c === '{') {
      const end = glob.indexOf('}', i)
      if (end === -1) {
        fail(`unclosed { in ${glob}`)
      }
      out += `(?:${glob
        .slice(i + 1, end)
        .split(',')
        .map((part) => part.replace(/[.+^$()|[\]\\]/g, '\\$&'))
        .join('|')})`
      i = end
    } else {
      out += c.replace(/[.+^$()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${out}$`)
}

function readManifest() {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
  const globList = (value, where) => {
    if (value === undefined) {
      return []
    }
    if (!Array.isArray(value) || value.some((g) => typeof g !== 'string' || !g)) {
      fail(`${where} must be an array of globs`)
    }
    return value.map((glob) => ({ glob, re: globToRegExp(glob) }))
  }
  const ruleList = (value, where) => {
    if (value === undefined) {
      return []
    }
    if (!Array.isArray(value)) {
      fail(`${where} must be an array`)
    }
    return value.map((rule, i) => {
      if (typeof rule?.glob !== 'string' || typeof rule?.reason !== 'string' || !rule.reason) {
        fail(`${where}[${i}] needs "glob" and "reason"`)
      }
      const re = globToRegExp(rule.glob)
      const except = globList(rule.except, `${where}[${i}].except`)
      return { ...rule, test: (file) => re.test(file) && !except.some((e) => e.re.test(file)) }
    })
  }
  const ids = new Set()
  const entries = (manifest.entries ?? []).map((entry, i) => {
    const where = `entries[${i}]`
    for (const key of ['id', 'category', 'reason']) {
      if (typeof entry[key] !== 'string' || !entry[key]) {
        fail(`${where} needs "${key}"`)
      }
    }
    if (ids.has(entry.id)) {
      fail(`duplicate entry id ${entry.id}`)
    }
    ids.add(entry.id)
    const paths = globList(entry.paths, `${where}.paths`)
    if (paths.length === 0) {
      fail(`${where} has no paths`)
    }
    return {
      id: entry.id,
      category: entry.category,
      reason: entry.reason,
      paths,
      except: globList(entry.except, `${where}.except`),
      allowReferrers: ruleList(entry.allowReferrers, `${where}.allowReferrers`)
    }
  })
  const baselines = (manifest.baselines ?? []).map((baseline, i) => {
    const where = `baselines[${i}]`
    if (typeof baseline?.file !== 'string' || !['lines', 'json-array'].includes(baseline.format)) {
      fail(`${where} needs "file" and "format" (lines | json-array)`)
    }
    if (baseline.format === 'json-array' && typeof baseline.key !== 'string') {
      fail(`${where} needs "key" for a json-array baseline`)
    }
    return baseline
  })
  return {
    baselines,
    protect: globList(manifest.protect, 'protect'),
    ignoreReferrers: ruleList(manifest.ignoreReferrers, 'ignoreReferrers'),
    inertWhenHeld: ruleList(manifest.inertWhenHeld, 'inertWhenHeld'),
    entries
  }
}

function existsOnDisk(file) {
  try {
    lstatSync(file)
    return true
  } catch {
    return false
  }
}

function isBinary(file, size) {
  if (size === 0) {
    return false
  }
  const fd = openSync(file, 'r')
  try {
    const buffer = Buffer.alloc(Math.min(size, 8000))
    readSync(fd, buffer, 0, buffer.length, 0)
    return buffer.includes(0)
  } finally {
    closeSync(fd)
  }
}

process.chdir(execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim())
const manifest = readManifest()
// Tracked files still on disk: after --apply the index keeps the deleted ones until `git add`.
const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 << 20 })
  .split('\0')
  .filter((file) => file && existsOnDisk(file))

// Candidates: files some entry matches and its except list does not.
const entryOf = new Map()
for (const file of tracked) {
  for (const entry of manifest.entries) {
    if (
      entry.paths.some(({ re }) => re.test(file)) &&
      !entry.except.some(({ re }) => re.test(file))
    ) {
      if (manifest.protect.some(({ re }) => re.test(file))) {
        fail(`entry ${entry.id} matches the protected path ${file}`)
      }
      if (!entryOf.has(file)) {
        entryOf.set(file, entry)
      }
    }
  }
}

// Directories every tracked file of which is a candidate: a reference to one of them counts.
const dirFiles = new Map()
for (const file of tracked) {
  for (let dir = posix.dirname(file); dir !== '.'; dir = posix.dirname(dir)) {
    const entry = dirFiles.get(dir) ?? { total: 0, candidates: [] }
    entry.total++
    if (entryOf.has(file)) {
      entry.candidates.push(file)
    }
    dirFiles.set(dir, entry)
  }
}
const vanishingDirs = new Map()
for (const [dir, { total, candidates }] of dirFiles) {
  if (total === candidates.length) {
    vanishingDirs.set(dir, candidates)
  }
}

// A bare file name (`join('.github', 'workflows', 'pr.yml')`) counts only when no other tracked
// file has it and its parent directory's name is quoted in the same file.
const basenameCount = new Map()
for (const file of tracked) {
  const base = posix.basename(file)
  basenameCount.set(base, (basenameCount.get(base) ?? 0) + 1)
}
const candidatesByBasename = new Map()
for (const file of entryOf.keys()) {
  const base = posix.basename(file)
  const list = candidatesByBasename.get(base) ?? []
  list.push(file)
  candidatesByBasename.set(base, list)
}

// `importLike`: a relative specifier, which may leave out the extension or name a directory index.
function resolveCandidates(path, importLike) {
  const found = []
  if (entryOf.has(path)) {
    found.push(path)
  }
  for (const ext of importLike ? CODE_EXTENSIONS : []) {
    if (entryOf.has(path + ext)) {
      found.push(path + ext)
    }
    if (entryOf.has(`${path}/index${ext}`)) {
      found.push(`${path}/index${ext}`)
    }
  }
  const dir = path.replace(/\/+$/, '')
  if (vanishingDirs.has(dir)) {
    found.push(...vanishingDirs.get(dir))
  }
  return found
}

const TOKEN = /[A-Za-z0-9_@.\-/]+/g
const quoted = (text, word) => ["'", '"', '`'].some((q) => text.includes(`${q}${word}${q}`))

// Candidates `file` (a kept text file) refers to.
function referencesOf(file, text) {
  const found = new Set()
  const words = new Set(text.match(TOKEN) ?? [])
  const dir = posix.dirname(file)
  for (const token of words) {
    if (token.includes('/')) {
      const clean = token.replace(/^\/+/, '')
      const relative = /^\.\.?\//.test(token)
      for (const hit of resolveCandidates(posix.normalize(clean), false)) {
        found.add(hit)
      }
      const fromHere = posix.join(dir, token)
      if (relative && !fromHere.startsWith('..')) {
        for (const hit of resolveCandidates(fromHere, true)) {
          found.add(hit)
        }
      }
      // A path written from a deeper root (`workflows/pr.yml`, `site/public/x.png`).
      const tail = posix.normalize(clean)
      if (!relative && tail.includes('/')) {
        for (const hit of candidatesByBasename.get(posix.basename(tail)) ?? []) {
          if (hit.endsWith(`/${tail}`)) {
            found.add(hit)
          }
        }
      }
    } else if (
      token.includes('.') &&
      basenameCount.get(token) === 1 &&
      candidatesByBasename.has(token)
    ) {
      const hit = candidatesByBasename.get(token)[0]
      const parent = posix.dirname(hit) === '.' ? token : posix.basename(posix.dirname(hit))
      if (quoted(text, parent)) {
        found.add(hit)
      }
    }
  }
  found.delete(file)
  return found
}

const baselineFiles = new Set(manifest.baselines.map(({ file }) => file))

// Which candidates each scanned file refers to, for every file that could end up kept.
const refsByFile = new Map()
for (const file of tracked) {
  if (
    file === MANIFEST ||
    file === SELF ||
    baselineFiles.has(file) ||
    manifest.ignoreReferrers.some((rule) => rule.test(file))
  ) {
    continue
  }
  const stats = lstatSync(file)
  if (!stats.isFile() || stats.size > MAX_SCAN_BYTES || isBinary(file, stats.size)) {
    continue
  }
  const refs = referencesOf(file, readFileSync(file, 'utf8'))
  if (refs.size > 0) {
    refsByFile.set(file, refs)
  }
}

// Hold every candidate a kept file refers to, until nothing changes.
const held = new Map()
const queue = tracked.filter((file) => !entryOf.has(file))
while (queue.length > 0) {
  const referrer = queue.pop()
  for (const target of refsByFile.get(referrer) ?? []) {
    if (held.has(target)) {
      continue
    }
    const entry = entryOf.get(target)
    if (entry.allowReferrers.some((rule) => rule.test(referrer))) {
      continue
    }
    held.set(target, referrer)
    if (!manifest.inertWhenHeld.some((rule) => rule.test(target))) {
      queue.push(target)
    }
  }
}

const pruned = [...entryOf.keys()].filter((file) => !held.has(file)).sort()
const sizeOf = (file) => lstatSync(file).size

// A baseline entry is stale when it names a file this prune deletes, or one the manifest covers
// that is gone already (a re-run on a pruned tree).
const prunedSet = new Set(pruned)
const coveredAndGone = (path) =>
  !existsOnDisk(path) &&
  manifest.entries.some(
    (entry) =>
      entry.paths.some(({ re }) => re.test(path)) && !entry.except.some(({ re }) => re.test(path))
  )
const isStale = (path) => prunedSet.has(path) || coveredAndGone(path)
const baselineEdits = []
for (const baseline of manifest.baselines) {
  if (!existsOnDisk(baseline.file)) {
    continue
  }
  const before = readFileSync(baseline.file, 'utf8')
  let after = before
  let dropped = 0
  if (baseline.format === 'lines') {
    const lines = before.split('\n')
    const kept = lines.filter((line) => line.startsWith('#') || !isStale(line.trim()))
    dropped = lines.length - kept.length
    after = kept.join('\n')
  } else {
    const items = JSON.parse(before)
    const kept = items.filter((item) => !isStale(item[baseline.key]))
    dropped = items.length - kept.length
    if (dropped > 0) {
      after = `${JSON.stringify(kept, null, 2)}\n`
    }
  }
  if (dropped > 0) {
    baselineEdits.push({ file: baseline.file, after, dropped })
  }
}

if (mode === '--check') {
  if (baselineEdits.length > 0) {
    console.error(
      `pod-prune: stale baseline entries left in ${baselineEdits.map(({ file }) => file).join(', ')}`
    )
    process.exit(1)
  }
  if (pruned.length > 0) {
    console.error(
      `pod-prune: ${pruned.length} file(s) left to prune:\n  ${pruned.slice(0, 50).join('\n  ')}`
    )
    process.exit(1)
  }
  console.log(
    `pod-prune: nothing left to prune (${held.size} file(s) held back by kept references)`
  )
  process.exit(0)
}

const perEntry = new Map(
  manifest.entries.map((entry) => [entry.id, { files: 0, bytes: 0, held: 0 }])
)
for (const file of pruned) {
  const stats = perEntry.get(entryOf.get(file).id)
  stats.files++
  stats.bytes += sizeOf(file)
}
for (const file of held.keys()) {
  perEntry.get(entryOf.get(file).id).held++
}

const total = pruned.reduce((sum, file) => sum + sizeOf(file), 0)
console.log(
  `pod-prune: ${mode === '--apply' ? 'pruning' : 'would prune'} ${pruned.length} file(s), ${(total / 1e6).toFixed(2)} MB; ${held.size} held back`
)
for (const entry of manifest.entries) {
  const { files, bytes, held: kept } = perEntry.get(entry.id)
  console.log(
    `  ${entry.id} (${entry.category}): ${files} file(s), ${(bytes / 1e6).toFixed(2)} MB${kept ? `, ${kept} held` : ''}`
  )
}
if (held.size > 0) {
  console.log('held back (file <- kept referrer):')
  for (const [file, referrer] of [...held].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`  ${file} <- ${referrer}`)
  }
}
for (const { file, dropped } of baselineEdits) {
  console.log(`  ${file}: drops ${dropped} stale entr${dropped === 1 ? 'y' : 'ies'}`)
}
if (mode === '--plan' && process.env.POD_PRUNE_LIST) {
  console.log('pruned:')
  for (const file of pruned) {
    console.log(`  ${file}`)
  }
}

if (mode === '--apply') {
  for (const { file, after } of baselineEdits) {
    writeFileSync(file, after)
  }
  const dirs = new Set()
  for (const file of pruned) {
    rmSync(file, { force: true })
    dirs.add(posix.dirname(file))
  }
  // Drop directories the prune emptied, deepest first.
  for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
    for (let d = dir; d !== '.'; d = posix.dirname(d)) {
      try {
        if (readdirSync(d).length > 0) {
          break
        }
        rmdirSync(d)
      } catch {
        break
      }
    }
  }
}
