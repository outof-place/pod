import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { preparePython } from './fetch-pod-python.mjs'

const FETCHED = resolve(import.meta.dirname, '..', '..', 'resources', 'python')

const roots = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function files(dir, suffix, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      files(path, suffix, out)
    } else if (entry.name.endsWith(suffix)) {
      out.push(path)
    }
  }
  return out
}

// the 32-bit flags word after the magic: 0b01 is a hash-based .pyc whose source is never checked
const flags = (pyc) => readFileSync(pyc).readUInt32LE(4)

describe.skipIf(!existsSync(join(FETCHED, 'bin/python3')))('the embedded Python', () => {
  it('ships only unchecked-hash bytecode, and never rewrites it into the bundle', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'pod-python-')), 'python')
    roots.push(dirname(dir))
    // a byte copy, as electron-builder makes: every source gets a new mtime
    cpSync(FETCHED, dir, { recursive: true, verbatimSymlinks: true })
    preparePython(dir)
    const compiled = files(join(dir, 'lib/python3.14'), '.pyc')
    expect(compiled.length).toBeGreaterThan(400)
    expect(compiled.filter((pyc) => flags(pyc) !== 1)).toEqual([])

    const later = new Date(Date.now() + 60_000)
    for (const source of files(join(dir, 'lib/python3.14'), '.py')) {
      utimesSync(source, later, later)
    }
    const marker = join(dirname(dir), 'marker')
    writeFileSync(marker, '')
    const before = statSync(marker).mtimeMs
    const ran = spawnSync(
      join(dir, 'bin/python3'),
      [
        '-I',
        '-c',
        'import json, email.parser, asyncio, sqlite3, urllib.request, subprocess, pathlib, plistlib'
      ],
      { encoding: 'utf8' }
    )
    expect(ran.status, ran.stderr).toBe(0)
    const written = files(dir, '.pyc').filter((pyc) => statSync(pyc).mtimeMs > before)
    expect(written).toEqual([])
  })
})
