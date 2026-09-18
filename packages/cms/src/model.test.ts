import { describe, expect, it } from 'vitest'
import { CONTENT_COLLECTIONS, contentCollection } from './collections/index.ts'
import { CONTENT_FIELD_TYPES } from './fields.ts'
import { CONTENT_GLOBALS, contentGlobal } from './globals/index.ts'

/**
 * W-SYS-08 — the content model.
 *
 * The acceptance names six collections. Asserting they exist is cheap and it is not the interesting part;
 * what matters is that each one is versioned with drafts, that the model has no numeric field type, and
 * that the two lookups deny an unknown slug rather than returning something.
 */
describe('acceptance — the six collections exist', () => {
  const expected = [
    'pages',
    'journal_posts',
    'faq_entries',
    'service_narrative',
    'therapist_narrative',
    'testimonials',
  ]

  it('is exactly those, in the admin’s order', () => {
    expect(CONTENT_COLLECTIONS.map((collection) => collection.slug)).toEqual(expected)
  })

  it('every one keeps versions', () => {
    // docs/09 §5 requires a diff before save and a revert to any prior version. A collection with one
    // version can offer neither, and `maxVersions: 0` in Payload means unlimited — which is a different
    // decision and should not be reachable by leaving the field off.
    for (const collection of CONTENT_COLLECTIONS) {
      expect(collection.maxVersions, collection.slug).toBeGreaterThan(1)
    }
  })

  it('every one names a title field that it actually has', () => {
    for (const collection of CONTENT_COLLECTIONS) {
      const names = collection.fields.map((field) => field.name)
      expect(names, collection.slug).toContain(collection.titleField)
    }
  })

  it('every one says what it is for', () => {
    for (const collection of CONTENT_COLLECTIONS) {
      expect(collection.purpose.length, collection.slug).toBeGreaterThan(30)
      expect(collection.label.length, collection.slug).toBeGreaterThan(3)
    }
  })

  it('uses only declared field types', () => {
    const allowed = new Set<string>(CONTENT_FIELD_TYPES)
    for (const collection of [...CONTENT_COLLECTIONS, ...CONTENT_GLOBALS]) {
      for (const field of collection.fields) {
        expect(allowed.has(field.type), `${collection.slug}.${field.name}`).toBe(true)
      }
    }
  })

  it('has no numeric field type at all', () => {
    // The fence from `fields.ts`: every number here would be money in fils, a duration, or a count, and
    // each of those has an owner that is not the CMS. FAQ ordering uses Payload's own order column
    // instead, which is why `faq_entries` is `orderable`.
    expect([...CONTENT_FIELD_TYPES]).not.toContain('number')
    expect(contentCollection('faq_entries')?.orderable).toBe(true)
  })

  it('declares every select’s options, so an editor cannot type a value nothing handles', () => {
    for (const collection of [...CONTENT_COLLECTIONS, ...CONTENT_GLOBALS]) {
      for (const field of collection.fields) {
        if (field.type !== 'select') continue
        expect((field.options ?? []).length, `${collection.slug}.${field.name}`).toBeGreaterThan(1)
      }
    }
  })

  it('looks a collection up by slug and denies an unknown one', () => {
    expect(contentCollection('service_narrative')?.slug).toBe('service_narrative')
    expect(contentCollection('services')).toBeUndefined()
  })
})

describe('acceptance — the globals', () => {
  it('are the compliance notices and the editorial defaults', () => {
    expect(CONTENT_GLOBALS.map((global) => global.slug)).toEqual([
      'compliance_notices',
      'editorial_defaults',
    ])
  })

  it('declare different write permissions, which is the point of having two', () => {
    expect(contentGlobal('compliance_notices')?.writePermission).toBe('settings:write_compliance')
    expect(contentGlobal('editorial_defaults')?.writePermission).toBe('content:write')
  })

  it('denies an unknown slug', () => {
    expect(contentGlobal('settings')).toBeUndefined()
  })
})

describe('the treatment narrative’s catalogue reference', () => {
  it('is a required uuidRef', () => {
    const field = contentCollection('service_narrative')?.fields.find(
      (candidate) => candidate.name === 'catalogue_service_id',
    )
    expect(field?.type).toBe('uuidRef')
    expect(field?.required).toBe(true)
  })

  it('can be archived as well as published, which is what the lifecycle rule depends on', () => {
    const state = contentCollection('service_narrative')?.fields.find(
      (candidate) => candidate.name === 'editorial_state',
    )
    expect(state?.options).toEqual(['live', 'archived'])
  })
})

describe('the therapist narrative', () => {
  it('references a therapist and carries prose, and has no name field of any kind', () => {
    const fields = contentCollection('therapist_narrative')?.fields ?? []
    const names = fields.map((field) => field.name)
    expect(names).toContain('therapist_id')
    expect(names).toContain('approach')
    // Asserted here as well as in the boundary rule: this is the list the rule reads, and a test that
    // only exercised the rule would pass if the list were replaced.
    expect(names.filter((name) => /name/i.test(name))).toEqual([])
  })
})
