import { ANALYTICS_EVENT_NAMES, ANALYTICS_EVENT_SCHEMAS } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import {
  COLLECTOR_SUPPLIED_PAYLOAD_FIELDS,
  DECLARED_EVENT_PAGE_FIELDS,
  declaredPayloadAttributes,
  declaredPayloadFields,
  INTERACTION_DEDUPE_MS,
  payloadFieldForAttribute,
  TRACK_ATTRIBUTE_PREFIX,
  TRACK_EVENT_ATTRIBUTE,
  TRACK_REFUSALS,
  trackPayloadAttribute,
} from './attributes.ts'

/**
 * The attribute vocabulary, held equal to the taxonomy in both directions.
 *
 * `attributes.ts` imports nothing — that is the whole point of it, and `pnpm budgets` is what made it so
 * (98,927 bytes of `zod` in the client bundle against a 3,072-byte budget). The consequence is that the
 * module cannot look an event's fields up for itself: {@link declaredPayloadFields} takes the SHAPE as an
 * argument, and the two callers that have one are `scripts/check-event-attributes.mjs` and this file.
 *
 * So this is where the equality lives. A test is never bundled, so it may import the taxonomy freely — and
 * every assertion below is written against `ANALYTICS_EVENT_NAMES` rather than against five literal names,
 * which means a sixth event added to A-FIRST-02's registry is covered on the day it lands.
 */

/** `ANALYTICS_EVENT_SCHEMAS[name].shape`, narrowed once, the same way the checker narrows it. */
const shapeOf = (name: (typeof ANALYTICS_EVENT_NAMES)[number]): Readonly<Record<string, unknown>> =>
  (ANALYTICS_EVENT_SCHEMAS[name] as unknown as { shape: Readonly<Record<string, unknown>> }).shape

