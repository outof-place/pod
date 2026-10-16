// Extracts an Electron app.asar (and the files its .unpacked sibling holds) into a directory, so a
// suite can load the app's own JavaScript in plain Node.
//
// Format: a 4-byte size, then a pickle holding the JSON header ({ files: { name: entry } }, where
// an entry is a directory { files }, a link { link } or a file { offset, size, unpacked?,
// executable? }); file offsets count from the end of the header pickle.
import { chmodSync, closeSync, copyFileSync, mkdirSync, openSync, readSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

function readHeader(fd) {
  const prefix = Buffer.alloc(16)
  readSync(fd, prefix, 0, 16, 0)
  const headerPickleSize = prefix.readUInt32LE(4)
  const jsonLength = prefix.readUInt32LE(12)
  const json = Buffer.alloc(jsonLength)
  readSync(fd, json, 0, jsonLength, 16)
  return { header: JSON.parse(json.toString('utf8')), dataStart: 8 + headerPickleSize }
}

/** Writes every file of `asarPath` under `outDir`; returns the number of files written. */
export function extractAsar(asarPath, outDir) {
  const fd = openSync(asarPath, 'r')
  let count = 0
  try {
    const { header, dataStart } = readHeader(fd)
    const walk = (files, rel) => {
      for (const [name, entry] of Object.entries(files)) {
        const relPath = path.join(rel, name)
        const target = path.join(outDir, relPath)
        if (!target.startsWith(outDir + path.sep)) {
          throw new Error(`asar entry escapes the output dir: ${relPath}`)
        }
        if (entry.files) {
          mkdirSync(target, { recursive: true })
          walk(entry.files, relPath)
        } else if (entry.link) {
          symlinkSync(entry.link, target)
        } else {
          mkdirSync(path.dirname(target), { recursive: true })
          if (entry.unpacked) {
            copyFileSync(path.join(`${asarPath}.unpacked`, relPath), target)
          } else {
            const data = Buffer.alloc(entry.size)
            readSync(fd, data, 0, entry.size, dataStart + Number(entry.offset))
            writeFileSync(target, data)
          }
          if (entry.executable) {
            chmodSync(target, 0o755)
          }
          count += 1
        }
      }
    }
    mkdirSync(outDir, { recursive: true })
    walk(header.files, '')
  } finally {
    closeSync(fd)
  }
  return count
}
