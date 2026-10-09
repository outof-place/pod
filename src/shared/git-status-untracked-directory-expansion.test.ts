import { describe, expect, it, vi, type Mock } from 'vitest'
import { StatusPorcelainParser } from './git-status-porcelain-parser'
import {
  buildUntrackedDirectoryListingArgs,
  expandUntrackedDirectoryRecords,
  statusUntrackedFilesArg,
  type UntrackedDirectoryListingStream
} from './git-status-untracked-directory-expansion'

function parseStatus(output: string): StatusPorcelainParser {
  const parser = new StatusPorcelainParser()
  parser.update(output, 0)
  parser.finish()
  return parser
}

function listingFrom(responses: Record<string, string[]>): Mock<UntrackedDirectoryListingStream> {
  return vi.fn<UntrackedDirectoryListingStream>(async (args, onStdout) => {
    const directories = args
      .slice(args.indexOf('--') + 1)
      .map((spec) => spec.slice(':(top,literal)'.length))
    const paths = directories.flatMap((directory) => responses[directory] ?? [])
    return { stoppedEarly: onStdout(paths.map((path) => `${path}\0`).join('')) }
  })
}

function entryPaths(records: { type: string; entry?: { path: string } }[]): string[] {
  return records.flatMap((record) => (record.entry ? [record.entry.path] : []))
}

describe('statusUntrackedFilesArg', () => {
  it('uses the cache-friendly normal mode unless ignored paths are requested', () => {
    expect(statusUntrackedFilesArg(false)).toBe('--untracked-files=normal')
    expect(statusUntrackedFilesArg(true)).toBe('--untracked-files=all')
  })
})

describe('buildUntrackedDirectoryListingArgs', () => {
  it('anchors literal pathspecs to the repository root', () => {
    expect(buildUntrackedDirectoryListingArgs(['new/', '[k]eep/'])).toEqual([
      'ls-files',
      '-z',
      '--others',
      '--exclude-standard',
      '--full-name',
      '--',
      ':(top,literal)new/',
      ':(top,literal)[k]eep/'
    ])
  })
})

