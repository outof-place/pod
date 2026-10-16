import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { SIM_RPC_METHODS } from '../rpc-contract/sim-params'
import { simDeviceCountsTowardCap } from './sim-lifecycle'
import { SimPoolSnapshot } from './sim-pool-snapshot'
import { readSimRegistry, SIM_REGISTRY_VERSION, SimRegistryFile } from './sim-registry'
import { SIM_REFUSAL_CODES, SimRefusal, SimRefusalInput, simRefusal } from './sim-refusals'
import { SIM_RPC_RESULTS_BY_METHOD, SimLeaseOutcome, SimSubscribeFrame } from './sim-results'

const load = (name: string): unknown =>
  JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'))

describe('the pool snapshot', () => {
  const snapshots = z
    .array(z.object({ name: z.string(), snapshot: z.unknown() }).strict())
    .parse(load('pool-snapshots.json'))

  for (const { name, snapshot } of snapshots) {
    it(`decodes ${name} with every field kept`, () => {
      expect(SimPoolSnapshot.parse(snapshot)).toEqual(snapshot)
    })
  }

  it('tolerates a field a newer runtime adds', () => {
    const [first] = snapshots
    const newer = { ...z.record(z.string(), z.unknown()).parse(first?.snapshot), pins: [] }
    expect(SimPoolSnapshot.safeParse(newer).success).toBe(true)
  })

  it('counts every device that holds a boot slot as booted, a failed one too', () => {
    const stream = z
      .object({ frames: z.array(z.object({ snapshot: z.unknown().optional() }).loose()) })
      .loose()
      .parse(load('rpc-stream.json'))
    const all = [
      ...snapshots.map(({ snapshot }) => snapshot),
      ...stream.frames.flatMap((frame) => (frame.snapshot ? [frame.snapshot] : []))
    ]
    for (const snapshot of all.map((raw) => SimPoolSnapshot.parse(raw))) {
      const holding = snapshot.devices.filter((device) => simDeviceCountsTowardCap(device.state))
      expect(snapshot.budget.booted, `revision ${snapshot.revision}`).toBe(holding.length)
    }
  })

  it('numbers the queue by when each waiter joined it', () => {
    for (const { name, snapshot } of snapshots) {
      const queued = SimPoolSnapshot.parse(snapshot).leases.flatMap((lease) =>
        lease.queue ? [lease.queue] : []
      )
      const bySince = [...queued].sort((a, b) => a.since - b.since).map((queue) => queue.position)
      expect(bySince, name).toEqual(queued.map((_, index) => index + 1))
    }
  })
})

describe('sim.* results', () => {
  const results = z
    .array(z.object({ name: z.string(), method: z.string(), result: z.unknown() }).strict())
    .parse(load('rpc-results.json'))

  for (const { name, method, result } of results) {
    it(`decodes ${method}: ${name} with every field kept`, () => {
      const schema = SIM_RPC_RESULTS_BY_METHOD[z.enum(SIM_RPC_METHODS).parse(method)]
      expect(schema.parse(result)).toEqual(result)
    })
  }

  it('the sim.subscribe frames decode', () => {
    const stream = z
      .object({ method: z.literal('sim.subscribe'), frames: z.array(z.unknown()) })
      .strict()
      .parse(load('rpc-stream.json'))
    for (const frame of stream.frames) {
      expect(SimSubscribeFrame.parse(frame)).toEqual(frame)
    }
  })

  it('a waiting outcome lists a few waiters and holders and counts the rest', () => {
    for (const { method, name, result } of results) {
      if (method !== 'sim.lease' && method !== 'sim.waitLease') {
        continue
      }
      const outcome = SimLeaseOutcome.parse(result)
      if (outcome.status === 'waiting') {
        const position = outcome.lease.queue?.position ?? 1
        expect(outcome.ahead.length + outcome.aheadOmitted, name).toBe(position - 1)
      }
    }
  })

  it('every app-derived payload carries the untrusted envelope', () => {
    for (const { result } of results) {
      const text = JSON.stringify(result)
      for (const key of ['"nodes"', '"lines"', '"image"', '"node"']) {
        if (text.includes(key)) {
          expect(text, key).toContain('"untrusted":true')
        }
      }
    }
  })
})

describe('refusals', () => {
  const cases = z
    .array(z.object({ input: SimRefusalInput, refusal: SimRefusal }).strict())
    .parse(load('refusals.json'))

  for (const { input, refusal } of cases) {
    it(`${input.code} names the next command`, () => {
      expect(simRefusal(input)).toEqual(refusal)
      expect(
        refusal.message.endsWith(`Run: ${refusal.next}`) ||
          refusal.message.endsWith(`run: ${refusal.next}`)
      ).toBe(true)
    })
  }

  it('every refusal code has a fixture', () => {
    const covered = new Set(cases.map(({ input }) => input.code))
    expect(SIM_REFUSAL_CODES.filter((code) => !covered.has(code))).toEqual([])
  })

  it('no refusal text carries an em or en dash', () => {
    for (const { refusal } of cases) {
      expect(refusal.message).not.toMatch(/[\u2013\u2014]/)
    }
  })
})

describe('the Mac-wide pool registry', () => {
  const fixture = z
    .object({
      valid: z.array(z.object({ name: z.string(), registry: z.unknown() }).strict()),
      invalid: z.array(
        z.object({ name: z.string(), registry: z.unknown(), path: z.string() }).strict()
      )
    })
    .strict()
    .parse(load('registry.json'))

  for (const { name, registry } of fixture.valid) {
    it(`reads ${name}, and a rewrite keeps every field at every level`, () => {
      expect(SimRegistryFile.parse(registry)).toEqual(registry)
      const read = readSimRegistry(JSON.stringify(registry))
      expect(read.ok && JSON.parse(JSON.stringify(read.registry))).toEqual(registry)
    })
  }

  for (const { name, registry, path } of fixture.invalid) {
    it(`turns the pool off on ${name}, and never writes it`, () => {
      const parsed = SimRegistryFile.safeParse(registry)
      expect(parsed.error?.issues.map((issue) => issue.path.join('.'))).toContain(path)
      expect(readSimRegistry(JSON.stringify(registry))).toMatchObject({
        ok: false,
        reason: 'registryUnreadable'
      })
    })
  }

  it('says a newer Pod wrote the file, so the fix is an update', () => {
    const newer = { version: SIM_REGISTRY_VERSION + 1, updatedAt: 1, devices: [], leases: [] }
    const read = readSimRegistry(JSON.stringify(newer))
    expect(read.ok ? '' : read.message).toContain('newer Pod (version 2)')
  })

  it('turns the pool off on a file that is not JSON, and starts empty with no file', () => {
    expect(readSimRegistry('{"version": 1,')).toMatchObject({ ok: false })
    expect(readSimRegistry(null)).toEqual({
      ok: true,
      registry: { version: SIM_REGISTRY_VERSION, updatedAt: 0, devices: [], leases: [] }
    })
  })
})
