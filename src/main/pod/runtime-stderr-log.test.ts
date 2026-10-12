import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  installRuntimeStderrLog,
  resetRuntimeStderrLogForTests,
  RUNTIME_STDERR_LOG_MAX_BYTES,
  RUNTIME_STDERR_LOG_NAME
} from './runtime-stderr-log'

let logsDir: string

beforeEach(() => {
  logsDir = join(mkdtempSync(join(os.tmpdir(), 'pod-stderr-')), 'logs')
  resetRuntimeStderrLogForTests()
})

afterEach(() => {
  rmSync(join(logsDir, '..'), { recursive: true, force: true })
})

function fakeStderr(): Pick<NodeJS.WriteStream, 'write'> {
  return { write: vi.fn(() => true) }
}

async function logText(): Promise<string> {
  // The copy goes through a write stream; give it a turn to flush.
  await new Promise((resolve) => setTimeout(resolve, 20))
  return readFileSync(join(logsDir, RUNTIME_STDERR_LOG_NAME), 'utf8')
}

describe('installRuntimeStderrLog', () => {
  it('keeps what reaches stderr, and stderr still gets it', async () => {
    const stream = fakeStderr()
    const original = stream.write
    installRuntimeStderrLog(logsDir, stream)
    stream.write('[daemon] STARTUP FAILED — falling back to local PTYs\n')
    stream.write(Buffer.from('bytes too\n'))
    expect(original).toHaveBeenCalledTimes(2)
    const text = await logText()
    expect(text).toMatch(/^--- \S+ pid \d+\n/)
    expect(text).toContain('[daemon] STARTUP FAILED — falling back to local PTYs')
    expect(text).toContain('bytes too')
    expect(statSync(join(logsDir, RUNTIME_STDERR_LOG_NAME)).mode & 0o777).toBe(0o600)
  })

  it('keeps the previous file once when it grew past the cap', async () => {
    installRuntimeStderrLog(logsDir, fakeStderr())
    await logText()
    resetRuntimeStderrLogForTests()
    const path = join(logsDir, RUNTIME_STDERR_LOG_NAME)
    writeFileSync(path, 'x'.repeat(RUNTIME_STDERR_LOG_MAX_BYTES + 1))
    installRuntimeStderrLog(logsDir, fakeStderr())
    expect(statSync(`${path}.1`).size).toBe(RUNTIME_STDERR_LOG_MAX_BYTES + 1)
    expect((await logText()).startsWith('---')).toBe(true)
  })

  it('installs once', async () => {
    const stream = fakeStderr()
    installRuntimeStderrLog(logsDir, stream)
    const teed = stream.write
    installRuntimeStderrLog(logsDir, stream)
    expect(stream.write).toBe(teed)
  })
})
