import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const SHIM = join(__dirname, '../../../product/scripts/net-shims/xcrun')
const root = mkdtempSync(join(tmpdir(), 'pod-net-shim-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const NETWORK_ERROR =
  'Error: NSURLErrorDomain Code=-1009 The Internet connection appears to be offline.'
const ID = '0f3b6c2e-8d1a-4e5f-9a7b-1c2d3e4f5a6b'
const accepted = `{"id":"${ID}","status":"Accepted","message":"Processing complete"}`

type Attempt = { stdout: string; stderr?: string; code: number }

let runs = 0

/**
 * Runs the shim's `notarytool submit` against a fake xcrun that answers each submit with the next
 * attempt and `notarytool info` with `info`. `sleep` is a no-op on PATH.
 */
function submit(attempts: Attempt[], info = accepted) {
  const dir = join(root, `run-${++runs}`)
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  attempts.forEach((attempt, index) => {
    writeFileSync(join(dir, `submit.${index + 1}.out`), attempt.stdout)
    writeFileSync(join(dir, `submit.${index + 1}.err`), attempt.stderr ?? '')
    writeFileSync(join(dir, `submit.${index + 1}.code`), String(attempt.code))
  })
  writeFileSync(join(dir, 'info.out'), info)
  writeFileSync(join(dir, 'n'), '0')
  const fake = join(dir, 'xcrun')
  writeFileSync(
    fake,
    [
      '#!/bin/bash',
      `d='${dir}'`,
      'echo "$*" >>"$d/calls"',
      'if [ "$2" = submit ]; then',
      '  n=$(( $(cat "$d/n") + 1 )); echo "$n" >"$d/n"',
      '  cat "$d/submit.$n.out"; cat "$d/submit.$n.err" >&2; exit "$(cat "$d/submit.$n.code")"',
      'fi',
      '[ "$2" = wait ] && { echo "wait output"; exit 0; }',
      '[ "$2" = info ] && { cat "$d/info.out"; exit 0; }',
      'exit 9'
    ].join('\n')
  )
  chmodSync(fake, 0o755)
  writeFileSync(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(bin, 'sleep'), 0o755)
  const result = spawnSync(
    '/bin/bash',
    [SHIM, 'notarytool', 'submit', 'Pod.zip', '--output-format', 'json', '--wait'],
    {
      encoding: 'utf8',
      env: { PATH: `${bin}:/usr/bin:/bin`, POD_NET_SHIM_REAL_XCRUN: fake, HOME: dir }
    }
  )
  const calls = readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n')
  return { stdout: result.stdout, stderr: result.stderr, status: result.status, calls }
}

describe.skipIf(process.platform === 'win32')('release net shim: xcrun notarytool submit', () => {
  it("passes a first answer through as notarytool's own stdout", () => {
    const answer = `${accepted}\n`
    const result = submit([{ stdout: answer, code: 0 }])

    expect(result).toMatchObject({ status: 0, stdout: answer })
    expect(result.calls).toEqual(['notarytool submit Pod.zip --output-format json --wait'])
  })

  it('prints only the resent upload when the first one never got an id', () => {
    const result = submit([
      { stdout: '{"message":"Upload failed"}\n', stderr: NETWORK_ERROR, code: 1 },
      { stdout: `${accepted}\n`, code: 0 }
    ])

    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(JSON.parse(accepted))
    expect(result.stderr).toContain('submitting again (attempt 1)')
  })

  it("prints only the submission's final info when the wait broke after the upload", () => {
    const result = submit([
      {
        stdout: `{"id":"${ID}","message":"Successfully uploaded file"}\n`,
        stderr: NETWORK_ERROR,
        code: 1
      }
    ])

    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(JSON.parse(accepted))
    expect(result.calls.slice(1)).toEqual([
      `notarytool wait ${ID} --output-format json`,
      `notarytool info ${ID} --output-format json`
    ])
    expect(result.stdout).not.toContain('wait output')
  })

  it('reports a rejected submission with its info only', () => {
    const invalid = `{"id":"${ID}","status":"Invalid"}`
    const result = submit(
      [
        {
          stdout: `{"id":"${ID}","message":"Successfully uploaded file"}\n`,
          stderr: NETWORK_ERROR,
          code: 1
        }
      ],
      invalid
    )

    expect(result.status).toBe(1)
    expect(JSON.parse(result.stdout)).toEqual(JSON.parse(invalid))
  })

  it('fails a non-network error at once with that attempt as it was', () => {
    const refused = '{"message":"Invalid credentials"}\n'
    const result = submit([{ stdout: refused, stderr: 'Error: HTTP status code: 401', code: 69 }])

    expect(result).toMatchObject({ status: 69, stdout: refused })
    expect(result.calls).toHaveLength(1)
  })

  it('gives up after three uploads with the last one only', () => {
    const failed = (n: number) => ({
      stdout: `{"message":"Upload ${n} failed"}\n`,
      stderr: NETWORK_ERROR,
      code: 1
    })
    const result = submit([failed(1), failed(2), failed(3)])

    expect(result.status).toBe(1)
    expect(JSON.parse(result.stdout)).toEqual({ message: 'Upload 3 failed' })
    expect(result.calls).toHaveLength(3)
  })
})
