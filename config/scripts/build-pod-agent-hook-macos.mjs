#!/usr/bin/env node
// Fork-only (Pod): builds native/pod-agent-hook-macos, Claude's managed status hook client, for a
// checkout's tests and dev runs (POD_AGENT_HOOK_BINARY). Packaged apps build it in afterPack
// (product/agent-hook/install-agent-hook.cjs).
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '../..')
export const POD_AGENT_HOOK_SOURCE = path.join(
  repoRoot,
  'native',
  'pod-agent-hook-macos',
  'src',
  'pod-agent-hook.c'
)
export const defaultOutputPath = path.join(
  repoRoot,
  'native',
  'pod-agent-hook-macos',
  '.build',
  'release',
  'pod-agent-hook'
)

if (process.platform === 'darwin') {
  const outputArg = process.argv.indexOf('--output')
  const outputPath = outputArg > 0 ? process.argv[outputArg + 1] : defaultOutputPath
  mkdirSync(path.dirname(outputPath), { recursive: true })
  execFileSync(
    'clang',
    [
      '-O2',
      '-std=c11',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-mmacosx-version-min=13.0',
      POD_AGENT_HOOK_SOURCE,
      '-o',
      outputPath
    ],
    { stdio: 'inherit' }
  )
}
