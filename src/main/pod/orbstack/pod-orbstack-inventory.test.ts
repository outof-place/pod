import { describe, expect, it } from 'vitest'
import {
  parseDockerContainers,
  parseDockerContexts,
  parseOrbMachines,
  parseOrbctlStatus,
  parseOrbctlVersion,
  withDockerStats
} from './pod-orbstack-inventory'

// Captured from `orb list -f json` on OrbStack 2.2.3.
const ORB_LIST = `[
  {
    "id": "01M4HXHNTVZXRXR1F5PV7GC8R7",
    "name": "pod-probe-a1",
    "image": { "distro": "ubuntu", "version": "noble", "arch": "arm64", "variant": "default" },
    "config": { "isolated": false, "default_username": "marcel" },
    "builtin": false,
    "state": "running"
  },
  { "name": "" },
  { "name": "dev", "state": "stopped" }
]`

describe('parseOrbMachines', () => {
  it('keeps the fields Pod shows and drops malformed rows', () => {
    expect(parseOrbMachines(ORB_LIST)).toEqual([
      {
        name: 'pod-probe-a1',
        state: 'running',
        distro: 'ubuntu',
        distroVersion: 'noble',
        arch: 'arm64'
      },
      { name: 'dev', state: 'stopped', distro: null, distroVersion: null, arch: null }
    ])
  })

  it('reads empty output as no machines and rejects non-arrays', () => {
    expect(parseOrbMachines('')).toEqual([])
    expect(parseOrbMachines('{"name":"x"}')).toBeNull()
    expect(parseOrbMachines('not json')).toBeNull()
  })
})

describe('parseDockerContexts', () => {
  const lines = [
    '{"Current":false,"Description":"Docker Desktop","DockerEndpoint":"unix:///Users/me/.docker/run/docker.sock","Name":"desktop-linux"}',
    '{"Current":true,"Description":"OrbStack","DockerEndpoint":"unix:///Users/me/.orbstack/run/docker.sock","Name":"orbstack"}'
  ]

  it('finds the current context in one-object-per-line output', () => {
    expect(parseDockerContexts(lines.join('\n'))).toEqual({
      current: 'orbstack',
      currentIsOrbstack: true,
      orbstackContextExists: true
    })
  })

  it('reads the array form and a renamed context on the OrbStack socket', () => {
    const renamed = lines[1].replace('"Name":"orbstack"', '"Name":"mine"')
    expect(parseDockerContexts(`[${lines[0]},${renamed}]`)).toEqual({
      current: 'mine',
      currentIsOrbstack: true,
      orbstackContextExists: false
    })
  })

  it('reports another engine as not OrbStack', () => {
    const desktop = lines[0].replace('"Current":false', '"Current":true')
    expect(
      parseDockerContexts(`${desktop}\n${lines[1].replace('"Current":true', '"Current":false')}`)
    ).toMatchObject({
      current: 'desktop-linux',
      currentIsOrbstack: false,
      orbstackContextExists: true
    })
  })
})

describe('parseDockerContainers and withDockerStats', () => {
  const ps = [
    '{"id":"57eae3b36dff","name":"web-1","image":"nginx","state":"running","status":"Up 2 minutes","project":"web","workingDir":"/Users/me/pod/acme/web"}',
    '{"id":"68541c634bad","name":"loose","image":"redis","state":"exited","status":"Exited (0)","project":"","workingDir":""}',
    'garbage'
  ].join('\n')

  it('maps compose labels and leaves stats empty', () => {
    expect(parseDockerContainers(ps)).toEqual([
      {
        id: '57eae3b36dff',
        name: 'web-1',
        image: 'nginx',
        state: 'running',
        status: 'Up 2 minutes',
        composeProject: 'web',
        composeWorkingDir: '/Users/me/pod/acme/web',
        cpuPercent: null,
        memoryUsage: null
      },
      expect.objectContaining({ id: '68541c634bad', composeProject: null, composeWorkingDir: null })
    ])
  })

  it('joins stats by id prefix', () => {
    const containers = withDockerStats(
      parseDockerContainers(ps),
      '{"id":"57eae3b36dff","cpu":"1.25%","mem":"12.3MiB / 7.6GiB"}'
    )
    expect(containers[0]).toMatchObject({ cpuPercent: '1.25%', memoryUsage: '12.3MiB / 7.6GiB' })
    expect(containers[1]).toMatchObject({ cpuPercent: null, memoryUsage: null })
  })
})

describe('orbctl output', () => {
  it('reads the version and the service state', () => {
    expect(parseOrbctlVersion('Version: 2.2.3 (2020300)\nCommit: c83556b0')).toBe('2.2.3')
    expect(parseOrbctlVersion('')).toBeNull()
    expect(parseOrbctlStatus(0, 'Running\n')).toBe('running')
    expect(parseOrbctlStatus(1, 'Stopped\n')).toBe('stopped')
    expect(parseOrbctlStatus(null, '')).toBe('unknown')
  })
})
