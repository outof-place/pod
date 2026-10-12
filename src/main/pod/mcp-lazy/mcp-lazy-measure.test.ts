import { describe, expect, it } from 'vitest'
import { wrapEntry } from './mcp-lazy-entries'
import { parseProcessTable, parseTopMemory, serverNeedle } from './mcp-lazy-measure'

describe('mcp-lazy measure', () => {
  it('finds a server by the package or script its launcher runs, else by its binary', () => {
    expect(serverNeedle({ command: 'npx', args: ['-y', 'next-devtools-mcp@0.4.0'] })).toBe(
      'next-devtools-mcp'
    )
    expect(serverNeedle({ command: 'npx', args: ['-y', '@reacticx/mcp'] })).toBe('mcp')
    expect(serverNeedle({ command: 'node', args: ['/opt/magic/mcp-server.cjs'] })).toBe(
      'mcp-server.cjs'
    )
    expect(serverNeedle({ command: '/opt/bin/chrome-devtools-mcp', args: ['--x'] })).toBe(
      'chrome-devtools-mcp'
    )
    expect(
      serverNeedle(wrapEntry('m', { command: 'uvx', args: ['some-mcp'] }, '/s/mcp-lazy'))
    ).toBe('some-mcp')
  })

  it('reads ps and top output', () => {
    expect(
      parseProcessTable('  10     1 claude --resume\n  11    10 chrome-devtools-mcp\n')
    ).toEqual([
      { pid: 10, ppid: 1, command: 'claude --resume' },
      { pid: 11, ppid: 10, command: 'chrome-devtools-mcp' }
    ])
    const memory = parseTopMemory('PID    MEM  \n11     102M+\n12     7660K \n13     1.5G-\n')
    expect(memory.get(11)).toBe(102)
    expect(memory.get(12)).toBeCloseTo(7.48, 2)
    expect(memory.get(13)).toBe(1536)
  })
})
