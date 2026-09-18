import { isAppError } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import {
  assertBoundary,
  type BoundarySubject,
  boundaryViolations,
  CATALOGUE_OWNED_FIELD_NAMES,
  isCatalogueOwnedFieldName,
  isCrossBoundaryReference,
  isNameShapedFieldName,
  normaliseFieldName,
  shippedSubjects,
  walkFields,
} from './boundary.ts'
import { CONTENT_COLLECTIONS, SERVICE_NARRATIVE } from './collections/index.ts'
import type { ServiceNarrativeDocument, TherapistNarrativeDocument } from './documents.ts'

/**
 * W-SYS-08 — the catalogue boundary.
 *
 * Two independent mechanisms, tested independently, because either one on its own can be defeated.
 * The runtime rule below is what the gate script runs; the compile-time assertion further down is what
 * stops a page rendering a price even if the rule were switched off.
 */

function subject(slug: string, fields: readonly unknown[]): BoundarySubject {
  return { slug, fields }
}

describe('acceptance — the shipped model declares no catalogue-owned field', () => {
  it('passes its own rules', () => {
    expect(boundaryViolations(shippedSubjects())).toEqual([])
    expect(() => assertBoundary(shippedSubjects())).not.toThrow()
  })

  it('examined something, so passing means something', () => {
    // ADR 0002. A walk that found no fields would satisfy the assertion above for the wrong reason,
    // and this project has shipped a green gate over zero modules before.
    const fields = [...walkFields(shippedSubjects().flatMap((s) => [...s.fields]))]
    expect(fields.length).toBeGreaterThan(30)
    expect(shippedSubjects().length).toBe(CONTENT_COLLECTIONS.length + 2)
  })

  // The four the acceptance names, each on its own, so a rule that stopped matching one of them cannot
  // hide behind the other three.
  for (const name of CATALOGUE_OWNED_FIELD_NAMES) {
    it(`rejects a field named ${name}`, () => {
      const found = boundaryViolations([subject('pages', [{ name, type: 'text' }])])
      expect(found.map((v) => v.rule)).toEqual(['no-catalogue-field-in-cms'])
      expect(found[0]?.where).toBe(`pages.${name}`)
    })
  }

  it('rejects the spellings somebody would actually write', () => {
    for (const name of [
      'price_from',
      'priceFrom',
      'duration_minutes',
      'is_bookable',
      'vat_rate',
      'pricing_note',
      'tax_treatment',
    ]) {
      expect(isCatalogueOwnedFieldName(name), name).toBe(true)
    }
  })

  it('allows the names the CMS legitimately has, so the rule is not “no nouns”', () => {
    // The control. A rule that rejected everything would pass every case above and make the collection
    // impossible to author.
    for (const name of [
      'promise',
      'body',
      'aftercare',
      'seo_title',
      'published_on',
      'attribution_initials',
      'editorial_state',
      'catalogue_service_id',
    ]) {
      expect(isCatalogueOwnedFieldName(name), name).toBe(false)
    }
  })

  it('finds a catalogue field that nesting hid', () => {
    // The tidy spelling: a group called `commercials` with the price inside it. A top-level-only check
    // reports this clean.
    const found = boundaryViolations([
      subject('pages', [
        { name: 'commercials', type: 'group', fields: [{ name: 'price_fils', type: 'text' }] },
      ]),
    ])
    expect(found.map((v) => v.rule)).toEqual(['no-catalogue-field-in-cms'])
    expect(found[0]?.where).toBe('pages.commercials.price_fils')
  })

  it('finds one inside a tab and one inside a block', () => {
    const found = boundaryViolations([
      subject('pages', [
        { type: 'tabs', tabs: [{ label: 'Money', fields: [{ name: 'vat', type: 'text' }] }] },
        {
          name: 'sections',
          type: 'blocks',
          blocks: [{ fields: [{ name: 'duration', type: 'text' }] }],
        },
      ]),
    ])
    expect(found.map((v) => v.where).sort()).toEqual(['pages.sections.duration', 'pages.vat'])
  })

  it('normalises camelCase before matching, because both spellings arrive', () => {
    expect(normaliseFieldName('priceFrom')).toBe('price_from')
    expect(normaliseFieldName('VATRate')).toBe('vat_rate')
  })
})

describe('acceptance — the catalogue reference is a plain UUID, not a foreign key', () => {
  it('accepts uuidRef in the model and text in the generated config', () => {
    expect(
      boundaryViolations([
        subject('service_narrative', [{ name: 'catalogue_service_id', type: 'uuidRef' }]),
        subject('service_narrative', [{ name: 'catalogue_service_id', type: 'text' }]),
      ]),
    ).toEqual([])
  })

  it('rejects the same reference declared as a Payload relationship', () => {
    // A `relationship` field is a foreign key. Across this line it couples two migration chains that do
    // not deploy together — see collections/service-narrative.ts.
    const found = boundaryViolations([
      subject('service_narrative', [
        { name: 'catalogue_service_id', type: 'relationship', relationTo: 'service' },
      ]),
    ])
    expect(found.map((v) => v.rule)).toEqual(['catalogue-reference-must-be-a-plain-uuid'])
  })

  it('recognises the reference names the model uses, and not every id', () => {
    expect(isCrossBoundaryReference('catalogue_service_id')).toBe(true)
    expect(isCrossBoundaryReference('therapist_id')).toBe(true)
    // The control: Payload's own document id is not a cross-boundary reference, and a rule that thought
    // it was would forbid every relationship inside the CMS.
    expect(isCrossBoundaryReference('id')).toBe(false)
    expect(isCrossBoundaryReference('related_post_id')).toBe(false)
  })
})

