// Fork-only (Pod): a source scan. Every PTY write in a guarded writer goes out through
// writeIfForegroundSync, so the guard's check and the write share one synchronous call; and the
// startup readiness module writes nothing itself (pod-startup-input-write.ts does).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = join(__dirname, '../../..')
const GUARDED_WRITERS = [
  'main/runtime/runtime-terminal-writer.ts',
  'main/runtime/orca-runtime-write-terminal-agent-prompt.ts',
  'main/pod/terminal/pod-startup-input-write.ts'
]
const PTY_WRITE =
  /\b(?:this\.ptyController\?\.write|this\.write|writeWithSettlement|host\.write)\(/g

function writeCalls(path: string): { at: number; before: string }[] {
  const source = readFileSync(join(SRC, path), 'utf8')
  return [...source.matchAll(PTY_WRITE)].map((match) => ({
    at: match.index,
    before: source.slice(Math.max(0, match.index - 200), match.index)
  }))
}

describe('guarded writers', () => {
  it.each(GUARDED_WRITERS)('%s writes only inside writeIfForegroundSync', (path) => {
    const calls = writeCalls(path)
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      // The call sits in the closure handed to writeIfForegroundSync: no statement ends between.
      expect(call.before).toMatch(/writeIfForegroundSync\([^;]*$/)
    }
  })

  it('leaves the startup readiness module with no write of its own', () => {
    expect(writeCalls('main/runtime/runtime-worktree-startup-readiness.ts')).toEqual([])
  })
})
