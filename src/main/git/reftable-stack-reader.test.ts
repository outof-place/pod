import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createReftableReader,
  readReftableHeadStamp,
  REFTABLE_UNREADABLE
} from './reftable-stack-reader'
import { createReftableRepoWithWorktree, GIT_SUPPORTS_REFTABLE, runGit } from './reftable-test-repo'

type RecordSpec =
  | { name: string; oid: string; peeled?: string }
  | { name: string; symref: string }
  | { name: string; deleted: true }

const OID_A = 'a'.repeat(40)
const OID_B = 'b'.repeat(40)

// Inverse of the spec varint: each continuation byte carries value - 1.
function varint(value: number): Buffer {
  const bytes = [value & 0x7f]
  let rest = Math.floor(value / 128)
  while (rest > 0) {
    rest -= 1
    bytes.unshift(0x80 | (rest & 0x7f))
    rest = Math.floor(rest / 128)
  }
  return Buffer.from(bytes)
}

function uint(value: number, bytes: number): Buffer {
  const out = Buffer.alloc(bytes)
  out.writeUIntBE(value, bytes - Math.min(bytes, 6), Math.min(bytes, 6))
  return out
}

function encodeRecord(previous: Buffer, spec: RecordSpec): [Buffer, Buffer] {
  const name = Buffer.from(spec.name, 'utf8')
  let prefix = 0
  while (prefix < previous.length && prefix < name.length && previous[prefix] === name[prefix]) {
    prefix++
  }
  let type = 0
  let value = Buffer.alloc(0)
  if ('oid' in spec) {
    type = spec.peeled ? 2 : 1
    value = Buffer.from(spec.oid + (spec.peeled ?? ''), 'hex')
  } else if ('symref' in spec) {
    type = 3
    value = Buffer.concat([varint(Buffer.byteLength(spec.symref)), Buffer.from(spec.symref)])
  }
  const suffix = name.subarray(prefix)
  const record = Buffer.concat([
    varint(prefix),
    varint(suffix.length * 8 + type),
    suffix,
    varint(0),
    value
  ])
  return [record, name]
}

function encodeTable(
  blocks: RecordSpec[][],
  { blockSize = 0, sha256 = false }: { blockSize?: number; sha256?: boolean } = {}
): Buffer {
  const header = Buffer.concat([
    Buffer.from('REFT'),
    uint(sha256 ? 2 : 1, 1),
    uint(blockSize, 3),
    uint(1, 8),
    uint(1, 8),
    sha256 ? Buffer.from('s256') : Buffer.alloc(0)
  ])
  const out: Buffer[] = [header]
  let offset = header.length
  let blockStart = 0
  for (const records of blocks) {
    let previous: Buffer = Buffer.alloc(0)
    const encoded = records.map((spec) => {
      const [record, name] = encodeRecord(previous, spec)
      previous = name
      return record
    })
    const body = Buffer.concat(encoded)
    const firstRecord = offset - blockStart + 4
    const blockLength = firstRecord + body.length + 3 + 2
    const block = Buffer.concat([
      Buffer.from('r'),
      uint(blockLength, 3),
      body,
      uint(firstRecord, 3),
      uint(1, 2)
    ])
    out.push(block)
    offset += block.length
    if (blockSize > 0) {
      out.push(Buffer.alloc(blockStart + blockSize - offset))
      blockStart += blockSize
      offset = blockStart
    } else {
      blockStart = offset
    }
  }
  // Footer stand-in: starts with the header magic, never a ref block type.
  out.push(header, Buffer.alloc(44))
  return Buffer.concat(out)
}

