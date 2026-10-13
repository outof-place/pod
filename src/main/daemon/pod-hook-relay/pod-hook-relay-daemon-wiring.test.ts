import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNoopDaemonFileLog } from '../daemon-file-log'
import { notePodHookRelaySpawnEnv, podHookRelayEndpointAllowed } from './pod-hook-relay-endpoints'
import {
  createDaemonPodHookRelay,
  podHookRelayFilePath,
  POD_AGENT_HOOK_RELAY_ENV
} from './pod-hook-relay-daemon-wiring'

const realPlatform = process.platform
const keys = [POD_AGENT_HOOK_RELAY_ENV, 'POD_CLAUDE_HTTP_HOOKS'] as const
let saved: Record<string, string | undefined> = {}
let dir = ''

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pod-hook-relay-wiring-'))
  saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  for (const key of keys) {
    delete process.env[key]
  }
  // Why: the relay is for Pod's macOS launcher; Linux CI runs this as macOS.
  setPlatform('darwin')
})

afterEach(() => {
  setPlatform(realPlatform)
  for (const key of keys) {
    if (saved[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = saved[key]
    }
  }
  rmSync(dir, { recursive: true, force: true })
})

describe("the daemon's hook relay", () => {
  const deps = () => ({
    socketPath: join(dir, 'daemon.sock'),
    protocolVersion: 7,
    log: createNoopDaemonFileLog()
  })

  it('stays off unless the runtime asked for its http template', () => {
    process.env[POD_AGENT_HOOK_RELAY_ENV] = '/outer/pod-hook-relay-v7.env'
    expect(createDaemonPodHookRelay(deps())).toBeNull()
    // An outer Pod's relay file is never passed on, and no spawn's endpoint is kept.
    expect(process.env[POD_AGENT_HOOK_RELAY_ENV]).toBeUndefined()
    const endpoint = join(dir, 'endpoint.env')
    notePodHookRelaySpawnEnv('session-1', { ORCA_AGENT_HOOK_ENDPOINT: endpoint })
    expect(podHookRelayEndpointAllowed(endpoint)).toBe(false)
  })

  it('listens for the http A/B, and the kill switch still wins', async () => {
    process.env.POD_CLAUDE_HTTP_HOOKS = '1'
    const relay = createDaemonPodHookRelay(deps())
    expect(relay).not.toBeNull()
    // The daemon's terminals don't pass the A/B on to a Pod started in one of them.
    expect(process.env.POD_CLAUDE_HTTP_HOOKS).toBeUndefined()
    await relay?.start()
    const file = podHookRelayFilePath(join(dir, 'daemon.sock'), 7)
    expect(process.env[POD_AGENT_HOOK_RELAY_ENV]).toBe(file)
    expect(existsSync(file)).toBe(true)
    const endpoint = join(dir, 'endpoint.env')
    notePodHookRelaySpawnEnv('session-1', { ORCA_AGENT_HOOK_ENDPOINT: endpoint })
    expect(podHookRelayEndpointAllowed(endpoint)).toBe(true)
    await relay?.close()
    expect(process.env[POD_AGENT_HOOK_RELAY_ENV]).toBeUndefined()
    expect(existsSync(file)).toBe(false)
    process.env[POD_AGENT_HOOK_RELAY_ENV] = '0'
    process.env.POD_CLAUDE_HTTP_HOOKS = '1'
    expect(createDaemonPodHookRelay(deps())).toBeNull()
    expect(process.env.POD_CLAUDE_HTTP_HOOKS).toBeUndefined()
    process.env.POD_CLAUDE_HTTP_HOOKS = '1'
    setPlatform('linux')
    expect(createDaemonPodHookRelay(deps())).toBeNull()
    expect(process.env.POD_CLAUDE_HTTP_HOOKS).toBeUndefined()
  })
})