describe('acceptance — therapist_narrative carries no name', () => {
  it('rejects a display name on that collection', () => {
    const found = boundaryViolations([
      subject('therapist_narrative', [{ name: 'display_name', type: 'text' }]),
    ])
    expect(found.map((v) => v.rule)).toEqual(['therapist-narrative-carries-no-name'])
  })

  it('rejects every name-shaped spelling', () => {
    for (const name of ['name', 'full_name', 'firstName', 'surname', 'preferred_names']) {
      expect(isNameShapedFieldName(name), name).toBe(true)
    }
  })

  it('allows the same field name on a collection that is not about a therapist', () => {
    // The control, and it matters: the rule is about a therapist's name reaching a public page without
    // an admin having approved it, not about the word "name". A `name` field on `pages` is unremarkable.
    expect(boundaryViolations([subject('pages', [{ name: 'name', type: 'text' }])])).toEqual([])
    // And a rule that banned the substring would reject this, which is a legitimate field name.
    expect(isNameShapedFieldName('filename')).toBe(false)
    expect(isNameShapedFieldName('namespace')).toBe(false)
  })

  it('throws with every rule named, so a fixture can be asserted by rule', () => {
    let message = ''
    try {
      assertBoundary([
        subject('therapist_narrative', [
          { name: 'display_name', type: 'text' },
          { name: 'price', type: 'text' },
        ]),
      ])
    } catch (error) {
      expect(isAppError(error)).toBe(true)
      message = error instanceof Error ? error.message : ''
    }
    expect(message).toContain('[therapist-narrative-carries-no-name]')
    expect(message).toContain('[no-catalogue-field-in-cms]')
  })
})

/**
 * The compile-time half.
 *
 * `ServiceNarrativeDocument` is derived from `SERVICE_NARRATIVE.fields` (see `documents.ts`), so its
 * properties ARE the model's field names. Reading `doc.price` is therefore a type error — and the
 * `@ts-expect-error` below is what turns that into a test: add a `price` field to the descriptor and the
 * directive becomes unused, which `pnpm typecheck` reports as
 * `TS2578: Unused '@ts-expect-error' directive`. `scripts/test-gates.mjs` performs exactly that mutation.
 *
 * This is not the same check as the rule above and it is not redundant with it. The rule protects the
 * MODEL; this protects the RENDERER. A page could read a price out of a CMS document type somebody
 * hand-wrote without ever touching a descriptor, and the rule would never see it.
 */
describe('acceptance — rendering a price from CMS data does not compile', () => {
  /**
   * Annotated, not `satisfies`.
   *
   * With `as const satisfies ServiceNarrativeDocument` this object's type stays the literal's, so
   * `narrative.price` remains an error even after a `price` field is added to the model — the directives
   * below would still be "used" and the mutation would report only a missing property. An annotation
   * makes the type the DERIVED one, which is the type under test.
   */
  const narrative: ServiceNarrativeDocument = {
    id: 1,
    createdAt: '2026-09-18T10:00:00.000Z',
    updatedAt: '2026-09-18T10:00:00.000Z',
    _status: 'published',
    catalogue_service_id: '0198f0a0-0000-7000-8000-000000000001',
    slug: 'deep-tissue',
    headline: 'Deep tissue',
    promise: 'You leave able to turn your head.',
    body: { root: { type: 'root', children: [] } },
    aftercare: null,
    seo_title: null,
    seo_description: null,
    editorial_state: 'live',
  }

  it('has no price to render', () => {
    // @ts-expect-error — price is the catalogue's (B-CAT-03) and is read from it at render time. If this
    // directive is reported unused, a price-shaped field has been added to the content model and the
    // boundary has moved; do not delete the directive, delete the field.
    const leaked: unknown = narrative.price
    expect(leaked).toBeUndefined()
  })

  it('has no duration, bookable flag or VAT rate either', () => {
    // @ts-expect-error — duration is the catalogue's; see the note above.
    const duration: unknown = narrative.duration_minutes
    // @ts-expect-error — bookability is the catalogue's; see the note above.
    const bookable: unknown = narrative.bookable
    // @ts-expect-error — VAT is derived from the catalogue's gross price (ADR 0007); see the note above.
    const vat: unknown = narrative.vat_rate
    expect([duration, bookable, vat]).toEqual([undefined, undefined, undefined])
  })

  it('does have the prose, so the type is not simply empty', () => {
    // The control for the three directives above. A `ServiceNarrativeDocument` that had resolved to
    // `never` or to `{}` would make all of them compile-error-free and all of them pass.
    const headline: string = narrative.headline
    const promise: string = narrative.promise
    expect(headline).toBe('Deep tissue')
    expect(promise).toContain('turn your head')
    expect(SERVICE_NARRATIVE.fields.map((field) => field.name)).toContain('promise')
  })

  it('types a therapist narrative with prose and no name', () => {
    const therapist: TherapistNarrativeDocument = {
      id: 7,
      createdAt: '2026-09-18T10:00:00.000Z',
      updatedAt: '2026-09-18T10:00:00.000Z',
      _status: 'draft',
      therapist_id: '0198f0a0-0000-7000-8000-000000000002',
      approach: 'Firm, unhurried, and honest about what is not actually a knot.',
      narrative: null,
      languages: null,
    }

    // @ts-expect-error — a therapist has no display name until an admin sets one, and it is not set here.
    const named: unknown = therapist.display_name
    expect(named).toBeUndefined()
    expect(therapist.approach).toContain('unhurried')
  })
})
