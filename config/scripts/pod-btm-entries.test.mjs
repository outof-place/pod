import { describe, expect, it } from 'vitest'
import {
  compareBtm,
  localPath,
  parseBtmDump,
  podEntries,
  sfltoolRefusal
} from './pod-btm-entries.mjs'

// The shape of `sfltool dumpbtm` on macOS 27, with made-up records. Never run sfltool here: it
// puts an admin authorization dialog on the user's screen.
const record = (n, fields) =>
  [` #${n}:`, ...Object.entries(fields).map(([k, v]) => `${k.padStart(21)}: ${v}`), ''].join('\n')

const dump = (records) =>
  [
    '========================',
    ' Records for UID 501 : 00000000-0000-0000-0000-000000000501',
    '========================',
    '',
    ' Items:',
    records.join('\n')
  ].join('\n')

const classicAgent = {
  UUID: 'A',
  Name: 'Pod',
  Type: 'agent (0x8)',
  Disposition: '[enabled, allowed, notified] (0xb)',
  Identifier: '8.codes.pod.app.acc.tick',
  URL: 'Contents/Library/LaunchAgents/codes.pod.app.acc.tick.plist',
  'Parent Identifier': '2.codes.pod.app'
}
const classicApp = {
  UUID: 'B',
  Name: 'Pod',
  Type: 'app (0x2)',
  Disposition: '[enabled, allowed, notified] (0xb)',
  Identifier: '2.codes.pod.app',
  URL: '/Applications/Pod.app',
  'Bundle Identifier': 'codes.pod.app'
}
const someoneElse = {
  UUID: 'C',
  Name: 'Other',
  Type: 'app (0x2)',
  Identifier: '2.com.example.other',
  URL: '/Applications/Other.app',
  'Bundle Identifier': 'com.example.other'
}
const podMenu = {
  UUID: 'D',
  Name: 'Pod Menu',
  Type: 'login item (0x4)',
  Identifier: '4.com.filip.claude-acc.menubar',
  URL: '/Applications/Pod.app/Contents/Library/LoginItems/Pod%20Menu.app',
  'Parent Identifier': '2.codes.pod.app'
}

describe('Pod in BTM', () => {
  it("keeps Pod's records, Pod Menu's included, and leaves everyone else's out", () => {
    const records = parseBtmDump(
      dump([record(1, classicAgent), record(2, someoneElse), record(3, podMenu)])
    )
    expect(records).toHaveLength(3)
    expect(records[0]).toMatchObject({ uid: 501, Identifier: '8.codes.pod.app.acc.tick' })
    expect(podEntries(records).map((r) => r.UUID)).toEqual(['A', 'D'])
  })

  it('flags a second Pod (one identifier, two bundles) and an entry for a bundle that is gone', () => {
    const before = podEntries(parseBtmDump(dump([record(1, classicApp)])))
    const moved = {
      ...classicApp,
      UUID: 'E',
      URL: '/Applications/Pod.app/Contents/Helpers/Pod Runtime.app'
    }
    const after = podEntries(parseBtmDump(dump([record(1, classicApp), record(2, moved)])))
    const gone = new Set(['/Applications/Pod.app'])
    const result = compareBtm(before, after, (path) => !gone.has(path))
    expect(result.added.map((r) => r.UUID)).toEqual(['E'])
    expect(result.duplicates).toEqual([
      { id: '501|2.codes.pod.app', urls: ['/Applications/Pod.app', moved.URL] }
    ])
    expect(result.missing.map((r) => r.UUID)).toEqual(['B'])
  })

  it('reports a disposition change and nothing else for an unchanged set', () => {
    const before = podEntries(parseBtmDump(dump([record(1, classicAgent)])))
    const off = { ...classicAgent, Disposition: '[disabled, allowed, notified] (0xa)' }
    const after = podEntries(parseBtmDump(dump([record(1, off)])))
    expect(compareBtm(before, after)).toMatchObject({
      added: [],
      removed: [],
      changed: [{ UUID: 'A' }],
      duplicates: [],
      missing: []
    })
  })

  it("reads BTM's /Users/<uid>/ and file URLs as paths on this Mac", () => {
    expect(localPath('/Users/501/Library/LaunchAgents/a.plist', 501, '/Users/me')).toBe(
      '/Users/me/Library/LaunchAgents/a.plist'
    )
    expect(localPath('/Users/502/x', 501, '/Users/me')).toBe('/Users/502/x')
    expect(localPath('file:///Applications/Pod%20Runtime.app/', 501, '/Users/me')).toBe(
      '/Applications/Pod Runtime.app/'
    )
  })

  it('runs sfltool only for a person at a terminal who says they will authorize', () => {
    expect(sfltoolRefusal(['--save', 'before.json'], true)).toMatch(/--i-will-authorize/)
    expect(sfltoolRefusal(['--i-will-authorize'], false)).toMatch(/TTY/)
    expect(sfltoolRefusal(['--i-will-authorize', '--compare', 'before.json'], true)).toBeNull()
  })
})
