import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const prune: {
  machOHasArch(path: string, arch: string): boolean
  prunePodNodePty(resourcesDir: string, arch: string): string[]
} = require('../../../product/packaged-node-pty.cjs')

const CPU = { arm64: 0x0100000c, x64: 0x01000007 }

function thin(cpu: number): Buffer {
  const buffer = Buffer.alloc(32)
  buffer.writeUInt32LE(0xfeedfacf, 0)
  buffer.writeInt32LE(cpu, 4)
  return buffer
}

function fat(...cpus: number[]): Buffer {
  const buffer = Buffer.alloc(8 + 20 * cpus.length)
  buffer.writeUInt32BE(0xcafebabe, 0)
  buffer.writeUInt32BE(cpus.length, 4)
  cpus.forEach((cpu, i) => buffer.writeInt32BE(cpu, 8 + 20 * i))
  return buffer
}

// What test15's runtime shipped in node_modules/node-pty, minus sources and docs.
const PACKAGED = [
  'bin/darwin-arm64-150/node-pty.node',
  'build/Makefile',
  'build/binding.Makefile',
  'build/config.gypi',
  'build/gyp-mac-tool',
  'build/pty.target.mk',
  'build/spawn-helper.target.mk',
  'build/Release/.deps/Release/pty.node.d',
  'build/Release/.forge-meta',
  'build/Release/node-addon-api@7.1.1/node_modules/node-addon-api/node_addon_api_except.stamp.d',
  'build/Release/obj.target/pty/src/unix/pty.o',
  'build/Release/pty.node',
  'build/Release/spawn-helper',
  'lib/index.js',
  'node-addon-api@7.1.1/node_modules/node-addon-api/node_addon_api_except.stamp',
  'package.json',
  'prebuilds/darwin-arm64/pty.node',
  'prebuilds/darwin-arm64/spawn-helper'
]

let resources: string

function nodePty(relative = ''): string {
  return join(resources, 'node_modules', 'node-pty', relative)
}

function seed(files: string[], runtime: Buffer = thin(CPU.arm64)): void {
  for (const relative of files) {
    mkdirSync(dirname(nodePty(relative)), { recursive: true })
    writeFileSync(
      nodePty(relative),
      relative.endsWith('.node') || relative.endsWith('spawn-helper') ? runtime : 'x'
    )
  }
}

beforeEach(() => {
  resources = mkdtempSync(join(tmpdir(), 'pod-node-pty-'))
})
afterEach(() => {
  rmSync(resources, { recursive: true, force: true })
})

describe('prunePodNodePty', () => {
  it('keeps the loaded addon, its spawn-helper and the JS, and removes the rest', () => {
    seed(PACKAGED)
    const removed = prune.prunePodNodePty(resources, 'arm64')
    expect(PACKAGED.filter((relative) => existsSync(nodePty(relative)))).toEqual([
      'build/Release/pty.node',
      'build/Release/spawn-helper',
      'lib/index.js',
      'package.json'
    ])
    expect(removed.sort()).toEqual([
      'bin',
      'build/Makefile',
      'build/Release/.deps',
      'build/Release/.forge-meta',
      'build/Release/node-addon-api@7.1.1',
      'build/Release/obj.target',
      'build/binding.Makefile',
      'build/config.gypi',
      'build/gyp-mac-tool',
      'build/pty.target.mk',
      'build/spawn-helper.target.mk',
      'node-addon-api@7.1.1',
      'prebuilds'
    ])
  })

  it('refuses to fall back to the unpatched prebuild when the source build is missing', () => {
    seed(PACKAGED.filter((relative) => relative !== 'build/Release/spawn-helper'))
    expect(() => prune.prunePodNodePty(resources, 'arm64')).toThrow(/spawn-helper is missing/)
    expect(existsSync(nodePty('prebuilds/darwin-arm64/pty.node'))).toBe(true)
  })

  it('refuses a source build of another architecture', () => {
    seed(PACKAGED, thin(CPU.x64))
    expect(() => prune.prunePodNodePty(resources, 'arm64')).toThrow(/no arm64 slice/)
  })
})

describe('machOHasArch', () => {
  it('reads thin and fat headers and rejects anything else', () => {
    const file = join(resources, 'binary')
    const check = (contents: Buffer, arch: string) => {
      writeFileSync(file, contents)
      return prune.machOHasArch(file, arch)
    }
    expect(check(thin(CPU.arm64), 'arm64')).toBe(true)
    expect(check(thin(CPU.arm64), 'x64')).toBe(false)
    expect(check(fat(CPU.x64, CPU.arm64), 'arm64')).toBe(true)
    expect(check(fat(CPU.x64), 'arm64')).toBe(false)
    expect(check(Buffer.from('#!/bin/sh\n'), 'arm64')).toBe(false)
    expect(check(Buffer.alloc(0), 'arm64')).toBe(false)
  })
})
