// Fork-only (Pod): what the in-place template update relies on: a renamed OrbStack machine keeps its
// MAC and IPv4. Opt-in: POD_E2E_ORBSTACK=1 and POD_E2E_ORBSTACK_MACHINE=<an existing pod-test-*
// machine>. It never creates, clones or deletes a machine (the address pool is the user's too), and
// renames the machine back afterwards.
import { describe, expect, it } from 'vitest'
import {
  createOrbstackToolRunner,
  resolveOrbstackToolPaths,
  type OrbstackToolRunner
} from './pod-orbstack-tools'

const machine = process.env.POD_E2E_ORBSTACK_MACHINE ?? ''
const enabled =
  process.platform === 'darwin' &&
  process.env.POD_E2E_ORBSTACK === '1' &&
  /^pod-test-[a-z0-9-]+$/.test(machine)

const IDENTITY = `cat /sys/class/net/eth0/address
ip -4 -o addr show dev eth0 | awk '{print $4}'`

describe.skipIf(!enabled)('real OrbStack rename', () => {
  it("keeps a machine's MAC and IPv4 across stop, rename and start", async () => {
    const tools = createOrbstackToolRunner(() => resolveOrbstackToolPaths())
    const verbs: string[] = []
    const run: OrbstackToolRunner = (tool, args, options) => {
      verbs.push(`${tool} ${args[0] ?? ''}`)
      return tools(tool, args, options)
    }
    const orb = async (...args: string[]) => {
      const result = await run('orb', args, { timeoutMs: 120_000 })
      expect(result.code, `orb ${args.join(' ')}: ${result.stderr}`).toBe(0)
      return result.stdout
    }
    const renamed = `${machine}-renamed`
    // `orb run` starts a stopped machine; each read stops it again, as a template rests.
    const identity = async (name: string) => {
      const out = await orb('run', '-m', name, 'sh', '-c', IDENTITY)
      await orb('stop', name)
      return out.trim().split('\n')
    }
    try {
      const before = await identity(machine)
      expect(before[0]).toMatch(/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/)
      expect(before[1]).toMatch(/^\d+\.\d+\.\d+\.\d+\/\d+$/)
      await orb('rename', machine, renamed)
      await orb('start', renamed)
      expect(await identity(renamed)).toEqual(before)
      console.info(`[rename-address] ${JSON.stringify({ before, verbs })}`)
    } finally {
      if ((await run('orb', ['info', renamed, '--format', 'json'])).code === 0) {
        await run('orb', ['stop', renamed], { timeoutMs: 120_000 })
        await run('orb', ['rename', renamed, machine], { timeoutMs: 120_000 })
      }
    }
    expect(verbs.filter((verb) => /^orb (create|clone|delete)$/.test(verb))).toEqual([])
    expect((await run('orb', ['info', machine, '--format', 'json'])).code).toBe(0)
  }, 300_000)
})
