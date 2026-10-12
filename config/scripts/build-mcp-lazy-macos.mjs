#!/usr/bin/env node
// Fork-only (Pod): builds native/mcp-lazy-macos, the lazy MCP shim, for a checkout's tests and dev
// runs (POD_MCP_LAZY_BINARY). Packaged apps build it in afterPack (product/mcp-lazy/install-mcp-lazy.cjs).
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '../..')
export const MCP_LAZY_SOURCE = path.join(repoRoot, 'native', 'mcp-lazy-macos', 'src', 'mcp-lazy.c')
export const defaultOutputPath = path.join(
  repoRoot,
  'native',
  'mcp-lazy-macos',
  '.build',
  'release',
  'mcp-lazy'
)

if (process.platform === 'darwin') {
  const outputArg = process.argv.indexOf('--output')
  const outputPath = outputArg > 0 ? process.argv[outputArg + 1] : defaultOutputPath
  mkdirSync(path.dirname(outputPath), { recursive: true })
  execFileSync(
    'clang',
    [
      '-Os',
      '-std=c11',
      '-Wall',
      '-Wextra',
      '-Wno-unused-result',
      '-Werror',
      '-mmacosx-version-min=13.0',
      MCP_LAZY_SOURCE,
      '-o',
      outputPath
    ],
    { stdio: 'inherit' }
  )
}
