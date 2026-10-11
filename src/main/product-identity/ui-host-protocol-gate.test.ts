import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const asar: { createPackage(src: string, dest: string): Promise<void> } = require('@electron/asar')
const gate: {
  REQUIRED_PROTOCOL_VERSION: number
  sourceProtocolVersion(text: string): number | null
  protocolProblems(sourceVersion: number | null, bundleText: string): string[]
  mainBundleText(app: string): string
} = await import('../../../product/scripts/verify-ui-host-protocol.mjs')

const V2_MAIN =
  'send({type:`quitHeartbeat`});send({type:\'needsConfirmation\'});({type:"quitAborted"})'

let root: string | null = null

afterEach(() => {
  if (root) {
    rmSync(root, { recursive: true, force: true })
    root = null
  }
})

describe('ui-host protocol release gate', () => {
  it('reads the version the source declares', () => {
    expect(gate.sourceProtocolVersion('export const POD_UI_HOST_PROTOCOL_VERSION = 2\n')).toBe(2)
    expect(gate.sourceProtocolVersion('export const OTHER = 2\n')).toBeNull()
  })

  it("passes only a version 2 source whose bundle carries version 2's messages", () => {
    expect(gate.REQUIRED_PROTOCOL_VERSION).toBe(2)
    expect(gate.protocolProblems(2, V2_MAIN)).toEqual([])
    expect(gate.protocolProblems(3, V2_MAIN)).toEqual([])
    expect(gate.protocolProblems(1, V2_MAIN)).toEqual([
      'the source declares ui-host protocol 1, below 2'
    ])
    expect(gate.protocolProblems(null, V2_MAIN)[0]).toMatch(/declares no/)
    expect(gate.protocolProblems(2, 'n.v!==1')).toEqual([
      "the runtime's main bundle lacks protocol 2 messages: quitHeartbeat, needsConfirmation, quitAborted"
    ])
  })

  it("reads only the main process's JavaScript from app.asar", async () => {
    root = mkdtempSync(join(tmpdir(), 'pod-ui-host-gate-'))
    const src = join(root, 'src')
    mkdirSync(join(src, 'out', 'main', 'chunks'), { recursive: true })
    mkdirSync(join(src, 'out', 'renderer'), { recursive: true })
    writeFileSync(join(src, 'out', 'main', 'index.js'), 'main()')
    writeFileSync(join(src, 'out', 'main', 'chunks', 'quit.js'), V2_MAIN)
    writeFileSync(join(src, 'out', 'renderer', 'index.js'), 'renderer-only')
    const app = join(root, 'Pod Runtime.app')
    mkdirSync(join(app, 'Contents', 'Resources'), { recursive: true })
    await asar.createPackage(src, join(app, 'Contents', 'Resources', 'app.asar'))
    const text = gate.mainBundleText(app)
    expect(text).toContain('quitHeartbeat')
    expect(text).not.toContain('renderer-only')
    expect(gate.protocolProblems(2, text)).toEqual([])
  })
})
