// Against the built helper (native/pod-sim-macos/scripts/build.sh), not a stand-in. Off by default:
//   POD_SIM_REAL=1 [POD_SIM_REAL_UDID=<booted throwaway device>] [POD_SIM_DEVICE_SET=<its set>] \
//     pnpm test src/main/pod/sim/helper/sim-helper-real.test.ts
// With a UDID it also takes a screenshot of that device. Never point it at a device a session holds.
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { resolveSimHelperBinary } from './sim-helper-path'
import { SimHelperSupervisor } from './sim-helper-supervisor'

const real = process.env.POD_SIM_REAL === '1'
const udid = process.env.POD_SIM_REAL_UDID
const supervisor = new SimHelperSupervisor({
  packaged: false,
  // Explicit: the helper never inherits POD_SIM_* from this process.
  deviceSet: process.env.POD_SIM_DEVICE_SET,
  helloTimeoutMs: 30_000,
  readyTimeoutMs: 30_000
})

afterAll(async () => {
  await supervisor.stop()
})

describe.skipIf(!real)('pod-sim helper, real binary', () => {
  it('starts, passes hello with its token and reports the versions it found', async () => {
    expect(resolveSimHelperBinary({ packaged: false })).not.toBeNull()
    const hello = await supervisor.hello(30_000)
    expect(hello.ok).toBe(true)
    if (hello.ok) {
      expect(hello.value.coreSimulator?.build).toBeTruthy()
      expect(hello.value.simulatorKit?.build).toBeTruthy()
      expect(['ok', 'unsupported', 'failed']).toContain(hello.value.capabilities.screenshot.status)
    }
  })

  it.skipIf(!udid)(
    'a device self-test says device only with frames, surfaceOnly without',
    async () => {
      const report = await supervisor.call('selftest', { udid: udid ?? '', waitMs: 3_000 })
      expect(report.ok).toBe(true)
      if (report.ok) {
        const { display } = report.value.capabilities
        expect(display.status).toBe('ok')
        expect(display.framesSeen).toBeTypeOf('number')
        expect(display.checked).toBe((display.framesSeen ?? 0) > 0 ? 'device' : 'surfaceOnly')
      }
    }
  )

  it.skipIf(!udid)('takes a screenshot of the given device', async () => {
    // Made here: a skipped file runs no afterAll, so a directory made at load would leak.
    const dir = mkdtempSync(join(tmpdir(), 'pod-sim-real-'))
    try {
      const path = join(dir, 'shot.png')
      const shot = await supervisor.call('screenshot', { udid: udid ?? '', path })
      expect(shot).toMatchObject({ ok: true, value: { path, format: 'png' } })
      expect(statSync(path).size).toBeGreaterThan(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
