import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const PRODUCT = join(__dirname, '../../../product')
const GATE = join(PRODUCT, 'scripts/measure-seams-gate.sh')
const root = mkdtempSync(join(tmpdir(), 'pod-measure-seams-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

let apps = 0

/** A PodNative.app with only an Info.plist; `marker` adds PodMeasureSeams. */
function fakeOuter(marker?: boolean): string {
  const app = join(root, `outer-${++apps}.app`)
  mkdirSync(join(app, 'Contents'), { recursive: true })
  const entry = marker === undefined ? '' : `<key>PodMeasureSeams</key><${marker}/>`
  writeFileSync(
    join(app, 'Contents/Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>codes.pod.native</string>${entry}</dict></plist>
`
  )
  return app
}

function gate(app: string, env: Record<string, string> = {}) {
  return spawnSync('/bin/bash', [GATE, app], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', ...env }
  })
}

describe('measure-seams-gate.sh', () => {
  it('passes an outer without seams', () => {
    expect(gate(fakeOuter()).status).toBe(0)
    expect(gate(fakeOuter(false)).status).toBe(0)
    expect(gate(fakeOuter(), { POD_MEASURE_SEAMS: '0' }).status).toBe(0)
  })

  it('stops an outer whose Info.plist has PodMeasureSeams', () => {
    const result = gate(fakeOuter(true))
    expect(result.status).toBe(1)
    expect(result.stdout).toContain("the outer's Info.plist has PodMeasureSeams")
  })

  it('stops any outer while POD_MEASURE_SEAMS is set', () => {
    const result = gate(fakeOuter(), { POD_MEASURE_SEAMS: '1' })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('POD_MEASURE_SEAMS=1 in the environment')
  })

  it('fails without an Info.plist', () => {
    expect(gate(join(root, 'missing.app')).status).toBe(2)
  })
})

describe('the release scripts and the seams gate', () => {
  it('release-one-app.sh never asks for measurement seams', () => {
    const release = readFileSync(join(PRODUCT, 'release-one-app.sh'), 'utf8')
    expect(release).not.toMatch(
      /\bPOD_MEASURE_SEAMS\s*=|export\s+POD_MEASURE_SEAMS\b|-DPOD_MEASURE_SEAMS/
    )
  })

  it('assemble-one-app.sh refuses a seams build before its first notarization', () => {
    const assemble = readFileSync(join(PRODUCT, 'assemble-one-app.sh'), 'utf8')
    const gateCall = assemble.indexOf('product/scripts/measure-seams-gate.sh')
    const refusal = assemble.indexOf('|| die "refusing to notarize a $measure_seams')
    const firstSubmit = assemble.indexOf('xcrun notarytool submit')
    expect(gateCall).toBeGreaterThan(-1)
    expect(refusal).toBeGreaterThan(gateCall)
    expect(firstSubmit).toBeGreaterThan(refusal)
  })
})