describe('the declared attribute vocabulary', () => {
  it('kebab-cases a camelCase field and reads it back, for every field in the taxonomy', () => {
    let fields = 0
    for (const name of ANALYTICS_EVENT_NAMES) {
      for (const field of declaredPayloadFields(shapeOf(name))) {
        fields += 1
        const attribute = trackPayloadAttribute(field)
        expect(attribute.startsWith(TRACK_ATTRIBUTE_PREFIX), attribute).toBe(true)
        expect(attribute).toBe(attribute.toLowerCase())
        expect(payloadFieldForAttribute(attribute), attribute).toBe(field)
      }
    }
    // The control. A derivation that answered the empty set would pass the loop above having checked
    // nothing, which is how a universal claim over a derived set becomes decoration.
    expect(fields, 'no event in the taxonomy declared a payload field').toBeGreaterThanOrEqual(4)
  })

  it('round-trips the one camelCase field there is, which makes the kebab rule load-bearing', () => {
    // `refCode` is the only payload field whose name is not already one lower-case word, so it is the only
    // one that can tell `data-berelax-ref-code` from `data-berelax-refcode`. Named explicitly because a
    // loop over the taxonomy would still pass if this field were removed and the conversion broken.
    expect(trackPayloadAttribute('refCode')).toBe(`${TRACK_ATTRIBUTE_PREFIX}ref-code`)
    expect(payloadFieldForAttribute(`${TRACK_ATTRIBUTE_PREFIX}ref-code`)).toBe('refCode')
    // And the derivation really is reading the taxonomy: that attribute is `whatsapp_ref_shown`'s.
    expect(declaredPayloadAttributes(shapeOf('whatsapp_ref_shown'))).toEqual([
      `${TRACK_ATTRIBUTE_PREFIX}ref-code`,
    ])
  })

  it('never asks an element for a field the collector supplies, in both directions', () => {
    const everyField = new Set(ANALYTICS_EVENT_NAMES.flatMap((name) => Object.keys(shapeOf(name))))
    for (const name of ANALYTICS_EVENT_NAMES) {
      for (const supplied of COLLECTOR_SUPPLIED_PAYLOAD_FIELDS) {
        expect(declaredPayloadFields(shapeOf(name)), `${name}/${supplied}`).not.toContain(supplied)
      }
    }
    // The other direction, and it is the one that rots: a field named here that no event has is an
    // exemption pointed at nothing, which would quietly stop the checker requiring a real attribute the
    // day the taxonomy renamed one.
    for (const supplied of COLLECTOR_SUPPLIED_PAYLOAD_FIELDS) {
      expect(everyField, `${supplied} is supplied and is no event's field`).toContain(supplied)
    }
    // And `page_view` has nothing BUT supplied fields, so its declared set is empty — which is why a page
    // view is not something an element can declare.
    expect(declaredPayloadFields(shapeOf('page_view'))).toEqual([])
    expect(declaredPayloadAttributes(shapeOf('cta_click'))).toEqual([
      `${TRACK_ATTRIBUTE_PREFIX}target`,
    ])
  })

  it('reads nothing out of the event attribute itself or out of a foreign attribute', () => {
    expect(payloadFieldForAttribute(TRACK_EVENT_ATTRIBUTE)).toBeNull()
    expect(payloadFieldForAttribute('data-testid')).toBeNull()
    expect(payloadFieldForAttribute(TRACK_ATTRIBUTE_PREFIX)).toBeNull()
    // The control: an attribute that IS one of ours resolves, so the three nulls above are not satisfied
    // by a function that answers null for everything.
    expect(payloadFieldForAttribute(`${TRACK_ATTRIBUTE_PREFIX}target`)).toBe('target')
  })

  it('adds only a field every declarable event accepts, and says which events those are', () => {
    /*
     * The one rule a browser-side validator would have caught and this design has to state instead.
     *
     * Every payload schema is a `strictObject`, so a field the schema does not have is an unknown extra
     * property and `/api/collect` refuses the whole event. The collector adds
     * `DECLARED_EVENT_PAGE_FIELDS` to every declared interaction, so an event whose schema lacks one of
     * them is not declarable at all — which is exactly `whatsapp_ref_shown`, and it was declared on a
     * button until the browser suite parsed the batch through the server's own envelope and refused it.
     */
    expect([...DECLARED_EVENT_PAGE_FIELDS]).toEqual(['path'])
    for (const field of DECLARED_EVENT_PAGE_FIELDS) {
      expect(COLLECTOR_SUPPLIED_PAYLOAD_FIELDS, field).toContain(field)
    }
    const declarable = ANALYTICS_EVENT_NAMES.filter((name) =>
      DECLARED_EVENT_PAGE_FIELDS.every((field) => field in shapeOf(name)),
    )
    /*
      Both directions, enumerated: `page_view` is declarable by this rule and is excluded by having no
      payload field of its own; `whatsapp_ref_shown` is the one the rule excludes.

      `web_vitals` (A-MEAS-04) is admitted by this rule and is excluded by the OTHER one, which is worth
      stating because the two are easy to confuse. It carries `path`, so the page-field rule has nothing
      against it — but its own schema has six fields the collector does not supply (`metric`, `value`,
      `breakpoint`, `locale`, `direction`, `identity`), so `scripts/check-event-attributes.mjs` requires
      six `data-track-*` attributes on any element declaring it and refuses a partial declaration by name.
      Nothing in this build declares it: it is produced by a `PerformanceObserver` through the collector's
      imperative door, which is the same door `whatsapp_ref_shown` uses for the same reason — the event
      is not a thing anybody clicked.
    */
    expect([...declarable].sort()).toEqual(
      ['cta_click', 'page_view', 'price_viewed', 'service_viewed', 'web_vitals'].sort(),
    )
    expect(declarable).not.toContain('whatsapp_ref_shown')
    // And the field count that is the real exclusion, so the sentence above is a claim rather than prose.
    expect(declaredPayloadFields(shapeOf('web_vitals')).length).toBeGreaterThanOrEqual(6)
  })

  it('states the double-fire window as the acceptance lines figure and nothing else', () => {
    expect(INTERACTION_DEDUPE_MS).toBe(300)
  })

  it('names only the refusals the COLLECTOR can raise', () => {
    // The server's refusals are not restated here: `unknown_event` and `invalid_event_payload` are
    // `/api/collect`'s, and a browser-side copy would be the second statement of a judgement shipped to a
    // cache. A refusal nothing in this package can raise is the defect A-FIRST-05 reported in its own
    // first draft one layer up.
    expect([...TRACK_REFUSALS]).toEqual(['duplicate_interaction', 'queue_full'])
  })
})
