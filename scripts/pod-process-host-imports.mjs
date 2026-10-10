#!/usr/bin/env node
// Generated layer (pod-stack.json "generated"): Pod branches cut before Orca #26963 import the
// subprocess helpers from src/shared/child-process/run-process, which #26963 replaced with the
// @orca/process-host package. This rewrites those imports on the assembled stack until every Pod
// branch is rebased past #26963.
//
//   node scripts/pod-process-host-imports.mjs --apply   rewrite the imports
//   node scripts/pod-process-host-imports.mjs --check   exit 1 if anything is left to rewrite
//
// It does nothing on an Orca base that still has the old module, and exits 2 on an import it does
// not know how to rewrite.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const mode = process.argv[2]
if (mode !== '--apply' && mode !== '--check') {
  console.error('usage: pod-process-host-imports.mjs --apply | --check')
  process.exit(1)
}
if (existsSync('src/shared/child-process/run-process.ts')) {
  console.log('pod-process-host-imports: the old module still exists here; nothing to do')
  process.exit(0)
}

const IMPORT =
  /^import (type )?\{([^}]*)\} from '(?:\.\.\/)+(?:src\/)?shared\/child-process\/run-process'$/gm
const VALUE_NAMES = new Set(['runProcess', 'spawnProcess', 'runProcessSync'])
// The handle @orca/process-host returns has nullable streams.
const STREAM_RESUME = /^(\s*)(\w+)\.(stdout|stderr)\.resume\(\)$/gm

function filesMentioningOldModule() {
  try {
    return execFileSync('git', ['grep', '-l', '-z', '-I', 'child-process/run-process', '--', 'src', 'tests'], {
      encoding: 'utf8',
      maxBuffer: 64 << 20
    })
      .split('\0')
      .filter((file) => /\.(ts|tsx|mts|cts)$/.test(file))
  } catch (error) {
    // git grep exits 1 when nothing matches.
    if (error.status === 1) {
      return []
    }
    throw error
  }
}
const files = filesMentioningOldModule()

const changed = []
const unknown = []
for (const file of files) {
  const before = readFileSync(file, 'utf8')
  if (!before.includes('child-process/run-process')) {
    continue
  }
  let after = before.replace(IMPORT, (line, isType, list) => {
    const names = list.split(',').map((name) => name.trim()).filter(Boolean)
    if (isType) {
      return `import type { ${names.join(', ')} } from '@orca/process-host/process-spec'`
    }
    if (names.some((name) => !VALUE_NAMES.has(name.replace(/^type /, '')))) {
      unknown.push(`${file}: ${line}`)
      return line
    }
    return `import { ${names.join(', ')} } from '@orca/process-host'`
  })
  if (after !== before && /\bspawnProcess\b/.test(after)) {
    after = after.replace(STREAM_RESUME, '$1$2.$3?.resume()')
  }
  if (after.includes('child-process/run-process')) {
    for (const line of after.split('\n')) {
      if (line.includes('child-process/run-process') && !unknown.some((u) => u.endsWith(line))) {
        unknown.push(`${file}: ${line.trim()}`)
      }
    }
  }
  if (after !== before) {
    changed.push(file)
    if (mode === '--apply') {
      writeFileSync(file, after)
    }
  }
}

if (unknown.length > 0) {
  console.error(`pod-process-host-imports: imports it cannot rewrite:\n  ${unknown.join('\n  ')}`)
  process.exit(2)
}
if (mode === '--check' && changed.length > 0) {
  console.error(`pod-process-host-imports: left to rewrite:\n  ${changed.join('\n  ')}`)
  process.exit(1)
}
console.log(`pod-process-host-imports: ${mode === '--apply' ? 'rewrote' : 'nothing left in'} ${changed.length} file(s)`)
for (const file of changed) {
  console.log(`  ${file}`)
}
