import { describe, expect, it } from 'vitest'
import {
  isHeavy,
  isWrappable,
  isWrapped,
  normalizeMcpLazySetting,
  planMcpLazy,
  plannedEntries,
  unwrapEntry,
  wrapEntry,
  wrappedShimPath,
  wrapScript,
  type McpServerEntry
} from './mcp-lazy-entries'

const SHIM = '/Users/u/.orca/agent-hooks/mcp-lazy'
const chrome: McpServerEntry = {
  type: 'stdio',
  command: '/opt/node/bin/chrome-devtools-mcp',
  args: ['--channel=stable', '--logFile=/tmp/x.log'],
  env: { TOKEN: 'secret' }
}
const magic: McpServerEntry = {
  type: 'stdio',
  command: 'node',
  args: ['/opt/magic/mcp-server.cjs'],
  env: {}
}
const http: McpServerEntry = {
  type: 'http',
  url: 'http://127.0.0.1:1/mcp',
  headers: { Authorization: 'x' }
}

describe('mcp-lazy entries', () => {
  it('wraps into sh -c with the original command line in the arguments, env untouched', () => {
    const wrapped = wrapEntry('chrome-devtools', chrome, SHIM)
    expect(wrapped).toEqual({
      type: 'stdio',
      command: '/bin/sh',
      args: [
        '-c',
        wrapScript(SHIM),
        'chrome-devtools',
        chrome.command,
        '--channel=stable',
        '--logFile=/tmp/x.log'
      ],
      env: { TOKEN: 'secret' }
    })
    expect(JSON.stringify(wrapped)).not.toContain('${')
    expect(isWrapped(wrapped)).toBe(true)
    expect(wrappedShimPath(wrapped)).toBe(SHIM)
  })

  it('unwraps to exactly the entry it wrapped', () => {
    expect(unwrapEntry(wrapEntry('chrome-devtools', chrome, SHIM))).toEqual(chrome)
    expect(unwrapEntry(wrapEntry('MCPMagic', magic, SHIM))).toEqual(magic)
    expect(unwrapEntry(chrome)).toBe(chrome)
  })

  it('quotes a shim path with a quote in it, and refuses one Claude Code would expand', () => {
    const odd = "/Users/o'neil/.orca/agent-hooks/mcp-lazy"
    expect(wrappedShimPath(wrapEntry('x', magic, odd))).toBe(odd)
    expect(() => wrapScript('/Users/${USER}/mcp-lazy')).toThrow()
  })

  it('wraps only plain stdio servers', () => {
    expect(isWrappable(chrome)).toBe(true)
    expect(isWrappable({ command: 'uvx', args: ['some-mcp'] })).toBe(true)
    expect(isWrappable(http)).toBe(false)
    expect(isWrappable({ type: 'stdio', command: 'x', args: [1] })).toBe(false)
    expect(isWrappable(wrapEntry('x', magic, SHIM))).toBe(false)
  })

  it('calls runtime launchers and script servers heavy', () => {
    expect(isHeavy(magic)).toBe(true)
    expect(isHeavy({ command: 'npx', args: ['-y', 'next-devtools-mcp@0.4.0'] })).toBe(true)
    expect(isHeavy({ command: '/usr/local/bin/some-go-mcp', args: [] })).toBe(false)
    expect(isHeavy(wrapEntry('m', magic, SHIM))).toBe(true)
  })

  it('wraps at startup but unwraps only when the setting changes', () => {
    const servers = { chrome, MCPMagic: wrapEntry('MCPMagic', magic, SHIM), http }
    const on = { enabled: true, servers: ['chrome'] }
    expect(planMcpLazy(servers, on, SHIM, 'startup')).toEqual({ wrap: ['chrome'], unwrap: [] })
    expect(planMcpLazy(servers, on, SHIM, 'change')).toEqual({
      wrap: ['chrome'],
      unwrap: ['MCPMagic']
    })
    const off = { enabled: false, servers: ['chrome', 'MCPMagic'] }
    expect(planMcpLazy(servers, off, SHIM, 'startup')).toEqual({ wrap: [], unwrap: [] })
    expect(planMcpLazy(servers, off, SHIM, 'change')).toEqual({ wrap: [], unwrap: ['MCPMagic'] })
  })

  it('rewraps an entry another install of the shim wrapped', () => {
    const servers = { MCPMagic: wrapEntry('MCPMagic', magic, '/old/mcp-lazy') }
    const plan = planMcpLazy(servers, { enabled: true, servers: ['MCPMagic'] }, SHIM, 'startup')
    expect(plan).toEqual({ wrap: ['MCPMagic'], unwrap: ['MCPMagic'] })
    expect(plannedEntries(servers, plan, SHIM).MCPMagic).toEqual(wrapEntry('MCPMagic', magic, SHIM))
  })

  it('normalizes the stored setting', () => {
    expect(normalizeMcpLazySetting(undefined)).toEqual({ enabled: false, servers: [] })
    // A list with a non-string drops whole; the switch stays.
    expect(normalizeMcpLazySetting({ enabled: true, servers: ['a', 3] })).toEqual({
      enabled: true,
      servers: []
    })
    expect(normalizeMcpLazySetting({ enabled: 'yes', servers: ['a', ''] })).toEqual({
      enabled: false,
      servers: ['a']
    })
    expect(normalizeMcpLazySetting({ enabled: true, servers: ['a', 'a', 'b'] })).toEqual({
      enabled: true,
      servers: ['a', 'b']
    })
  })
})
