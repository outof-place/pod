import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { agentPlist, buildOrSkip, goEnv, readPin } from '../../native/pod-hookd/build.mjs'

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

  it('without pod-hookd fails only with POD_REQUIRE_HOOKD=1, and never ships the agent alone', () => {
    const dir = tree(['LaunchAgents/codes.pod.app.acc.hookd.plist'])
    expect(() => podHookdMacExtraResources({ dir, required: true })).toThrow('POD_REQUIRE_HOOKD=1')
    const warnings = []
    expect(
      podHookdMacExtraResources({ dir, required: false, warn: (m) => warnings.push(m) })
    ).toEqual([])
    expect(warnings.join()).toContain('ships without pod-hookd')
    expect(podHookdMacExtraFiles({ dir })).toEqual([])
  })
})

describe('pod-hookd build without access', () => {
  const pin = { repository: 'outof-place/fasthooks', tag: 'v0.1.1', commit: 'a'.repeat(40) }
  const noAccess = (cmd, args) => {
    throw new Error(`${cmd} ${args.join(' ')}: Repository not found`)
  }

  it('skips and removes a stale build unless POD_REQUIRE_HOOKD=1', () => {
    const into = join(tree(['pod-hookd/pod-hookd', 'pod-hookd/LaunchAgents/x.plist']), 'pod-hookd')
    const options = { into, pin, arch: 'arm64', appId: 'codes.pod.app', run: noAccess }
    expect(() => buildOrSkip({ ...options, required: true })).toThrow('Repository not found')
    expect(existsSync(join(into, 'pod-hookd'))).toBe(true)
    expect(buildOrSkip({ ...options, required: false }).skipped).toContain('Repository not found')
    expect(existsSync(into)).toBe(false)
  })
})
