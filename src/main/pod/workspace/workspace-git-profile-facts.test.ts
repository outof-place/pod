import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  currentFromEntries,
  parseScopedConfig,
  readIndexEntryCount
} from './workspace-git-profile-facts'
import { findProcessesInside } from './workspace-process-cwds'

describe('parseScopedConfig', () => {
  it('reads `scope NUL key LF value NUL` records, bare booleans included', () => {
    const stdout =
      'global\0checkout.workers\n4\0local\0core.fsmonitor\0local\0pod.workspaceconfig\ncore.fsmonitor=true\0'
    expect(parseScopedConfig(stdout)).toEqual([
      { scope: 'global', key: 'checkout.workers', value: '4' },
      { scope: 'local', key: 'core.fsmonitor', value: 'true' },
      { scope: 'local', key: 'pod.workspaceconfig', value: 'core.fsmonitor=true' }
    ])
  })

  it('tells Pod’s own values from the user’s', () => {
    const current = currentFromEntries(
      parseScopedConfig(
        'global\0checkout.thresholdforparallelism\n100\0local\0maintenance.strategy\ngeometric\0local\0pod.workspaceconfig\nmaintenance.strategy=geometric\0'
      )
    )
    expect(current['maintenance.strategy']).toEqual({
      local: 'geometric',
      other: false,
      recorded: 'geometric'
    })
    expect(current['checkout.thresholdforparallelism']).toEqual({
      local: null,
      other: true,
      recorded: null
    })
  })
})

describe('readIndexEntryCount', () => {
  it('reads the entry count from the index header without git', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-ws-index-'))
    const header = Buffer.alloc(12)
    header.write('DIRC', 0, 'latin1')
    header.writeUInt32BE(4, 4)
    header.writeUInt32BE(35_108, 8)
    writeFileSync(join(dir, 'index'), header)
    await expect(readIndexEntryCount(dir)).resolves.toBe(35_108)
    writeFileSync(join(dir, 'index'), 'garbage-garbage')
    await expect(readIndexEntryCount(dir)).resolves.toBeNull()
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('findProcessesInside', () => {
  it('matches cwd below a folder, skips its own pid and names only the hits', async () => {
    const asked: number[][] = []
    const found = await findProcessesInside(
      {
        listPids: () => [1, 10, 20, 30],
        readCwd: (pid) => ({ 10: '/w/a/src', 20: '/w/ab', 30: '/w/a' })[pid] ?? null,
        readNames: async (pids) => {
          asked.push([...pids])
          return new Map(pids.map((pid) => [pid, `p${pid}`]))
        }
      },
      ['/w/a'],
      30
    )
    expect(found.get('/w/a')).toEqual([{ pid: 10, name: 'p10' }])
    expect(asked).toEqual([[10]])
  })
})
