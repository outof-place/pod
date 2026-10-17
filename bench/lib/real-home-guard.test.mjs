import assert from 'node:assert/strict'
import test from 'node:test'
import { assertRealHomeUntouched, realHomeState } from './real-home-guard.mjs'

test('an unchanged account passes, and the state covers settings.json', () => {
  const before = realHomeState()
  assert.ok(Object.keys(before).some((file) => file.endsWith('/.claude/settings.json')))
  assert.deepEqual(assertRealHomeUntouched(before, 'in a test', '/private/tmp/no-such-run-dir.x'), [])
})

test('a content change throws, a same-content rewrite is only reported', () => {
  const before = realHomeState()
  const [file] = Object.keys(before)
  const changed = { ...before, [file]: { ...before[file], sha256: 'not the same' } }
  assert.throws(() => assertRealHomeUntouched(changed, 'in a test', '/private/tmp/no-such-run-dir.x'), /changed in a test/)
  const touched = { ...before, [file]: { ...before[file], mtimeMs: before[file].mtimeMs - 1 } }
  assert.deepEqual(assertRealHomeUntouched(touched, 'in a test', '/private/tmp/no-such-run-dir.x'), [file])
})
