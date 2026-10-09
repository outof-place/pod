// Source Control status poll: Orca 1.4.223's `--untracked-files=all` vs the fix on
// perf/git-status-untracked-cache (8706019): `normal` plus a pathspec-scoped `ls-files --others`
// for each collapsed `? dir/` row.
// Both with GIT_OPTIONAL_LOCKS=0, as Orca polls; read-only on the repo.
//
//   node bench/suites/git-status.mjs [--repo DIR] [--runs 30]
import { execFile, spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import {
  collectSamples,
  commandVersion,
  log,
  summarizeFields,
  writeSuiteResult
} from '../lib/bench-session.mjs'

const { values: options } = parseArgs({
  options: {
    repo: { type: 'string', default: path.join(os.homedir(), 'Documents/portivo-app/Untitled') },
    runs: { type: 'string', default: '30' },
    git: { type: 'string', default: 'git' }
  }
})
const repo = options.repo
const runs = Number(options.runs)
const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' }

function git(args) {
  return new Promise((resolve, reject) => {
    const t0 = process.hrtime.bigint()
    const child = spawn(options.git, args, { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks = []
    child.stdout.on('data', (chunk) => chunks.push(chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      const ms = Number(process.hrtime.bigint() - t0) / 1e6
      if (code !== 0) {
        reject(new Error(`git ${args.join(' ')} exited ${code}`))
      } else {
        resolve({ ms, stdout: Buffer.concat(chunks).toString('utf8') })
      }
    })
  })
}

function resetUntrackedCache() {
  return new Promise((resolve, reject) => {
    execFile(
      options.git,
      ['status', '--porcelain'],
      { cwd: repo, maxBuffer: 64 * 1024 * 1024 },
      (error) => (error ? reject(error) : resolve())
    )
  })
}

const STATUS = ['-c', 'core.quotePath=false', 'status', '--porcelain=v2', '--branch']

function untrackedPaths(porcelain) {
  return porcelain
    .split('\n')
    .filter((line) => line.startsWith('? '))
    .map((line) => line.slice(2))
}

async function orcaPoll() {
  const status = await git([...STATUS, '--untracked-files=all'])
  return { ms: status.ms, untracked: untrackedPaths(status.stdout) }
}

async function podPoll() {
  const t0 = process.hrtime.bigint()
  const status = await git([...STATUS, '--untracked-files=normal'])
  const rows = untrackedPaths(status.stdout)
  const directories = rows.filter((row) => row.endsWith('/'))
  const files = rows.filter((row) => !row.endsWith('/'))
  let listings = 0
  for (let start = 0; start < directories.length; start += 256) {
    const listing = await git([
      'ls-files',
      '-z',
      '--others',
      '--exclude-standard',
      '--full-name',
      '--',
      ...directories.slice(start, start + 256).map((directory) => `:(top,literal)${directory}`)
    ])
    listings += 1
    files.push(...listing.stdout.split('\0').filter(Boolean))
  }
  return {
    ms: Number(process.hrtime.bigint() - t0) / 1e6,
    statusMs: status.ms,
    untracked: files,
    collapsedDirectories: directories.length,
    listings
  }
}

function sameSet(left, right) {
  const a = [...left].sort()
  const b = [...right].sort()
  return a.length === b.length && a.every((value, index) => value === b[index])
}

const repoFacts = {
  path: repo,
  trackedFiles: (await git(['ls-files', '-z'])).stdout.split('\0').filter(Boolean).length,
  fsmonitor:
    (
      await git(['config', '--get', 'core.fsmonitor']).catch(() => ({ stdout: '' }))
    ).stdout.trim() || null,
  untrackedCache:
    (
      await git(['config', '--get', 'core.untrackedCache']).catch(() => ({ stdout: '' }))
    ).stdout.trim() || null
}
log('repo', JSON.stringify(repoFacts))

let mismatches = 0
const samples = await collectSamples({
  label: 'git-status',
  count: runs,
  warmup: 3,
  measure: async (index) => {
    // The untracked cache keeps the mode that last wrote it. A plain `git status` (optional locks
    // on) leaves it in normal mode, the state every terminal and agent keeps it in.
    await resetUntrackedCache()
    // Alternate which variant runs first so cache warmth cannot favour one.
    const first = index % 2 === 0 ? orcaPoll : podPoll
    const second = first === orcaPoll ? podPoll : orcaPoll
    const a = await first()
    const b = await second()
    const orca = first === orcaPoll ? a : b
    const pod = first === orcaPoll ? b : a
    const identical = sameSet(orca.untracked, pod.untracked)
    if (!identical) {
      mismatches += 1
    }
    return {
      orcaMs: orca.ms,
      podMs: pod.ms,
      podStatusMs: pod.statusMs,
      untrackedFiles: orca.untracked.length,
      collapsedDirectories: pod.collapsedDirectories,
      listings: pod.listings,
      identical
    }
  }
})

const stats = summarizeFields(samples, { orcaMs: 'ms', podMs: 'ms', podStatusMs: 'ms' })
const conditions = `${repoFacts.trackedFiles} tracked files, fsmonitor=${repoFacts.fsmonitor}, untrackedCache=${repoFacts.untrackedCache}, GIT_OPTIONAL_LOCKS=0`
writeSuiteResult('git-status', {
  caveats: [
    "Before each sample a plain `git status` (optional locks on) leaves the untracked cache in normal mode, as terminals and agents do; Orca's `all` poll cannot use a cache in that mode."
  ],
  versions: { git: commandVersion(options.git) },
  repo: repoFacts,
  config: { runs, warmup: 3 },
  correctness: {
    mismatchedSamples: mismatches,
    note: 'untracked path set of Pod (normal + ls-files) vs Orca (all), per sample'
  },
  metrics: [
    {
      id: 'git-status.orca',
      subject: 'Orca 1.4.223: status --untracked-files=all',
      metric: 'Source Control status poll',
      unit: 'ms',
      better: 'lower',
      stats: stats.orcaMs,
      conditions
    },
    {
      id: 'git-status.pod',
      subject: 'Pod: status --untracked-files=normal + ls-files per untracked dir',
      branch: 'perf/git-status-untracked-cache',
      upstream: 'https://github.com/stablyai/orca/pull/26979',
      metric: 'Source Control status poll',
      unit: 'ms',
      better: 'lower',
      stats: stats.podMs,
      conditions
    }
  ],
  samples
})
