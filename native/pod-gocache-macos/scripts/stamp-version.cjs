#!/usr/bin/env node
// Records which helper sources scripts/VERSION names (scripts/VERSION.stamp), so a change to them
// cannot ship under a VERSION Pod already installed (it replaces only an older helper).
//
//   node native/pod-gocache-macos/scripts/stamp-version.cjs           stamp, refused for new sources
//                                                                     under an unchanged VERSION
//   node native/pod-gocache-macos/scripts/stamp-version.cjs --check   exit 1 when the stamp is stale
//
// An unreleased VERSION may be re-stamped by deleting VERSION.stamp first.
const { createHash } = require('node:crypto')
const { existsSync, readdirSync, readFileSync, writeFileSync } = require('node:fs')
const { join, relative, sep } = require('node:path')

const MODULE = join(__dirname, '..')
// go build never reads these for the helper.
const SKIPPED_DIRS = new Set(['bench', 'scripts', 'testdata'])

function isHelperSource(name) {
  return (
    (name.endsWith('.go') && !name.endsWith('_test.go')) || name === 'go.mod' || name === 'go.sum'
  )
}

function helperSources(dir) {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) {
      continue
    }
    const path = join(dir, entry.name)
    if (entry.isDirectory() && !SKIPPED_DIRS.has(entry.name)) {
      files.push(...helperSources(path))
    } else if (entry.isFile() && isHelperSource(entry.name)) {
      files.push(path)
    }
  }
  return files
}

/** sha256 over each source's module-relative path and bytes, in path order. */
function helperSourceHash(moduleDir = MODULE) {
  const hash = createHash('sha256')
  const files = helperSources(moduleDir)
    .map((path) => ({ path, name: relative(moduleDir, path).split(sep).join('/') }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const { path, name } of files) {
    hash.update(`${name}\0`)
    hash.update(readFileSync(path))
    hash.update('\0')
  }
  return hash.digest('hex')
}

function readVersion(moduleDir) {
  return readFileSync(join(moduleDir, 'scripts', 'VERSION'), 'utf8').trim()
}

function readStamp(moduleDir) {
  const path = join(moduleDir, 'scripts', 'VERSION.stamp')
  if (!existsSync(path)) {
    return null
  }
  const [version, hash] = readFileSync(path, 'utf8').trim().split(/\s+/)
  return { version, hash }
}

/** What is wrong with the stamp; empty when VERSION names exactly these sources. */
function stampProblems(moduleDir = MODULE) {
  const stamp = readStamp(moduleDir)
  if (!stamp) {
    return ['scripts/VERSION.stamp is missing: run scripts/stamp-version.cjs']
  }
  const problems = []
  if (stamp.hash !== helperSourceHash(moduleDir)) {
    problems.push(
      `the helper's sources changed since VERSION ${stamp.version} was stamped: bump scripts/VERSION, then run scripts/stamp-version.cjs`
    )
  }
  if (stamp.version !== readVersion(moduleDir)) {
    problems.push(
      `scripts/VERSION is not the stamped ${stamp.version}: run scripts/stamp-version.cjs`
    )
  }
  return problems
}

/** Writes the stamp; returns why it refused, or null. */
function stampVersion(moduleDir = MODULE) {
  const version = readVersion(moduleDir)
  const hash = helperSourceHash(moduleDir)
  const stamp = readStamp(moduleDir)
  if (stamp && stamp.version === version && stamp.hash !== hash) {
    return `the helper's sources changed under VERSION ${version}: bump scripts/VERSION first`
  }
  writeFileSync(join(moduleDir, 'scripts', 'VERSION.stamp'), `${version} ${hash}\n`)
  return null
}

module.exports = { helperSourceHash, stampProblems, stampVersion }

if (require.main === module) {
  const check = process.argv.includes('--check')
  const problems = check ? stampProblems() : [stampVersion()].filter(Boolean)
  for (const problem of problems) {
    console.error(`stamp-version: ${problem}`)
  }
  process.exit(problems.length > 0 ? 1 : 0)
}
