#!/usr/bin/env node
// Fork-only (Pod): provenance of the orcad deployment template (design D2) that
// .github/workflows/pod-orcad-template.yml builds and the macOS release ships. A lane's node-pty
// slot and the merged template each travel as `<name>/`, `<name>.source` (`pod <commit>`, the
// template also `run <id>`) and `<name>.SHA256SUMS` (every file), so the merge and a release can
// refuse bytes built from another commit or changed after the build.
//
//   node config/scripts/pod-orcad-template-provenance.mjs targets
//   node config/scripts/pod-orcad-template-provenance.mjs stage-lane <prebuilds> <out> <commit>
//   node config/scripts/pod-orcad-template-provenance.mjs check-lanes <lanes> <commit> <slot,slot>
//   node config/scripts/pod-orcad-template-provenance.mjs stage-template <template> <out> <commit> <run>
//   node config/scripts/pod-orcad-template-provenance.mjs check-template <dir> <commit> <run>
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, relative, sep } from 'node:path'

const require = createRequire(import.meta.url)
const COMMIT = /^[0-9a-f]{40}$/
const RUN_ID = /^[1-9][0-9]*$/
const SUMS_LINE = /^([0-9a-f]{64}) {2}(.+)$/
export const LANE_PAYLOAD = 'prebuilds'
export const TEMPLATE_PAYLOAD = 'orcad-template'
export const LANE_ARTIFACT_PREFIX = 'pod-orcad-lane-'

function fail(message) {
  throw new Error(`[pod-orcad-template-provenance] ${message}`)
}

function requireCommit(commit) {
  if (!COMMIT.test(commit ?? '')) {
    fail(`${commit} is not a full commit SHA`)
  }
}

function requireRunId(runId) {
  if (!RUN_ID.test(runId ?? '')) {
    fail(`${runId} is not a run id`)
  }
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** Every file under `dir` as sorted `/` paths from `base`; links and special files are refused. */
function listFiles(dir, base) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => {
      if (entry.isDirectory()) {
        return false
      }
      if (!entry.isFile()) {
        fail(`${join(entry.parentPath, entry.name)} is not a regular file`)
      }
      return true
    })
    .map((entry) => relative(base, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .sort()
}

export function laneSource(commit) {
  return `pod ${commit}\n`
}

export function templateSource(commit, runId) {
  return `pod ${commit}\nrun ${runId}\n`
}

/** Copies `fromDir` to `<outDir>/<name>` and writes its `.source` and `.SHA256SUMS` beside it. */
export function stagePayload(fromDir, outDir, name, source) {
  const payloadDir = join(outDir, name)
  if (existsSync(payloadDir)) {
    fail(`${payloadDir} already exists`)
  }
  mkdirSync(outDir, { recursive: true })
  cpSync(fromDir, payloadDir, { recursive: true })
  const files = listFiles(payloadDir, outDir)
  if (files.length === 0) {
    fail(`${fromDir} holds no files`)
  }
  writeFileSync(
    join(outDir, `${name}.SHA256SUMS`),
    files.map((file) => `${sha256(join(outDir, ...file.split('/')))}  ${file}\n`).join('')
  )
  writeFileSync(join(outDir, `${name}.source`), source)
}

/** The payload must carry exactly `source` and exactly the files its SHA256SUMS lists. */
export function checkPayload(dir, name, source) {
  const sourcePath = join(dir, `${name}.source`)
  const recorded = existsSync(sourcePath) ? readFileSync(sourcePath, 'utf8') : '(missing)'
  if (recorded !== source) {
    fail(`${sourcePath} reads ${JSON.stringify(recorded)}, not ${JSON.stringify(source)}`)
  }
  const sumsPath = join(dir, `${name}.SHA256SUMS`)
  if (!existsSync(sumsPath)) {
    fail(`${sumsPath} is missing`)
  }
  const listed = new Map()
  for (const line of readFileSync(sumsPath, 'utf8').split('\n').filter(Boolean)) {
    const match = SUMS_LINE.exec(line)
    const path = match?.[2]
    if (!match || !path.startsWith(`${name}/`) || path.split('/').includes('..')) {
      fail(`${sumsPath} has an invalid line: ${line}`)
    }
    if (listed.has(path)) {
      fail(`${sumsPath} lists ${path} twice`)
    }
    listed.set(path, match[1])
  }
  const files = existsSync(join(dir, name)) ? listFiles(join(dir, name), dir) : []
  const unlisted = files.filter((file) => !listed.has(file))
  const missing = [...listed.keys()].filter((file) => !files.includes(file))
  if (files.length === 0 || unlisted.length > 0 || missing.length > 0) {
    fail(
      `${join(dir, name)} does not match ${sumsPath}: unlisted [${unlisted.join(', ')}], missing [${missing.join(', ')}]`
    )
  }
  for (const [file, expected] of listed) {
    if (sha256(join(dir, ...file.split('/'))) !== expected) {
      fail(`${file} checksum mismatch`)
    }
  }
}

/** Each expected slot's lane, downloaded as `<lanes>/pod-orcad-lane-<slot>`, built from `commit`. */
export function checkLanes(lanesDir, commit, slots) {
  requireCommit(commit)
  const expected = slots.map((slot) => `${LANE_ARTIFACT_PREFIX}${slot}`).sort()
  const found = readdirSync(lanesDir).sort()
  if (expected.length === 0 || found.join(',') !== expected.join(',')) {
    fail(`${lanesDir} holds [${found.join(', ')}], not [${expected.join(', ')}]`)
  }
  for (const lane of found) {
    checkPayload(join(lanesDir, lane), LANE_PAYLOAD, laneSource(commit))
  }
}

/** The targets the Pod profile's packaged template carries (product/pod-slim-packaging.cjs). */
export function podTemplateTargets() {
  require('../../product/pod-slim-packaging.cjs').preparePodSlimPackaging('pod')
  return [...require('./packaged-orcad-template.cjs').PACKAGED_ORCAD_TEMPLATE_TARGETS]
}

/** A downloaded template: run `runId`'s bytes for `commit`, and a complete Pod template. */
export function checkTemplate(dir, commit, runId) {
  requireCommit(commit)
  requireRunId(runId)
  checkPayload(dir, TEMPLATE_PAYLOAD, templateSource(commit, runId))
  const { verifyPackagedOrcadTemplate } = require('./verify-packaged-orcad-template.cjs')
  verifyPackagedOrcadTemplate(dir, podTemplateTargets())
}

function main([command, ...args]) {
  switch (command) {
    case 'targets':
      process.stdout.write(`${podTemplateTargets().join(',')}\n`)
      return
    case 'stage-lane': {
      const [prebuildsDir, outDir, commit] = args
      requireCommit(commit)
      stagePayload(prebuildsDir, outDir, LANE_PAYLOAD, laneSource(commit))
      return
    }
    case 'check-lanes': {
      const [lanesDir, commit, slots] = args
      checkLanes(lanesDir, commit, (slots ?? '').split(',').filter(Boolean))
      return
    }
    case 'stage-template': {
      const [templateDir, outDir, commit, runId] = args
      requireCommit(commit)
      requireRunId(runId)
      stagePayload(templateDir, outDir, TEMPLATE_PAYLOAD, templateSource(commit, runId))
      return
    }
    case 'check-template': {
      const [dir, commit, runId] = args
      checkTemplate(dir, commit, runId)
      return
    }
    default:
      fail(`unknown command ${command ?? '(none)'}; see the usage at the top of this file`)
  }
}

if (process.argv[1]?.endsWith('pod-orcad-template-provenance.mjs')) {
  main(process.argv.slice(2))
}
