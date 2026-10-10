#!/usr/bin/env node
// Release gate: code the app runs must never write into its own bundle. A Python __pycache__
// under Resources/claude-acc broke the seal of 0.0.1-test, and Gatekeeper then called the
// installed app damaged. Runs the bundle's script entry points from a temporary copy (the
// probes come from the claude-acc layer when it is stacked), then requires the copy to be
// unchanged and its signature to verify.
//
//   node product/scripts/verify-bundle-seal.mjs <Pod.app>
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

const require = createRequire(import.meta.url)
const PROBES_CONFIG = new URL('../../config/pod-acc-extra-resources.cjs', import.meta.url).pathname

/** Files under `dir` named __pycache__ or *.pyc whose mtime is after `since`. */
export function bytecodeWrittenAfter(dir, since) {
  const found = []
  const walk = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name)
      if (entry.isSymbolicLink()) {
        continue
      }
      const isBytecode = entry.name === '__pycache__' || entry.name.endsWith('.pyc')
      if (isBytecode && statSync(child).mtimeMs > since) {
        found.push(child)
      } else if (entry.isDirectory()) {
        walk(child)
      }
    }
  }
  walk(dir)
  return found
}

function sealProbes(app) {
  if (!existsSync(PROBES_CONFIG)) {
    return []
  }
  const config = require(PROBES_CONFIG)
  return typeof config.podAccSealProbes === 'function' ? config.podAccSealProbes(app) : []
}

function main() {
  const source = process.argv[2]
  if (!source || !existsSync(join(source, 'Contents', 'Info.plist'))) {
    console.error('usage: node product/scripts/verify-bundle-seal.mjs <Pod.app>')
    process.exit(2)
  }
  const staging = mkdtempSync(join(tmpdir(), 'pod-seal-'))
  const app = join(staging, basename(source))
  try {
    execFileSync('/usr/bin/ditto', [source, app])
    const before = Date.now()
    const probes = sealProbes(app)
    for (const probe of probes) {
      const result = spawnSync(probe.command, probe.args ?? [], {
        encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: staging, ...probe.env },
        timeout: 60_000
      })
      if (result.status !== 0) {
        throw new Error(`probe ${probe.name} exited ${result.status}: ${result.stderr.trim()}`)
      }
    }
    const written = bytecodeWrittenAfter(app, before)
    if (written.length > 0) {
      throw new Error(`the bundle wrote bytecode into itself:\n  ${written.join('\n  ')}`)
    }
    const seal = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], {
      encoding: 'utf8'
    })
    if (seal.status !== 0) {
      throw new Error(`seal broken after ${probes.length} probe(s):\n${seal.stderr.trim()}`)
    }
    console.log(`bundle seal: intact after ${probes.length} probe(s)`)
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  try {
    main()
  } catch (error) {
    console.error(`bundle seal: ${error.message}`)
    process.exit(1)
  }
}
