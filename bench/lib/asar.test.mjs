import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { extractAsar } from './asar.mjs'

// An archive laid out as Electron writes one: size field, header pickle, then the file data.
function writeAsar(file, files, data) {
  const json = Buffer.from(JSON.stringify({ files }))
  const padded = Math.ceil(json.length / 4) * 4
  const pickle = Buffer.alloc(8 + padded)
  pickle.writeUInt32LE(4 + padded, 0)
  pickle.writeUInt32LE(json.length, 4)
  json.copy(pickle, 8)
  const size = Buffer.alloc(8)
  size.writeUInt32LE(4, 0)
  size.writeUInt32LE(pickle.length, 4)
  writeFileSync(file, Buffer.concat([size, pickle, data]))
}

test('files, directories, executables and unpacked files come out byte for byte', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'asar-test-'))
  const asar = path.join(dir, 'app.asar')
  writeAsar(
    asar,
    {
      'package.json': { offset: '0', size: 2 },
      out: { files: { 'main.js': { offset: '2', size: 5 }, tool: { offset: '7', size: 3, executable: true } } },
      native: { files: { 'addon.node': { size: 4, unpacked: true } } }
    },
    Buffer.from('{}hello#!x')
  )
  mkdirSync(path.join(`${asar}.unpacked`, 'native'), { recursive: true })
  writeFileSync(path.join(`${asar}.unpacked`, 'native/addon.node'), 'bin!')
  const out = path.join(dir, 'out')
  assert.equal(extractAsar(asar, out), 4)
  assert.equal(readFileSync(path.join(out, 'package.json'), 'utf8'), '{}')
  assert.equal(readFileSync(path.join(out, 'out/main.js'), 'utf8'), 'hello')
  assert.equal(readFileSync(path.join(out, 'out/tool'), 'utf8'), '#!x')
  assert.equal(statSync(path.join(out, 'out/tool')).mode & 0o111, 0o111)
  assert.equal(readFileSync(path.join(out, 'native/addon.node'), 'utf8'), 'bin!')
})

test('an entry that would land outside the output dir stops the extraction', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'asar-test-'))
  const asar = path.join(dir, 'app.asar')
  writeAsar(asar, { '..': { files: { escaped: { offset: '0', size: 1 } } } }, Buffer.from('x'))
  assert.throws(() => extractAsar(asar, path.join(dir, 'out')), /escapes the output dir/)
})

test('a link whose target leaves the output dir stops the extraction', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'asar-test-'))
  const asar = path.join(dir, 'app.asar')
  writeAsar(asar, { out: { files: { up: { link: '../../elsewhere' } } } }, Buffer.alloc(0))
  assert.throws(() => extractAsar(asar, path.join(dir, 'out')), /link escapes the output dir/)
})
