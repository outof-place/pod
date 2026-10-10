import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { agentPlist, goEnv, readPin } from '../../native/pod-hookd/build.mjs'

const require = createRequire(import.meta.url)
const {
  podHookdMacExtraResources,
  podHookdMacExtraFiles,
  podHookdFileExclusions
} = require('../pod-hookd-resources.cjs')

const roots = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), 'pod-hookd-'))
  roots.push(root)
  for (const file of files) {
    mkdirSync(join(root, file, '..'), { recursive: true })
    writeFileSync(join(root, file), '')
  }
  return root
}

describe('pod-hookd pin and agent', () => {
  it('pins a tag together with its full commit', () => {
    const pin = readPin()
    expect(pin.repository).toBe('outof-place/fasthooks')
    expect(pin.commit).toMatch(/^[0-9a-f]{40}$/)
    const bad = join(tree([]), 'pin.json')
    writeFileSync(bad, JSON.stringify({ repository: 'a/b', tag: 'v1', commit: 'abc123' }))
    expect(() => readPin(bad)).toThrow('not a full sha')
  })

  it('writes a launchd plist that starts the bundled binary only while chained', () => {
    const path = join(tree([]), 'agent.plist')
    writeFileSync(path, agentPlist('codes.pod.app'))
    const lint = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path], {
      encoding: 'utf8'
    })
    expect(lint.status).toBe(0)
    const agent = JSON.parse(lint.stdout)
    expect(agent).toEqual({
      Label: 'codes.pod.app.acc.hookd',
      BundleProgram: 'Contents/Resources/pod-hookd/pod-hookd',
      ProgramArguments: ['pod-hookd', 'hookd', '-only-chained'],
      RunAtLoad: true,
      KeepAlive: { SuccessfulExit: false },
      ThrottleInterval: 10,
      ProcessType: 'Interactive'
    })
    expect(readFileSync(path, 'utf8')).not.toContain('/Users/')
  })

  it('builds with cgo for the target architecture', () => {
    expect(goEnv('arm64', {})).toMatchObject({
      CGO_ENABLED: '1',
      GOARCH: 'arm64',
      CC: 'clang -arch arm64'
    })
    expect(goEnv('x64', {})).toMatchObject({ GOARCH: 'amd64', CC: 'clang -arch x86_64' })
  })
})

describe('Pod pod-hookd resources', () => {
  it('ships the binary and moves its agent into Contents/Library', () => {
    const dir = tree(['pod-hookd', 'LaunchAgents/codes.pod.app.acc.hookd.plist'])
    expect(podHookdMacExtraResources({ dir })).toEqual([
      { from: dir, to: 'pod-hookd', filter: ['pod-hookd'] }
    ])
    expect(podHookdMacExtraFiles({ dir })).toEqual([
      { from: join(dir, 'LaunchAgents'), to: 'Library/LaunchAgents', filter: ['*.acc.hookd.plist'] }
    ])
    expect(podHookdFileExclusions).toContain('!resources/pod-hookd/**')
  })

  it('fails the build without pod-hookd and never ships the agent without its binary', () => {
    const dir = tree(['LaunchAgents/codes.pod.app.acc.hookd.plist'])
    expect(() => podHookdMacExtraResources({ dir })).toThrow('native/pod-hookd/build.mjs')
    expect(podHookdMacExtraFiles({ dir })).toEqual([])
  })
})
