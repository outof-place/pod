import { describe, expect, it, vi } from 'vitest'
import { StatusPorcelainParser } from './git-status-porcelain-parser'
import { expandParsedStatusUntrackedDirectories } from './git-status-untracked-directory-expansion'
import { isStatusRepositoryRoot } from './git-status-stream-read'

function parsed(output: string) {
  const parser = new StatusPorcelainParser()
  parser.update(output, 0)
  parser.finish()
  return {
    parser,
    records: parser.statusRecords,
    statusLength: parser.statusLength,
    stoppedEarly: false
  }
}

describe('status execution-host repository prefix', () => {
  it.each(['', '\n', '\r\n'])('recognizes a root prefix %j', async (prefix) => {
    await expect(
      isStatusRepositoryRoot(async (args, onStdout) => {
        expect(args).toEqual(['rev-parse', '--show-prefix'])
        onStdout(prefix)
        return { stoppedEarly: false }
      })
    ).resolves.toBe(true)
  })

  it.each(['workspace/\n', ' \n', 'Welcome to Linux\n\n'])(
    'rejects nested or noisy prefix %j',
    async (prefix) => {
      await expect(
        isStatusRepositoryRoot(async (_args, onStdout) => {
          onStdout(prefix)
          return { stoppedEarly: false }
        })
      ).resolves.toBe(false)
    }
  )

  it('bounds prefix output without trimming valid whitespace directories', async () => {
    await expect(
      isStatusRepositoryRoot(async (_args, onStdout) => {
        onStdout('x'.repeat(4_097))
        return { stoppedEarly: false }
      })
    ).rejects.toThrow('output byte limit')
  })

  it.each(['', '? top.txt\n'])(
    'avoids a prefix probe when no directory collapsed',
    async (output) => {
      const status = parsed(output)
      const isRepositoryRoot = vi.fn()
      const listUntracked = vi.fn()
      const readAllStatus = vi.fn()
      await expect(
        expandParsedStatusUntrackedDirectories(status.parser, false, {
          limit: 0,
          isRepositoryRoot,
          listUntracked,
          readAllStatus
        })
      ).resolves.toEqual(status)
      expect(isRepositoryRoot).not.toHaveBeenCalled()
      expect(listUntracked).not.toHaveBeenCalled()
      expect(readAllStatus).not.toHaveBeenCalled()
    }
  )

  it.each(['? ../sibling/\n', '? ./\n', '? inside/\n'])(
    'uses canonical status for a nested poll %j',
    async (output) => {
      const status = parsed(output)
      const all = parsed('? inside/new.txt\n')
      const isRepositoryRoot = vi.fn(async () => false)
      const listUntracked = vi.fn()
      const readAllStatus = vi.fn(async () => all)
      await expect(
        expandParsedStatusUntrackedDirectories(status.parser, false, {
          limit: 0,
          isRepositoryRoot,
          listUntracked,
          readAllStatus
        })
      ).resolves.toBe(all)
      expect(isRepositoryRoot).toHaveBeenCalledTimes(output === '? inside/\n' ? 1 : 0)
      expect(listUntracked).not.toHaveBeenCalled()
      expect(readAllStatus).toHaveBeenCalledTimes(1)
    }
  )

  it('does not repeat a failing canonical retry after an unverifiable prefix', async () => {
    const status = parsed('? new/\n')
    const failure = new Error('host disconnected')
    const readAllStatus = vi.fn(async () => {
      throw failure
    })
    await expect(
      expandParsedStatusUntrackedDirectories(status.parser, false, {
        limit: 0,
        isRepositoryRoot: async () => false,
        listUntracked: vi.fn(),
        readAllStatus
      })
    ).rejects.toBe(failure)
    expect(readAllStatus).toHaveBeenCalledTimes(1)
  })
})
