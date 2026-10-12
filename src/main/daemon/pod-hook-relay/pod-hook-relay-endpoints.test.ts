import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  disablePodHookRelayEndpoints,
  enablePodHookRelayEndpoints,
  notePodHookRelaySpawnEnv,
  podHookRelayEndpointAllowed
} from './pod-hook-relay-endpoints'

const live = new Set<string>()
vi.mock('../pod-lane/pod-lane-sessions', () => ({
  livePodLaneSession: (sessionId: string) => (live.has(sessionId) ? {} : null)
}))

afterEach(() => {
  disablePodHookRelayEndpoints()
  live.clear()
})

describe('pod-hook-relay endpoints', () => {
  it('allows only a path a session was spawned with', () => {
    enablePodHookRelayEndpoints()
    notePodHookRelaySpawnEnv('s1', { ORCA_AGENT_HOOK_ENDPOINT: '/u/Pod/agent-hooks/endpoint.env' })
    expect(podHookRelayEndpointAllowed('/u/Pod/agent-hooks/endpoint.env')).toBe(true)
    expect(podHookRelayEndpointAllowed('/u/Pod/agent-hooks/../../etc/endpoint.env')).toBe(false)
    expect(podHookRelayEndpointAllowed('')).toBe(false)
  })

  it('keeps a live session past the grace and forgets one that is gone', () => {
    enablePodHookRelayEndpoints()
    notePodHookRelaySpawnEnv('alive', { ORCA_AGENT_HOOK_ENDPOINT: '/a/endpoint.env' }, 0)
    notePodHookRelaySpawnEnv('gone', { ORCA_AGENT_HOOK_ENDPOINT: '/b/endpoint.env' }, 0)
    live.add('alive')
    expect(podHookRelayEndpointAllowed('/b/endpoint.env', 59_000)).toBe(true)
    expect(podHookRelayEndpointAllowed('/a/endpoint.env', 61_000)).toBe(true)
    expect(podHookRelayEndpointAllowed('/b/endpoint.env', 61_000)).toBe(false)
  })

  it('drops a session respawned without an endpoint, and ignores relative paths', () => {
    enablePodHookRelayEndpoints()
    notePodHookRelaySpawnEnv('s1', { ORCA_AGENT_HOOK_ENDPOINT: '/a/endpoint.env' })
    notePodHookRelaySpawnEnv('s1', {})
    notePodHookRelaySpawnEnv('s2', { ORCA_AGENT_HOOK_ENDPOINT: 'endpoint.env' })
    expect(podHookRelayEndpointAllowed('/a/endpoint.env')).toBe(false)
    expect(podHookRelayEndpointAllowed('endpoint.env')).toBe(false)
  })

  it('records nothing while the relay is off', () => {
    notePodHookRelaySpawnEnv('s1', { ORCA_AGENT_HOOK_ENDPOINT: '/a/endpoint.env' })
    enablePodHookRelayEndpoints()
    expect(podHookRelayEndpointAllowed('/a/endpoint.env')).toBe(false)
  })
})
