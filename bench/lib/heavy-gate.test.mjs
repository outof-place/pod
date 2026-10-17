import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { heavyGate, stateRefusal } from './heavy-gate.mjs'

const at = (hhmm) => {
  const now = new Date()
  const [h, m] = hhmm.split(':').map(Number)
  now.setHours(h, m, 0, 0)
  return now
}

test('only GO with an until passes, and never within 10 min of the end', () => {
  assert.equal(stateRefusal('GO until=13:00 load<60 df>=30GiB', at('12:00')), null)
  assert.match(stateRefusal('GO until=13:00', at('12:51')), /within 10 min/)
  assert.match(stateRefusal('GO until=13:00', at('12:50')), /within 10 min/)
  assert.equal(stateRefusal('GO until=13:00', at('12:49')), null)
  assert.match(stateRefusal('HOLD disk', at('12:00')), /not GO: HOLD disk/)
  assert.match(stateRefusal(null, at('12:00')), /missing/)
  assert.match(stateRefusal('GO', at('12:00')), /no until/)
})

test('the bench hold needs POD_BENCH_GO=1, then state, load and disk decide', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'heavy-gate-test-'))
  const holdFile = path.join(dir, 'hold')
  const stateFile = path.join(dir, 'state')
  writeFileSync(holdFile, 'QUEUE MODE\n')
  writeFileSync(stateFile, 'GO until=23:59\n')
  const base = { now: at('12:00'), holdFile, stateFile, load: 10, freeGiB: 64 }
  assert.match(heavyGate({ ...base, env: {} }), /bench hold/)
  assert.equal(heavyGate({ ...base, env: { POD_BENCH_GO: '1' } }), null)
  assert.match(heavyGate({ ...base, env: { POD_BENCH_GO: '1' }, load: 75 }), /load 75/)
  assert.match(heavyGate({ ...base, env: { POD_BENCH_GO: '1' }, freeGiB: 12 }), /12\.0 GiB free/)
  writeFileSync(stateFile, 'HOLD user\n')
  assert.match(heavyGate({ ...base, env: { POD_BENCH_GO: '1' } }), /not GO/)
})
