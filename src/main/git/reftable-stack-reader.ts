import { open, readFile, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'

// Spawn-free reader for Git's reftable ref store (Git ≥ 2.45, spec in
// Documentation/technical/reftable.adoc). Only ref blocks are decoded: a few
// names never need the log, obj or index sections.

/** What every HEAD file holds in a reftable repo; the real HEAD is a stack record. */
export const REFTABLE_HEAD_PLACEHOLDER = 'ref: refs/heads/.invalid'

export const REFTABLE_UNREADABLE = Symbol('reftable-unreadable')
export type ReftableUnreadable = typeof REFTABLE_UNREADABLE

export type ReftableRef = { kind: 'oid'; oid: string } | { kind: 'symref'; target: string }
// A deletion tombstone hides every older table's record for the name.
type TableRecord = ReftableRef | 'deleted' | 'absent'

/** Looks one name up in a stack; null means absent. Each stack's list is read once. */
export type ReftableReader = (
  stackDir: string,
  name: string
) => Promise<ReftableRef | null | ReftableUnreadable>

const REFT_MAGIC = 0x52454654
const HASH_ID_SHA1 = 0x73686131
const HASH_ID_SHA256 = 0x73323536
const BLOCK_TYPE_REF = 0x72
const READ_CHUNK_BYTES = 64 * 1024
// Tables are immutable and uniquely named, so a decoded answer never goes stale.
const TABLE_CACHE_LIMIT = 512
const STALE_LIST_RETRIES = 3
const TABLE_NAME_PATTERN = /^[\w.-]+\.ref$/

class CorruptTableError extends Error {}

function corrupt(): never {
  throw new CorruptTableError('corrupt reftable')
}

function isMissingEntryError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

// Refs sort first and the scan stops past the wanted name, so most lookups
// read one chunk even when the table also carries megabytes of reflog.
class TableBytes {
  private bytes = Buffer.alloc(0)
  private filled = 0

  private constructor(
    private readonly handle: FileHandle,
    private readonly size: number
  ) {}

  static async open(handle: FileHandle): Promise<TableBytes> {
    return new TableBytes(handle, (await handle.stat()).size)
  }

  /** Bytes [0, end) are valid in the returned buffer. */
  async upTo(end: number): Promise<Buffer> {
    if (end > this.size) {
      corrupt()
    }
    if (end > this.bytes.length) {
      // Doubling keeps the total copy linear in the bytes read.
      const capacity = Math.max(end, 2 * this.bytes.length, READ_CHUNK_BYTES)
      const grown = Buffer.allocUnsafe(Math.min(this.size, capacity))
      this.bytes.copy(grown, 0, 0, this.filled)
      this.bytes = grown
    }
    while (this.filled < end) {
      const free = this.bytes.length - this.filled
      const { bytesRead } = await this.handle.read(this.bytes, this.filled, free, this.filled)
      this.filled += bytesRead > 0 ? bytesRead : corrupt()
    }
    return this.bytes
  }
}

// Spec varint: each continuation adds one before shifting.
function readVarint(bytes: Buffer, at: number, end: number): [number, number] {
  if (at >= end) {
    corrupt()
  }
  let byte = bytes[at++]
  let value = byte & 0x7f
  while (byte & 0x80) {
    if (at >= end || value >= 2 ** 45) {
      corrupt()
    }
    byte = bytes[at++]
    value = (value + 1) * 128 + (byte & 0x7f)
  }
  return [value, at]
}

function valueEnd(
  bytes: Buffer,
  at: number,
  end: number,
  type: number,
  hashLength: number
): number {
  let next = at
  if (type === 1 || type === 2) {
    next = at + type * hashLength
  } else if (type === 3) {
    const [length, targetStart] = readVarint(bytes, at, end)
    next = targetStart + length
  } else if (type !== 0) {
    corrupt()
  }
  return next <= end ? next : corrupt()
}

function decodeValue(bytes: Buffer, at: number, type: number, hashLength: number): TableRecord {
  if (type === 1 || type === 2) {
    return { kind: 'oid', oid: bytes.toString('hex', at, at + hashLength) }
  }
  if (type === 3) {
    const [length, targetStart] = readVarint(bytes, at, bytes.length)
    return { kind: 'symref', target: bytes.toString('utf8', targetStart, targetStart + length) }
  }
  return 'deleted'
}

type BlockScan = { name: Buffer; nameLength: number }

// Records are sorted, so the scan settles at the first name not below the wanted one.
function scanRefRecords(
  bytes: Buffer,
  at: number,
  end: number,
  hashLength: number,
  wanted: Buffer,
  scan: BlockScan
): TableRecord | undefined {
  while (at < end) {
    let prefixLength: number
    let typeAndSuffix: number
    ;[prefixLength, at] = readVarint(bytes, at, end)
    ;[typeAndSuffix, at] = readVarint(bytes, at, end)
    const suffixLength = Math.floor(typeAndSuffix / 8)
    const type = typeAndSuffix % 8
    if (prefixLength > scan.nameLength || at + suffixLength > end) {
      corrupt()
    }
    if (scan.name.length < prefixLength + suffixLength) {
      const grown = Buffer.alloc(2 * (prefixLength + suffixLength))
      scan.name.copy(grown, 0, 0, prefixLength)
      scan.name = grown
    }
    bytes.copy(scan.name, prefixLength, at, at + suffixLength)
    scan.nameLength = prefixLength + suffixLength
    ;[, at] = readVarint(bytes, at + suffixLength, end)
    const valueStart = at
    at = valueEnd(bytes, at, end, type, hashLength)
    const order = wanted.compare(scan.name, 0, scan.nameLength)
    if (order === 0) {
      return decodeValue(bytes, valueStart, type, hashLength)
    }
    if (order < 0) {
      return 'absent'
    }
  }
  return undefined
}

async function lookupTable(path: string, name: string): Promise<TableRecord> {
  const handle = await open(path, 'r')
  try {
    const table = await TableBytes.open(handle)
    let bytes = await table.upTo(24)
    if (bytes.readUInt32BE(0) !== REFT_MAGIC || (bytes[4] !== 1 && bytes[4] !== 2)) {
      corrupt()
    }
    const blockSize = bytes.readUIntBE(5, 3)
    let headerLength = 24
    let hashLength = 20
    if (bytes[4] === 2) {
      bytes = await table.upTo(28)
      const hashId = bytes.readUInt32BE(24)
      headerLength = 28
      hashLength = hashId === HASH_ID_SHA1 ? 20 : hashId === HASH_ID_SHA256 ? 32 : corrupt()
    }
    const wanted = Buffer.from(name, 'utf8')
    const scan: BlockScan = { name: Buffer.alloc(256), nameLength: 0 }
    // The first block shares its bytes, length and restart offsets with the header.
    let blockStart = 0
    let at = headerLength
    for (;;) {
      bytes = await table.upTo(at + 4)
      if (bytes[at] !== BLOCK_TYPE_REF) {
        return 'absent'
      }
      const blockEnd = blockStart + bytes.readUIntBE(at + 1, 3)
      if (blockEnd < at + 6) {
        corrupt()
      }
      // A footer always follows the last block, so the byte past it exists.
      bytes = await table.upTo(blockEnd + 1)
      const recordsEnd = blockEnd - 2 - 3 * bytes.readUInt16BE(blockEnd - 2)
      if (recordsEnd <= at + 4) {
        corrupt()
      }
      scan.nameLength = 0
      const found = scanRefRecords(bytes, at + 4, recordsEnd, hashLength, wanted, scan)
      if (found !== undefined) {
        return found
      }
      // Git's own probe: a NUL after the block means padding to the aligned size.
      const next = blockSize > 0 && bytes[blockEnd] === 0 ? blockStart + blockSize : blockEnd
      blockStart = next >= blockEnd ? next : corrupt()
      at = blockStart
    }
  } finally {
    await handle.close()
  }
}

const tableLookups = new Map<string, Map<string, TableRecord>>()

async function lookupTableCached(path: string, name: string): Promise<TableRecord> {
  const names = tableLookups.get(path) ?? new Map<string, TableRecord>()
  let record = names.get(name)
  if (record === undefined) {
    record = await lookupTable(path, name)
    names.set(name, record)
  }
  // Re-insert so eviction drops the least recently used table first.
  tableLookups.delete(path)
  tableLookups.set(path, names)
  for (const oldest of tableLookups.keys()) {
    if (tableLookups.size <= TABLE_CACHE_LIMIT) {
      break
    }
    tableLookups.delete(oldest)
  }
  return record
}

/** Table names oldest first; null when the dir holds no stack. */
async function readStackList(stackDir: string): Promise<string[] | null | ReftableUnreadable> {
  let content: string
  try {
    content = await readFile(join(stackDir, 'tables.list'), 'utf8')
  } catch (error) {
    return isMissingEntryError(error) ? null : REFTABLE_UNREADABLE
  }
  const tables = content.split('\n').filter(Boolean)
  // Names are spliced into paths: anything but a plain table file name is not Git's.
  return tables.every((table) => TABLE_NAME_PATTERN.test(table)) ? tables : REFTABLE_UNREADABLE
}

/** Newest table wins; compaction can delete a listed table, so a vanished one re-reads the list. */
export function createReftableReader(): ReftableReader {
  const lists = new Map<string, Promise<string[] | null | ReftableUnreadable>>()
  const listFor = (stackDir: string): Promise<string[] | null | ReftableUnreadable> => {
    let list = lists.get(stackDir)
    if (!list) {
      list = readStackList(stackDir)
      lists.set(stackDir, list)
    }
    return list
  }
  return async (stackDir, name) => {
    for (let attempt = 0; attempt < STALE_LIST_RETRIES; attempt++) {
      const tables = await listFor(stackDir)
      if (tables === null || tables === REFTABLE_UNREADABLE) {
        return tables
      }
      try {
        for (let index = tables.length - 1; index >= 0; index--) {
          const record = await lookupTableCached(join(stackDir, tables[index]), name)
          if (record !== 'absent') {
            return record === 'deleted' ? null : record
          }
        }
        return null
      } catch (error) {
        if (!isMissingEntryError(error)) {
          return REFTABLE_UNREADABLE
        }
        lists.delete(stackDir)
      }
    }
    return REFTABLE_UNREADABLE
  }
}

async function readStackListText(stackDir: string): Promise<string | null> {
  try {
    return await readFile(join(stackDir, 'tables.list'), 'utf8')
  } catch (error) {
    if (isMissingEntryError(error)) {
      return null
    }
    throw error
  }
}

/** Exact stamp of every ref a HEAD can resolve through: the shared stack's
 *  list plus a linked worktree's own. Unique immutable tables make equal lists
 *  mean no ref moved. Throws on read failures other than absence. */
export async function readReftableHeadStamp(adminDir: string, commonDir: string): Promise<string> {
  const stackDirs = adminDir === commonDir ? [commonDir] : [commonDir, adminDir]
  return JSON.stringify(
    await Promise.all(stackDirs.map((dir) => readStackListText(join(dir, 'reftable'))))
  )
}