describe('createReftableReader', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  async function writeStack(
    tables: Record<string, Buffer>,
    list = Object.keys(tables)
  ): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'orca-reftable-reader-'))
    roots.push(root)
    const stackDir = join(root, 'reftable')
    await mkdir(stackDir)
    await Promise.all(
      Object.entries(tables).map(([name, bytes]) => writeFile(join(stackDir, name), bytes))
    )
    await writeFile(join(stackDir, 'tables.list'), list.map((name) => `${name}\n`).join(''))
    return stackDir
  }

  it('decodes symref, oid and peeled records across prefix-compressed names', async () => {
    const stackDir = await writeStack({
      '0x01-0x01-aaaa.ref': encodeTable([
        [
          { name: 'HEAD', symref: 'refs/heads/main' },
          { name: 'refs/heads/feature', oid: OID_A },
          { name: 'refs/heads/main', oid: OID_B },
          { name: 'refs/tags/v1', oid: OID_A, peeled: OID_B }
        ]
      ])
    })
    const read = createReftableReader()
    expect(await read(stackDir, 'HEAD')).toEqual({ kind: 'symref', target: 'refs/heads/main' })
    expect(await read(stackDir, 'refs/heads/main')).toEqual({ kind: 'oid', oid: OID_B })
    expect(await read(stackDir, 'refs/tags/v1')).toEqual({ kind: 'oid', oid: OID_A })
    expect(await read(stackDir, 'refs/heads/gone')).toBeNull()
    expect(await read(stackDir, 'refs/zzz')).toBeNull()
  })

  it('reads 32-byte object ids from a version 2 SHA-256 table', async () => {
    const oid = 'c'.repeat(64)
    const stackDir = await writeStack({
      '0x01-0x01-bbbb.ref': encodeTable([[{ name: 'refs/heads/main', oid }]], { sha256: true })
    })
    expect(await createReftableReader()(stackDir, 'refs/heads/main')).toEqual({ kind: 'oid', oid })
  })

  it('lets the newest table win, including a deletion tombstone', async () => {
    const stackDir = await writeStack({
      '0x01-0x01-old1.ref': encodeTable([
        [
          { name: 'refs/heads/main', oid: OID_A },
          { name: 'refs/heads/topic', oid: OID_A }
        ]
      ]),
      '0x02-0x02-new1.ref': encodeTable([
        [
          { name: 'refs/heads/main', oid: OID_B },
          { name: 'refs/heads/topic', deleted: true }
        ]
      ])
    })
    const read = createReftableReader()
    expect(await read(stackDir, 'refs/heads/main')).toEqual({ kind: 'oid', oid: OID_B })
    expect(await read(stackDir, 'refs/heads/topic')).toBeNull()
  })

  it.each([
    ['aligned and NUL-padded', 256],
    ['unaligned', 0]
  ])('walks %s ref blocks', async (_label, blockSize) => {
    const first = Array.from({ length: 4 }, (_, index) => ({
      name: `refs/heads/a${index}`,
      oid: OID_A
    }))
    const stackDir = await writeStack({
      '0x01-0x01-cccc.ref': encodeTable([first, [{ name: 'refs/heads/z', oid: OID_B }]], {
        blockSize
      })
    })
    expect(await createReftableReader()(stackDir, 'refs/heads/z')).toEqual({
      kind: 'oid',
      oid: OID_B
    })
  })

  it('treats a log-only or empty table as holding no refs', async () => {
    const stackDir = await writeStack({ '0x01-0x01-dddd.ref': encodeTable([]) })
    expect(await createReftableReader()(stackDir, 'HEAD')).toBeNull()
  })

  it('reports a missing stack as absent and a corrupt one as unreadable', async () => {
    const read = createReftableReader()
    expect(await read(join(tmpdir(), 'orca-no-such-reftable'), 'HEAD')).toBeNull()
    const corrupt = await writeStack({
      '0x01-0x01-eeee.ref': Buffer.from('not a reftable at all, sorry')
    })
    expect(await read(corrupt, 'HEAD')).toBe(REFTABLE_UNREADABLE)
    const escaping = await writeStack({}, ['../outside.ref'])
    expect(await read(escaping, 'HEAD')).toBe(REFTABLE_UNREADABLE)
  })

  it('re-reads the list once when compaction removed a listed table', async () => {
    const stackDir = await writeStack({
      '0x01-0x01-ffff.ref': encodeTable([[{ name: 'refs/heads/main', oid: OID_A }]])
    })
    const read = createReftableReader()
    expect(await read(stackDir, 'refs/heads/main')).toEqual({ kind: 'oid', oid: OID_A })
    await writeFile(
      join(stackDir, '0x01-0x02-1111.ref'),
      encodeTable([
        [
          { name: 'refs/heads/main', oid: OID_A },
          { name: 'refs/heads/new', oid: OID_B }
        ]
      ])
    )
    await writeFile(join(stackDir, 'tables.list'), '0x01-0x02-1111.ref\n')
    await rm(join(stackDir, '0x01-0x01-ffff.ref'))
    expect(await read(stackDir, 'refs/heads/new')).toEqual({ kind: 'oid', oid: OID_B })
  })
})

describe.skipIf(!GIT_SUPPORTS_REFTABLE)('reftable stacks written by real git', () => {
  let root: string

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'orca-reftable-git-')))
    const globalConfig = join(root, 'gitconfig')
    await writeFile(globalConfig, '')
    vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig)
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  })

  it.each(['sha1', 'sha256'] as const)(
    'matches rev-parse across multi-block %s tables, compaction and deletion',
    async (objectFormat) => {
      const { repo, commonDir } = createReftableRepoWithWorktree(root, objectFormat)
      const oid = runGit(repo, ['rev-parse', 'HEAD'])
      const names = Array.from(
        { length: 3000 },
        (_, index) => `refs/heads/bulk-${String(index).padStart(4, '0')}`
      )
      runGit(
        repo,
        ['update-ref', '--stdin'],
        names.map((name) => `create ${name} ${oid}\n`).join('')
      )
      runGit(repo, ['pack-refs', '--all'])
      runGit(repo, ['branch', '--quiet', '-D', 'bulk-0007'])
      const stackDir = join(commonDir, 'reftable')
      const read = createReftableReader()
      expect(await read(stackDir, 'refs/heads/bulk-2999')).toEqual({ kind: 'oid', oid })
      expect(await read(stackDir, 'refs/heads/bulk-0007')).toBeNull()
      expect(await read(stackDir, 'HEAD')).toEqual({ kind: 'symref', target: 'refs/heads/main' })
    }
  )

  it('stamps both stacks so a HEAD move in a linked worktree changes the stamp', async () => {
    const { repo, worktree, commonDir, entryDir } = createReftableRepoWithWorktree(root)
    const before = await readReftableHeadStamp(entryDir, commonDir)
    expect(await readReftableHeadStamp(entryDir, commonDir)).toBe(before)
    runGit(worktree, ['update-ref', '--no-deref', 'HEAD', runGit(repo, ['rev-parse', 'HEAD'])])
    expect(await readReftableHeadStamp(entryDir, commonDir)).not.toBe(before)
  })
})
