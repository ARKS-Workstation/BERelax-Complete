/**
 * A-MEAS-01 — the enumerating test, and the reason an opaque code is worth having.
 *
 * The acceptance line that decides this unit is *"opaque category codes"*, and a code a reader cannot
 * decode from the wire is only worth having if something proves two things at once: that the mapping onto
 * it is COMPLETE — every catalogue row has one, so nothing falls back to a name — and that no category
 * LEAKS its meaning, in either direction. So every assertion here comes in a pair, and the second half is
 * always the one that could fail:
 *
 *   - the enumeration has a code for every ref, AND every declared code is reached by a ref (a code nothing
 *     maps to is a bucket that stays empty for ever, which is ADR 0046's note on `REACHABLE_FUNNEL_STAGES`);
 *   - a code shares no token with the catalogue's vocabulary, AND the detector that measures that is shown
 *     to fire on a code that does;
 *   - a serialised payload carries no health term, AND the same detector is shown to fire on the input the
 *     payload was projected FROM — which is what proves the projection removed it rather than the generator
 *     never producing one (brief rule 3);
 *   - the closed permitted vocabulary admits every real payload, AND rejects a leaked name.
 *
 * The seeded ROWS are the other half of "every seeded catalogue row", and they are not visible from
 * `packages/core`: `packages/fixtures/src/egress-catalogue.itest.ts` holds `enumerateCatalogueRefs()` equal
 * to `service`, `service_variant`, `price_on_request` and `package_template` in both directions, and checks
 * the codes against the real `internal_name` and `public_display_name` strings. Without it this file would
 * be enumerating its own list, which is ADR 0002's defect.
 */
import {
  CONTRAINDICATION_ESCALATION_FLAG,
  CONTRAINDICATION_FLAG_KEYS,
  FUNNEL_STAGES,
  FUNNEL_TERMINAL_STAGE,
  SERVICE_DURATIONS,
  TREATMENT_KEYS,
  TREATMENT_STYLES,
} from '@berelax/shared'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  CATEGORY_CODE_BY_REF,
  type CatalogueRef,
  catalogueRefKey,
  catalogueVocabulary,
  categoryCodeFor,
  EGRESS_CATEGORY_CODE_PATTERN,
  EGRESS_CATEGORY_CODES,
  enumerateCatalogueRefs,
  PRICE_ON_REQUEST_FOOTPRINTS,
} from './category-codes.ts'
import {
  buildEgressPayload,
  EGRESS_CURRENCY,
  EGRESS_EVENT_TYPES,
  EGRESS_PAYLOAD_FIELDS,
  type EgressEventType,
  egressPermittedVocabulary,
  egressTokensOf,
  HEALTH_TERM_LEXICON,
  healthTermsIn,
  serialiseEgressPayload,
  unpermittedEgressTokens,
} from './egress-guard.ts'

/** 8 services, 32 variants, 3 quoted footprints, 1 bundle category. Written out, so a drift is visible. */
const EXPECTED_REF_COUNT =
  TREATMENT_STYLES.length * TREATMENT_KEYS.length +
  TREATMENT_STYLES.length * TREATMENT_KEYS.length * SERVICE_DURATIONS.length +
  PRICE_ON_REQUEST_FOOTPRINTS.length +
  1

const REFS = enumerateCatalogueRefs()