describe('expandUntrackedDirectoryRecords', () => {
  it('runs no Git process when status collapsed no directory', async () => {
    const listUntracked = listingFrom({})
    const parser = parseStatus(
      '1 .M N... 100644 100644 100644 aaaa aaaa src/app.ts\n? top.txt\n? linkdir\n'
    )

    await expect(
      expandUntrackedDirectoryRecords({ records: parser.statusRecords, limit: 0, listUntracked })
    ).resolves.toBeNull()
    expect(listUntracked).not.toHaveBeenCalled()
  })

  it('replaces each directory row in place with the files listed under it', async () => {
    const listUntracked = listingFrom({
      'nested/': ['nested/'],
      'new/': ['new/a.ts', 'new/deep/b.ts', 'new/sub/'],
      'sp ace/': ['sp ace/q"uote/f.txt']
    })
    const parser = parseStatus(
      [
        '1 .M N... 100644 100644 100644 aaaa aaaa src/app.ts',
        '? .gitignore',
        '? nested/',
        '? new/',
        '? sp ace/',
        '? top.txt',
        ''
      ].join('\n')
    )

    const expansion = await expandUntrackedDirectoryRecords({
      records: parser.statusRecords,
      limit: 0,
      listUntracked
    })

    expect(listUntracked).toHaveBeenCalledTimes(1)
    expect(listUntracked.mock.calls[0][0]).toEqual(
      buildUntrackedDirectoryListingArgs(['nested/', 'new/', 'sp ace/'])
    )
    expect(entryPaths(expansion!.records)).toEqual([
      'src/app.ts',
      '.gitignore',
      'nested/',
      'new/a.ts',
      'new/deep/b.ts',
      'new/sub/',
      'sp ace/q"uote/f.txt',
      'top.txt'
    ])
    expect(expansion!.records[3]).toEqual({
      type: 'entry',
      entry: { path: 'new/a.ts', status: 'untracked', area: 'untracked' }
    })
    expect(expansion!.stoppedEarly).toBe(false)
    expect(expansion!.statusLength).toBe(8)
  })

  it('reassembles paths that a stdout chunk boundary splits', async () => {
    const listUntracked = vi.fn<UntrackedDirectoryListingStream>(async (_args, onStdout) => {
      for (const chunk of ['new/日本', '語.md\0new/', 'b.ts\0']) {
        onStdout(chunk)
      }
      return { stoppedEarly: false }
    })
    const parser = parseStatus('? new/\n')

    const expansion = await expandUntrackedDirectoryRecords({
      records: parser.statusRecords,
      limit: 0,
      listUntracked
    })

    expect(entryPaths(expansion!.records)).toEqual(['new/日本語.md', 'new/b.ts'])
  })

  it('drops a directory Git no longer lists instead of keeping a phantom row', async () => {
    const parser = parseStatus('? gone/\n? kept.txt\n')

    const expansion = await expandUntrackedDirectoryRecords({
      records: parser.statusRecords,
      limit: 0,
      listUntracked: listingFrom({})
    })

    expect(entryPaths(expansion!.records)).toEqual(['kept.txt'])
  })

  it('stops the listing once the expanded rows pass the status limit', async () => {
    let emitted = 0
    const listUntracked = vi.fn<UntrackedDirectoryListingStream>(async (_args, onStdout) => {
      for (let index = 0; index < 10_000; index += 1) {
        emitted += 1
        if (onStdout(`huge/file-${index}.txt\0`)) {
          return { stoppedEarly: true }
        }
      }
      return { stoppedEarly: false }
    })
    const parser = parseStatus('? a.txt\n? huge/\n? z/\n')

    const expansion = await expandUntrackedDirectoryRecords({
      records: parser.statusRecords,
      limit: 5,
      listUntracked
    })

    expect(emitted).toBe(5)
    expect(expansion!.stoppedEarly).toBe(true)
    expect(expansion!.statusLength).toBe(6)
    expect(listUntracked).toHaveBeenCalledTimes(1)
    expect(entryPaths(expansion!.records).slice(0, 5)).toEqual([
      'a.txt',
      'huge/file-0.txt',
      'huge/file-1.txt',
      'huge/file-2.txt',
      'huge/file-3.txt'
    ])
  })

  it('splits many directories across bounded listing commands', async () => {
    const directories = Array.from({ length: 300 }, (_, index) => `dir-${index}/`)
    const listUntracked = listingFrom(
      Object.fromEntries(directories.map((directory) => [directory, [`${directory}f.txt`]]))
    )
    const parser = parseStatus(directories.map((directory) => `? ${directory}\n`).join(''))

    const expansion = await expandUntrackedDirectoryRecords({
      records: parser.statusRecords,
      limit: 0,
      listUntracked
    })

    expect(listUntracked.mock.calls.map(([args]) => args.length - 6)).toEqual([256, 44])
    expect(entryPaths(expansion!.records)).toEqual(
      directories.map((directory) => `${directory}f.txt`)
    )
  })

  it('keeps the stdout byte backstop across batches when the entry cap is disabled', async () => {
    const directories = Array.from({ length: 300 }, (_, index) => `dir-${index}/`)
    const parser = parseStatus(directories.map((directory) => `? ${directory}\n`).join(''))
    const listUntracked = vi.fn<UntrackedDirectoryListingStream>(async (args, onStdout) => {
      const directory = args[6].slice(':(top,literal)'.length)
      const chunk = Array.from(
        { length: 8_192 },
        (_, index) => `${directory}${index}-${'x'.repeat(800)}\0`
      ).join('')
      return { stoppedEarly: onStdout(chunk) }
    })

    await expect(
      expandUntrackedDirectoryRecords({ records: parser.statusRecords, limit: 0, listUntracked })
    ).rejects.toThrow('Git output byte limit')
    expect(listUntracked).toHaveBeenCalledTimes(2)
  })
})
