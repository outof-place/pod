import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()

vi.mock('./runtime-client', () => {
  class RuntimeClient {
    call = callMock
    getCliStatus = vi.fn()
    openOrca = vi.fn()
  }

  class RuntimeClientError extends Error {
    readonly code: string

    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  }

  class RuntimeRpcFailureError extends RuntimeClientError {
    readonly response: unknown

    constructor(response: unknown) {
      super('runtime_error', 'runtime_error')
      this.response = response
    }
  }

  return { RuntimeClient, RuntimeClientError, RuntimeRpcFailureError }
})

import { main } from './index'
import { okFixture, queueFixtures } from './test-fixtures'

// The PNG signature: real bytes the file must hold after base64 decoding.
const IMAGE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff])

describe('orca screenshot --path', () => {
  let dir: string

  beforeEach(() => {
    callMock.mockReset()
    process.exitCode = undefined
    dir = mkdtempSync(join(tmpdir(), 'orca-shot-'))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
    process.exitCode = undefined
  })

  it('writes the image next to the cwd and prints where, not the base64', async () => {
    queueFixtures(
      callMock,
      okFixture('req_shot', { data: IMAGE.toString('base64'), format: 'png' })
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['screenshot', '--path', 'shots/../shot.png', '--page', 'page-1'], dir)

    expect(callMock).toHaveBeenCalledWith('browser.screenshot', {
      format: undefined,
      page: 'page-1'
    })
    expect(readFileSync(join(dir, 'shot.png'))).toEqual(IMAGE)
    expect(logSpy).toHaveBeenCalledWith(
      `Screenshot saved to ${join(dir, 'shot.png')} (png, ${IMAGE.length} bytes)`
    )
  })

  it('keeps the base64 out of --json and reports the absolute path instead', async () => {
    queueFixtures(
      callMock,
      okFixture('req_full', { data: IMAGE.toString('base64'), format: 'jpeg' })
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['full-screenshot', '--format', 'jpeg', '--path', 'full.jpg', '--page', 'page-1', '--json'],
      dir
    )

    expect(readFileSync(join(dir, 'full.jpg'))).toEqual(IMAGE)
    const printed = JSON.parse(String(logSpy.mock.calls[0][0]))
    expect(printed.result).toEqual({
      format: 'jpeg',
      path: join(dir, 'full.jpg'),
      bytes: IMAGE.length
    })
  })

  it('fails with the path it could not write', async () => {
    queueFixtures(
      callMock,
      okFixture('req_shot', { data: IMAGE.toString('base64'), format: 'png' })
    )
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(['screenshot', '--path', 'missing/shot.png', '--page', 'page-1'], dir)

    expect(errorSpy.mock.calls.flat().join('\n')).toContain(
      `Could not write the screenshot to ${join(dir, 'missing', 'shot.png')} (ENOENT).`
    )
    expect(process.exitCode).toBe(1)
  })

  it('writes the explicit --path owner-only', async () => {
    queueFixtures(
      callMock,
      okFixture('req_shot', { data: IMAGE.toString('base64'), format: 'png' })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['screenshot', '--path', 'private.png', '--page', 'page-1'], dir)

    expect(statSync(join(dir, 'private.png')).mode & 0o777).toBe(0o600)
  })

  describe('--save', () => {
    let tempDir: string
    const previousTempDir = process.env.ORCA_COMPUTER_SCREENSHOT_TMPDIR

    beforeEach(() => {
      tempDir = join(dir, 'agent-shots')
      process.env.ORCA_COMPUTER_SCREENSHOT_TMPDIR = tempDir
    })

    afterEach(() => {
      if (previousTempDir === undefined) {
        delete process.env.ORCA_COMPUTER_SCREENSHOT_TMPDIR
      } else {
        process.env.ORCA_COMPUTER_SCREENSHOT_TMPDIR = previousTempDir
      }
    })

    it('saves to a CLI-owned file named by the request, owner-only, and prints where', async () => {
      queueFixtures(
        callMock,
        okFixture('req_save1', { data: IMAGE.toString('base64'), format: 'png' })
      )
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

      await main(['screenshot', '--save', '--page', 'page-1', '--json'], dir)

      const file = join(tempDir, 'req_save1-screenshot.png')
      expect(readFileSync(file)).toEqual(IMAGE)
      expect(statSync(file).mode & 0o777).toBe(0o600)
      const printed = JSON.parse(String(logSpy.mock.calls[0][0]))
      expect(printed.result).toMatchObject({ format: 'png', path: file, bytes: IMAGE.length })
      expect(printed.result.data).toBeUndefined()
      expect(typeof printed.result.expiresAt).toBe('string')
    })

    it('gives two requests two files and a jpeg its own extension', async () => {
      queueFixtures(
        callMock,
        okFixture('req_a', { data: IMAGE.toString('base64'), format: 'jpeg' }),
        okFixture('req_b', { data: IMAGE.toString('base64'), format: 'jpeg' })
      )
      vi.spyOn(console, 'log').mockImplementation(() => {})

      await main(['full-screenshot', '--format', 'jpeg', '--save', '--page', 'page-1'], dir)
      await main(['full-screenshot', '--format', 'jpeg', '--save', '--page', 'page-1'], dir)

      const files = readdirSync(tempDir).filter((name) => name.endsWith('-screenshot.jpg'))
      expect(files.sort()).toEqual(['req_a-screenshot.jpg', 'req_b-screenshot.jpg'])
    })

    it('keeps the image inline when the temp dir cannot be used', async () => {
      writeFileSync(join(dir, 'blocker'), 'a file where the temp dir should go')
      process.env.ORCA_COMPUTER_SCREENSHOT_TMPDIR = join(dir, 'blocker', 'nope')
      queueFixtures(
        callMock,
        okFixture('req_inline', { data: IMAGE.toString('base64'), format: 'png' })
      )
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

      await main(['screenshot', '--save', '--page', 'page-1', '--json'], dir)

      const printed = JSON.parse(String(logSpy.mock.calls[0][0]))
      expect(printed.result.data).toBe(IMAGE.toString('base64'))
    })

    it('refuses --save together with --path before capturing anything', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      await main(['screenshot', '--save', '--path', 'x.png', '--page', 'page-1'], dir)

      expect(callMock).not.toHaveBeenCalled()
      expect(errorSpy.mock.calls.flat().join('\n')).toContain('--path or --save')
      expect(process.exitCode).toBe(1)
    })
  })

  describe('from an SSH host', () => {
    const previous = process.env.ORCA_SSH_BRIDGE_CREDENTIAL

    beforeEach(() => {
      process.env.ORCA_SSH_BRIDGE_CREDENTIAL = 'sshb_test'
    })

    afterEach(() => {
      if (previous === undefined) {
        delete process.env.ORCA_SSH_BRIDGE_CREDENTIAL
      } else {
        process.env.ORCA_SSH_BRIDGE_CREDENTIAL = previous
      }
    })

    it.each([
      ['screenshot', '--path'],
      ['full-screenshot', '--path'],
      ['screenshot', '--save'],
      ['full-screenshot', '--save']
    ])(
      'refuses %s %s, which would write on the Orca host, and writes nothing',
      async (command, flag) => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        const args = flag === '--path' ? [flag, 'shot.png'] : [flag]

        await main([command, ...args, '--page', 'page-1'], dir)

        const message = errorSpy.mock.calls.flat().join('\n')
        expect(message).toContain('result.data')
        expect(message).toContain(flag)
        expect(process.exitCode).toBe(1)
        expect(callMock).not.toHaveBeenCalled()
        expect(existsSync(join(dir, 'shot.png'))).toBe(false)
      }
    )

    it('still returns the base64 without --path', async () => {
      queueFixtures(
        callMock,
        okFixture('req_ssh', { data: IMAGE.toString('base64'), format: 'png' })
      )
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

      await main(['screenshot', '--page', 'page-1', '--json'], dir)

      expect(JSON.parse(String(logSpy.mock.calls[0][0])).result.data).toBe(IMAGE.toString('base64'))
    })
  })
})