describe('the enumeration and the mapping', () => {
  it('enumerates every catalogue row exactly once, and the count is the cross product', () => {
    expect(REFS).toHaveLength(EXPECTED_REF_COUNT)
    expect(EXPECTED_REF_COUNT).toBe(44)
    // Distinct keys. Two refs with one key would make the totality assertion below pass while one of the
    // two categories was never addressable.
    const keys = REFS.map(catalogueRefKey)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('has a code for every ref — an unmapped row is a failure here and a type error in tsc', () => {
    for (const ref of REFS) {
      const code = categoryCodeFor(ref)
      expect(
        code,
        `${catalogueRefKey(ref)} has no category code, so a dispatcher would have nothing opaque to ` +
          'send for it',
      ).toBeDefined()
      expect(EGRESS_CATEGORY_CODES as readonly string[]).toContain(code)
    }
  })

  it('reaches every declared code — the other direction, so a code cannot be a bucket nothing fills', () => {
    const reached = new Set(REFS.map((ref) => categoryCodeFor(ref)))
    expect([...reached].sort()).toEqual([...EGRESS_CATEGORY_CODES].sort())
  })

  it('assigns each code to exactly one ref', () => {
    const codes = REFS.map((ref) => categoryCodeFor(ref))
    // Injectivity. Two categories sharing a code merge two conversion streams into one, and the symptom is
    // a category that appears never to convert while another over-reports.
    expect(new Set(codes).size).toBe(codes.length)
    expect(Object.keys(CATEGORY_CODE_BY_REF)).toHaveLength(EXPECTED_REF_COUNT)
  })

  it('every code matches the committed shape', () => {
    for (const code of EGRESS_CATEGORY_CODES) {
      expect(code, `${code} is not ${EGRESS_CATEGORY_CODE_PATTERN.source}`).toMatch(
        EGRESS_CATEGORY_CODE_PATTERN,
      )
    }
    // The control: the pattern has to be able to REFUSE. A regex that accepted everything would make the
    // loop above a formality, which is how a shape check quietly stops being one.
    for (const refused of ['svc_01', 'SVC_1', 'SVC01', 'Normal Massage', 'SVC_']) {
      expect(refused).not.toMatch(EGRESS_CATEGORY_CODE_PATTERN)
    }
    // And the fact that makes the opacity assertions below a SEPARATE mechanism rather than a restatement
    // of this one: `MASSAGE_01` satisfies the shape perfectly. A pattern says a code carries no lower case
    // and ends in digits; it cannot say the letters mean nothing. The first version of this control listed
    // `MASSAGE_01` as something the pattern should refuse, and was wrong.
    expect('MASSAGE_01').toMatch(EGRESS_CATEGORY_CODE_PATTERN)
  })
})

describe('opacity', () => {
  const vocabulary = catalogueVocabulary()

  it('the vocabulary it is measured against is the catalogue’s own words', () => {
    // Derived from the shared enums, so a renamed treatment key moves it. Asserted because an EMPTY
    // vocabulary would make every overlap assertion below pass over nothing (ADR 0002).
    expect(vocabulary.length).toBeGreaterThanOrEqual(12)
    for (const word of ['asian', 'arabic', 'massage', 'morocco', 'jacuzzi', 'shaving', 'balm']) {
      expect(vocabulary).toContain(word)
    }
  })

  it('no code shares a token with the catalogue vocabulary', () => {
    const words = new Set(vocabulary)
    for (const ref of REFS) {
      const code = categoryCodeFor(ref)
      const overlap = egressTokensOf(code).filter((token) => words.has(token))
      expect(
        overlap,
        `${code} (for ${catalogueRefKey(ref)}) shares ${overlap.join(', ')} with the catalogue’s own ` +
          'words, so a reader of the wire can decode it',
      ).toEqual([])
    }
  })

  it('the overlap detector fires on a code that is not opaque', () => {
    // The control, and the assertion above is worth nothing without it: if `egressTokensOf` stopped
    // splitting, or the vocabulary came back empty, every code would read as opaque.
    const words = new Set(vocabulary)
    for (const readable of ['MASSAGE_01', 'ASIAN_02', 'JACUZZI_03']) {
      const overlap = egressTokensOf(readable).filter((token) => words.has(token))
      expect(overlap.length).toBeGreaterThan(0)
    }
  })
})

describe('the health-term lexicon', () => {
  it('flags every term the acceptance line names', () => {
    for (const phrase of [
      'prenatal massage',
      'pregnancy',
      'the customer is pregnant',
      'acute injury',
      'lower back pain',
      'type 2 diabetes',
      'high blood pressure',
      'lymphatic drainage',
      'on blood thinners',
      'recent surgery',
    ]) {
      expect(healthTermsIn(phrase), `"${phrase}" carries no health term`).not.toEqual([])
    }
  })

  it('flags nothing a real payload can contain — the direction that decides whether it can exist', () => {
    // The `readFileSync` lesson from M-VAT-09 (ADR 0052): a gate that fires on legitimate content is a gate
    // somebody switches off rather than fixes. Every token below appears in a payload this guard builds, or
    // in the catalogue words the codes stand in for.
    for (const token of [
      ...EGRESS_PAYLOAD_FIELDS,
      ...FUNNEL_STAGES,
      ...EGRESS_CATEGORY_CODES,
      EGRESS_CURRENCY,
      ...catalogueVocabulary(),
      'paid',
      'attended',
      'quantity',
      'cardholder',
      'painting',
    ]) {
      expect(
        healthTermsIn(token),
        `the lexicon flags "${token}", which is legitimate content`,
      ).toEqual([])
    }
  })

  it('covers every contraindication flag key that names a condition', () => {
    // The lexicon must not fall behind `@berelax/shared`'s clinical enum — a ninth flag key naming a
    // condition no stem here covers is a health term with nothing refusing it.
    for (const key of CONTRAINDICATION_FLAG_KEYS) {
      if (key === CONTRAINDICATION_ESCALATION_FLAG) continue
      expect(healthTermsIn(key), `no stem covers the contraindication flag "${key}"`).not.toEqual(
        [],
      )
    }
    // And the one exclusion, asserted rather than assumed: `requires_consultation` names no condition, so a
    // lexicon that grew a `requires` or `consultation` stem would be flagging a routing decision as a
    // disclosure — and this is what would say so.
    expect(healthTermsIn(CONTRAINDICATION_ESCALATION_FLAG)).toEqual([])
  })

  it('is committed and non-trivial', () => {
    expect(HEALTH_TERM_LEXICON.length).toBeGreaterThanOrEqual(40)
    expect(new Set(HEALTH_TERM_LEXICON).size).toBe(HEALTH_TERM_LEXICON.length)
  })
})

describe('the payload allowlist', () => {
  /**
   * The terminal stage, as a literal, held equal to the derived constant by the first case below.
   *
   * `FUNNEL_TERMINAL_STAGE` is typed `FunnelStage | undefined`: `noUncheckedIndexedAccess` is on and its
   * index is computed, so ADR 0046's "typed `'paid'`" is one compiler flag optimistic. That matters here
   * rather than being a typing nuisance — the guard's value rule compares `subject.eventType` against it, so
   * an `undefined` would make NO stage terminal and drop every conversion figure. Fail-closed, and silent.
   */
  const TERMINAL = 'paid' as const satisfies EgressEventType

  it('the constant the guard compares against is the funnel’s last stage', () => {
    expect(FUNNEL_TERMINAL_STAGE).toBe(TERMINAL)
    expect(FUNNEL_TERMINAL_STAGE).not.toBeUndefined()
  })

  const ref: CatalogueRef = {
    kind: 'variant',
    style: 'asian',
    treatmentKey: 'normal_massage',
    durationMinutes: 60,
  }

  it('carries the allowlisted fields and nothing else', () => {
    const { payload, dropped } = buildEgressPayload({
      ref,
      eventType: 'service_viewed',
      quantity: 1,
    })
    expect(Object.keys(payload)).toEqual(['eventType', 'categoryCode', 'quantity'])
    expect(dropped).toEqual([])
  })

  it('drops a rogue field and counts the drop', () => {
    // The test that "adds one": the realistic shape is a dispatcher handing the adapter the row it read.
    const { payload, dropped } = buildEgressPayload(
      { ref, eventType: 'cta_click', quantity: 1 },
      {
        internalName: 'Asian Normal Massage',
        publicDisplayName: 'Normal Massage (Asian)',
        intakeNotes: 'prenatal, on blood thinners',
      },
    )
    expect(Object.keys(payload)).toEqual(['eventType', 'categoryCode', 'quantity'])
    expect(dropped.map((entry) => entry.field).sort()).toEqual([
      'intakeNotes',
      'internalName',
      'publicDisplayName',
    ])
    expect(dropped.every((entry) => entry.reason === 'not_allowlisted')).toBe(true)
    // Counted, not merely absent: a projection that drops silently cannot be told from one that was never
    // handed the field, and the second is routine while the first is an incident.
    expect(dropped).toHaveLength(3)
  })

  it('drops an allowlisted field arriving from anywhere but the subject', () => {
    // A `carried.categoryCode` is a second assignment nothing holds equal to the table, so it is dropped
    // like any other key rather than winning.
    const { payload, dropped } = buildEgressPayload(
      { ref, eventType: 'service_viewed', quantity: 2 },
      { categoryCode: 'SVC_99', quantity: 999 },
    )
    expect(payload.categoryCode).toBe(categoryCodeFor(ref))
    expect(payload.quantity).toBe(2)
    expect(dropped.map((entry) => entry.field).sort()).toEqual(['categoryCode', 'quantity'])
  })

  it('carries a figure for the terminal stage and refuses one anywhere else', () => {
    const conversion = buildEgressPayload({
      ref,
      eventType: TERMINAL,
      quantity: 1,
      valueFils: 25000,
    })
    expect(conversion.payload.valueFils).toBe(25000)
    expect(conversion.payload.currency).toBe(EGRESS_CURRENCY)
    expect(conversion.dropped).toEqual([])

    // Every other stage. A figure on `price_viewed` is one row of the code mapping, in public — and a few
    // hundred of them are the menu, which would undo every opaque code in the table.
    for (const eventType of EGRESS_EVENT_TYPES) {
      if (eventType === TERMINAL) continue
      const { payload, dropped } = buildEgressPayload({
        ref,
        eventType,
        quantity: 1,
        valueFils: 25000,
      })
      expect(payload.valueFils).toBeUndefined()
      expect(payload.currency).toBeUndefined()
      expect(dropped).toEqual([{ field: 'valueFils', reason: 'value_outside_the_terminal_stage' }])
    }
  })

  it('serialises in allowlist order, with no brand on the wire', () => {
    const { payload } = buildEgressPayload({
      ref,
      eventType: TERMINAL,
      quantity: 1,
      valueFils: 25000,
    })
    expect(serialiseEgressPayload(payload)).toBe(
      '{"eventType":"paid","categoryCode":"SVV_02","quantity":1,"valueFils":25000,"currency":"AED"}',
    )
    // The brand is phantom, so it cannot reach the wire. A string tag would have been a field the
    // allowlist never approved and an object a caller could forge.
    expect(JSON.stringify(payload)).not.toContain('brand')
  })
})

describe('nothing but the permitted vocabulary leaves', () => {
  it('holds for every catalogue row × every dispatchable event type', () => {
    // Exhaustive rather than sampled: 44 × 8 is small, and the acceptance line says every service × every
    // dispatchable event type. The claim is the STRONG one — not "no health term appears", which also holds
    // for a payload that leaked a service name instead, but "nothing appears except the closed set".
    let checked = 0
    for (const ref of REFS) {
      for (const eventType of EGRESS_EVENT_TYPES) {
        const { payload } = buildEgressPayload({ ref, eventType, quantity: 1, valueFils: 25000 })
        const serialised = serialiseEgressPayload(payload)
        expect(healthTermsIn(serialised)).toEqual([])
        expect(
          unpermittedEgressTokens(serialised),
          `${catalogueRefKey(ref)} at ${eventType} serialised something outside the closed vocabulary`,
        ).toEqual([])
        checked += 1
      }
    }
    expect(checked).toBe(EXPECTED_REF_COUNT * EGRESS_EVENT_TYPES.length)
    expect(checked).toBe(352)
  })

  it('the vocabulary detector refuses a leaked name and a leaked health term', () => {
    // The control for the loop above, and it is the assertion that makes it mean something: if
    // `unpermittedEgressTokens` came back empty for everything, 352 passing cases would prove nothing.
    expect(
      unpermittedEgressTokens('{"eventType":"paid","service":"Arabic Hot Oil / Balm Massage"}'),
    ).toEqual(expect.arrayContaining(['arabic', 'hot', 'oil', 'balm', 'massage']))
    expect(unpermittedEgressTokens('{"notes":"prenatal"}')).toContain('prenatal')
    expect(healthTermsIn('{"notes":"prenatal"}')).toContain('prenatal')
    // And a part-digit, part-letter token is refused, because that is the shape a smuggled identifier takes
    // while looking like one of ours.
    expect(unpermittedEgressTokens('{"categoryCode":"svv11"}')).toContain('svv11')
  })

  it('survives whatever a dispatcher was holding', () => {
    // The generator carries the things a real dispatcher has in scope: the catalogue row it read and an
    // intake answer. The property is that none of it reaches the wire; the COUNT below is what proves the
    // generator was producing inputs that could have (brief rule 22).
    const rogueKeys = [
      'internalName',
      'publicDisplayName',
      'menuLabel',
      'templateKey',
      'intakeNotes',
      'contraindications',
      'customerName',
    ]
    const catalogueWords = catalogueVocabulary()
    const rogueValues = [
      'Arabic Hot Oil / Balm Massage',
      'Normal Massage (Asian)',
      'Four Hands Massage',
      'prenatal massage requested',
      'lower back pain, on blood thinners',
      'diabetes and high blood pressure',
      'lymphatic drainage',
      'fixture_package_untouched',
      '',
    ]

    let generated = 0
    /**
     * How many generated cases carried something the projection actually had to REMOVE, counted over the
     * `carried` bag alone.
     *
     * Over the whole pre-projection input it would be 400 of 400 by construction — a `ref` serialises its
     * own style and treatment key — and a count pinned at the maximum by something other than the generator
     * is blind to the generator drifting, which is the failure brief rule 22 is about wearing a different
     * hat. So the two things the rogue VALUES contribute are counted separately.
     */
    let carriedHealthTerm = 0
    let carriedCatalogueName = 0
    fc.assert(
      fc.property(
        fc.constantFrom(...REFS),
        fc.constantFrom(...EGRESS_EVENT_TYPES),
        fc.integer({ min: 1, max: 4 }),
        fc.option(fc.integer({ min: 1, max: 500_000 }), { nil: undefined }),
        fc.dictionary(fc.constantFrom(...rogueKeys), fc.constantFrom(...rogueValues), {
          minKeys: 1,
          maxKeys: 4,
        }),
        (ref, eventType, quantity, valueFils, carried) => {
          generated += 1
          const bag = JSON.stringify(carried)
          if (healthTermsIn(bag).length > 0) carriedHealthTerm += 1
          if (catalogueWords.some((word) => egressTokensOf(bag).includes(word))) {
            carriedCatalogueName += 1
          }

          const { payload, dropped } = buildEgressPayload(
            { ref, eventType, quantity, valueFils },
            carried,
          )
          const serialised = serialiseEgressPayload(payload)
          expect(healthTermsIn(serialised)).toEqual([])
          expect(unpermittedEgressTokens(serialised)).toEqual([])
          // Every carried key is accounted for, so "nothing leaked" cannot be satisfied by a builder that
          // quietly returned an empty payload.
          for (const key of Object.keys(carried)) {
            expect(dropped.some((entry) => entry.field === key)).toBe(true)
          }
          expect(Object.keys(payload)).toContain('categoryCode')
        },
      ),
      { numRuns: 400 },
    )

    expect(generated).toBe(400)
    // MEASURED, not assumed, and over the `carried` bag alone so the numbers track the generator.
    // Eight runs of this file gave 301-315 health-bearing cases (mean 308) and 270-302 catalogue-name cases
    // (mean 288) out of 400. Four of the nine rogue values carry a health term and four carry a catalogue
    // name, over one to four keys, so ~0.77 and ~0.72 are the expected rates and one standard deviation is
    // about nine cases. The floors sit nine to ten standard deviations below the means rather than just
    // under the observed minima — a floor set at 300 would become its own flake (brief rule 22) — while a
    // generator that had stopped producing rogue data would give nearly zero.
    expect(
      carriedHealthTerm,
      `only ${carriedHealthTerm} of 400 generated inputs carried a health term, so this property mostly ` +
        'proved that a payload with nothing to remove has nothing removed. The generator has drifted — ' +
        'see rogueValues.',
    ).toBeGreaterThanOrEqual(220)
    expect(
      carriedCatalogueName,
      `only ${carriedCatalogueName} of 400 generated inputs carried a catalogue name, so the commercial ` +
        'half of the claim was barely exercised. The generator has drifted — see rogueValues.',
    ).toBeGreaterThanOrEqual(200)
    // Explicit, because the default is 5,000 ms and 400 property cases each doing two lexicon scans, under
    // coverage on a loaded machine, is a correctness test with a performance budget hidden in it (rule 21).
  }, 30_000)
})

describe('the event types are the funnel’s, derived', () => {
  it('is the funnel tuple itself and not a copy of it', () => {
    expect(EGRESS_EVENT_TYPES).toBe(FUNNEL_STAGES)
    expect([...EGRESS_EVENT_TYPES]).toEqual([...FUNNEL_STAGES])
    // The terminal stage is read from the tuple, so the value rule moves with a ninth stage rather than
    // staying pinned to the word `paid`.
    expect(FUNNEL_TERMINAL_STAGE).toBe(FUNNEL_STAGES[FUNNEL_STAGES.length - 1])
  })

  it('the permitted vocabulary covers the allowlist, the codes and the event types', () => {
    const permitted = new Set(egressPermittedVocabulary())
    for (const source of [
      ...EGRESS_PAYLOAD_FIELDS,
      ...EGRESS_CATEGORY_CODES,
      ...EGRESS_EVENT_TYPES,
    ]) {
      for (const token of egressTokensOf(source)) {
        expect(permitted, `${token} (from ${source}) is not in the permitted vocabulary`).toContain(
          token,
        )
      }
    }
  })
})
