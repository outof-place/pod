// Fork-only (Pod): an in-memory `orb`/`orbctl` for template tests. Machines are records; clones copy
// the config, so tests can check what a clone keeps. Like OrbStack 2.2.3, every new machine takes a
// fresh address and a rename keeps it.
import type { OrbstackToolResult, OrbstackToolRunner } from './pod-orbstack-tools'

type FakeMachine = {
  isolated: boolean
  isolateNetwork: boolean
  running: boolean
  mounts: string[]
  address: number
}

export function createFakeOrb(options: { claudeVersion?: string; running?: boolean } = {}) {
  const machines = new Map<string, FakeMachine>()
  const calls: string[][] = []
  const failures = new Map<string, string>()
  let addresses = 0
  const ok = (stdout = ''): OrbstackToolResult => ({ code: 0, stdout, stderr: '', timedOut: false })
  const fail = (stderr: string): OrbstackToolResult => ({
    code: 1,
    stdout: '',
    stderr,
    timedOut: false
  })

  const orb = (args: readonly string[]): OrbstackToolResult => {
    const [verb = '', ...rest] = args
    const failure = failures.get(verb)
    if (failure) {
      return fail(failure)
    }
    const name = rest.at(-1) ?? ''
    switch (verb) {
      case 'info': {
        const machine = machines.get(rest[0] ?? '')
        return machine
          ? ok(
              JSON.stringify({
                record: {
                  config: { isolated: machine.isolated, isolate_network: machine.isolateNetwork }
                }
              })
            )
          : fail('machine not found')
      }
      case 'create':
        if (machines.has(name)) {
          return fail('exists')
        }
        machines.set(name, {
          isolated: rest.includes('--isolated'),
          isolateNetwork: rest.includes('--isolate-network'),
          running: true,
          mounts: [],
          address: ++addresses
        })
        return ok()
      case 'clone': {
        const [from = '', to = ''] = rest
        const source = machines.get(from)
        if (!source || machines.has(to)) {
          return fail('cannot clone')
        }
        machines.set(to, {
          ...source,
          running: false,
          mounts: [...source.mounts],
          address: ++addresses
        })
        return ok()
      }
      case 'rename': {
        const [from = '', to = ''] = rest
        const machine = machines.get(from)
        if (!machine || machines.has(to)) {
          return fail('cannot rename')
        }
        machines.delete(from)
        machines.set(to, machine)
        return ok()
      }
      case 'start':
      case 'stop': {
        const machine = machines.get(name)
        if (!machine) {
          return fail('machine not found')
        }
        machine.running = verb === 'start'
        return ok()
      }
      case 'delete':
        machines.delete(name)
        return ok()
      case 'run':
        return ok(
          args.some((arg) => arg.includes('--version'))
            ? `${options.claudeVersion ?? '2.1.296'} (Claude Code)`
            : ''
        )
      default:
        return ok()
    }
  }

  const orbctl = (args: readonly string[]): OrbstackToolResult => {
    if (args[0] === 'status') {
      return options.running === false ? { ...fail(''), stdout: 'Stopped' } : ok('Running')
    }
    const [, op, key = '', value = ''] = args
    const name = /^machine\.(.+)\.mounts$/.exec(key)?.[1] ?? ''
    const machine = machines.get(name)
    if (!machine) {
      return fail('no such machine')
    }
    machine.mounts = op === 'set' ? [value] : [...machine.mounts, value]
    return ok()
  }

  const run: OrbstackToolRunner = async (tool, args) => {
    calls.push([tool, ...args])
    return tool === 'orb' ? orb(args) : tool === 'orbctl' ? orbctl(args) : fail('no docker')
  }
  return { run, machines, calls, failures, addressesTaken: () => addresses }
}
