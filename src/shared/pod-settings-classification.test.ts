import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { getDefaultSettings } from './constants'
import { POD_SETTINGS_HIDDEN, POD_SETTINGS_SECRET_KEYS } from './pod-settings-classification'
import { POD_SETTINGS_PAGES } from './pod-settings-pages'
import { POD_SETTINGS_FIELDS, PodSettingsValuesSchema } from './pod-settings-schema'

const fields = Object.keys(POD_SETTINGS_FIELDS)
const hidden = Object.keys(POD_SETTINGS_HIDDEN)
const secrets: readonly string[] = POD_SETTINGS_SECRET_KEYS

describe('podSettings classification', () => {
  // The compile-time checks in pod-settings-classification.ts cover optional keys too.
  it('classifies every default setting exactly once', () => {
    for (const key of Object.keys(getDefaultSettings('/Users/e2e'))) {
      const places = [fields, hidden, secrets].filter((list) => list.includes(key))
      expect(places, key).toHaveLength(1)
    }
    expect(new Set([...fields, ...hidden, ...secrets]).size).toBe(
      fields.length + hidden.length + secrets.length
    )
  })

  it('lists no secret or hidden key in the JSON schema', () => {
    const properties = Object.keys(
      z.toJSONSchema(PodSettingsValuesSchema, { io: 'input' }).properties ?? {}
    )
    expect(properties.sort()).toEqual([...fields].sort())
  })

  it('places every field in exactly one section of the pages', () => {
    const placed = POD_SETTINGS_PAGES.flatMap((page) =>
      page.sections.flatMap((section) => section.keys)
    )
    expect([...placed].sort()).toEqual([...fields].sort())
    expect(new Set(placed).size).toBe(placed.length)
  })

  it('gives every field a title', () => {
    const { properties } = z.toJSONSchema(PodSettingsValuesSchema, { io: 'input' })
    for (const key of fields) {
      expect(Reflect.get(properties ?? {}, key), key).toHaveProperty('title')
    }
  })
})
