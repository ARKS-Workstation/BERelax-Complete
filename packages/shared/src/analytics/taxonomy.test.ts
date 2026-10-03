import { describe, expect, it } from 'vitest'
import {
  ANALYTICS_EVENT_NAMES,
  ANALYTICS_EVENT_SCHEMAS,
  ANALYTICS_OPEN_QUESTIONS,
  ANALYTICS_TAXONOMY_VERSION,
  analyticsEventNameSchema,
  analyticsEventSchemaFor,
  CTA_TARGETS,
  FUNNEL_EXCLUSION_REASONS,
  FUNNEL_STAGES,
  FUNNEL_TERMINAL_STAGE,
  funnelStageRank,
  funnelStagesAfter,
  isAnalyticsEventName,
  isFunnelExclusionReason,
  isFunnelStage,
  isTerminalFunnelStage,
  parseAnalyticsEvent,
  UnknownEventError,
} from './taxonomy.ts'

/**
 * The taxonomy: the name list pinned so a change is a committed diff, the total order whose terminal
 * stage is `paid`, and the runtime refusal of a name nobody defined.
 *
 * Every list here is written out as a literal. That duplication is the mechanism rather than an oversight
 * — it is what makes adding or removing an event, a stage or an exclusion reason show up in a review as
 * two changed lines instead of one — and it is the only duplication of these lists this build permits.
 */

describe('the event name list is pinned', () => {
  it('holds exactly these six names, in this order, at this version', () => {
    expect([...ANALYTICS_EVENT_NAMES]).toEqual([
      'page_view',
      'service_viewed',
      'price_viewed',
      'cta_click',
      'whatsapp_ref_shown',
      // A-MEAS-04's sixth, which is why the version below is 2: raw events are stamped with it and the
      // rollups are kept for ever, so a rollup built before this event existed has to be tellable from
      // one built after.
      'web_vitals',
    ])
    expect(ANALYTICS_TAXONOMY_VERSION).toBe(2)
  })

  it('gives every name a schema, and holds no schema for a name the list does not have', () => {
    // Both directions. A name with no schema is an event nothing validates; a schema with no name is a
    // vocabulary entry no collector can send, and each is invisible from the other side.
    expect(Object.keys(ANALYTICS_EVENT_SCHEMAS).sort()).toEqual([...ANALYTICS_EVENT_NAMES].sort())
    for (const name of ANALYTICS_EVENT_NAMES) {
      expect(analyticsEventSchemaFor(name), name).toBe(ANALYTICS_EVENT_SCHEMAS[name])
    }
    // Non-empty, so the set equality above is not two empty lists agreeing (ADR 0002).
    expect(ANALYTICS_EVENT_NAMES.length).toBeGreaterThan(4)
  })

  it('derives the name enum from the tuple rather than restating it', () => {
    expect(analyticsEventNameSchema.options).toEqual([...ANALYTICS_EVENT_NAMES])
    expect(analyticsEventNameSchema.safeParse('page_view').success).toBe(true)
    expect(analyticsEventNameSchema.safeParse('pageview').success).toBe(false)
  })

  it('recognises every name and refuses a plausible near-miss', () => {
    for (const name of ANALYTICS_EVENT_NAMES) expect(isAnalyticsEventName(name), name).toBe(true)
    for (const near of ['page_views', 'pageView', 'cta_clicked', 'service_view', '']) {
      expect(isAnalyticsEventName(near), near).toBe(false)
    }
  })
})

describe('the funnel is a total order ending at paid', () => {
  it('is exactly the eight stages docs/03 draws, in that order', () => {
    expect([...FUNNEL_STAGES]).toEqual([
      'landing',
      'service_viewed',
      'price_viewed',
      'cta_click',
      'booking_created',
      'confirmed',
      'attended',
      'paid',
    ])
  })

  it('ranks every stage uniquely and strictly increasingly, with no stage unranked', () => {
    const ranks = FUNNEL_STAGES.map((stage) => funnelStageRank(stage))
    expect(ranks).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(new Set(ranks).size).toBe(FUNNEL_STAGES.length)
    // A total order: every pair is comparable and no two stages tie.
    for (const a of FUNNEL_STAGES) {
      for (const b of FUNNEL_STAGES) {
        if (a === b) continue
        expect(funnelStageRank(a) === funnelStageRank(b), `${a} vs ${b}`).toBe(false)
      }
    }
  })

  it('has paid as its terminal stage, with nothing after it', () => {
    expect(FUNNEL_TERMINAL_STAGE).toBe('paid')
    expect(funnelStagesAfter('paid')).toEqual([])
    expect(isTerminalFunnelStage('paid')).toBe(true)
  })

  it('does not treat booking_created as terminal, and names what follows it', () => {
    // The acceptance line, and the reason the last three stages exist: 5-15% of bookings do not turn up,
    // so a funnel terminating at booking_created reports intent and calls it business.
    expect(isTerminalFunnelStage('booking_created')).toBe(false)
    expect(funnelStagesAfter('booking_created')).toEqual(['confirmed', 'attended', 'paid'])
    for (const stage of FUNNEL_STAGES) {
      expect(isTerminalFunnelStage(stage), stage).toBe(stage === 'paid')
    }
  })

  it('derives terminality from the order rather than from a second opinion', () => {
    // The control that makes the four assertions above about the DERIVATION rather than about the word
    // 'paid': every stage's terminality agrees with its rank being the last one.
    for (const stage of FUNNEL_STAGES) {
      expect(isTerminalFunnelStage(stage), stage).toBe(
        funnelStageRank(stage) === FUNNEL_STAGES.length - 1,
      )
    }
  })

  it('recognises every stage and refuses a near-miss spelling', () => {
    for (const stage of FUNNEL_STAGES) expect(isFunnelStage(stage), stage).toBe(true)
    for (const near of ['cta_clicked', 'service_view', 'attend', 'PAID', '']) {
      expect(isFunnelStage(near), near).toBe(false)
    }
  })
})

describe('the exclusion reasons', () => {
  it('are exactly these four, and no_show is one of them', () => {
    expect([...FUNNEL_EXCLUSION_REASONS]).toEqual([
      'no_show',
      'cancelled_by_customer',
      'cancelled_by_salon',
      'rescheduled',
    ])
    for (const reason of FUNNEL_EXCLUSION_REASONS) {
      expect(isFunnelExclusionReason(reason), reason).toBe(true)
    }
    expect(isFunnelExclusionReason('noshow')).toBe(false)
  })

  it('share no member with the stage vocabulary', () => {
    // A word that is both a stage and an exclusion reason would make `funnel_step` ambiguous: a row
    // carrying it in either column would read as the other.
    const overlap = FUNNEL_EXCLUSION_REASONS.filter((reason) => isFunnelStage(reason))
    expect(overlap).toEqual([])
  })
})

describe('an unknown event name is refused by name at runtime', () => {
  it('throws UnknownEventError, carrying the name and the known set', () => {
    // The acceptance line's runtime half. The type-level half cannot be written here — an unknown name
    // does not compile — so gate block 124 asserts `tsc` refuses it.
    expect(() => analyticsEventSchemaFor('conversion')).toThrow(UnknownEventError)
    try {
      analyticsEventSchemaFor('conversion')
      expect.unreachable('analyticsEventSchemaFor accepted a name the taxonomy does not hold')
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownEventError)
      const unknown = error as UnknownEventError
      expect(unknown.name).toBe('UnknownEventError')
      expect(unknown.eventName).toBe('conversion')
      expect(unknown.kind).toBe('validation')
      expect(unknown.details['known']).toEqual(ANALYTICS_EVENT_NAMES)
      // The message names the offending value, so a log line is diagnosable without the details bag.
      expect(unknown.message).toContain('conversion')
    }
  })

  it('refuses every name outside the taxonomy, including ones that look like stages', () => {
    for (const name of ['', 'landing', 'paid', 'page_views', 'PAGE_VIEW']) {
      expect(() => analyticsEventSchemaFor(name), name).toThrow(UnknownEventError)
    }
  })

  it('refuses the names an object inherits, which a registry lookup would have resolved', () => {
    // This caught a real defect on the first run. The registry is an object literal, so indexing it with
    // `constructor` returned `Object` and with `toString` a function — and `/api/collect` is a write path
    // exposed to the internet, so the route answered 500 on a TypeError rather than 422 on a refusal.
    // Membership is now decided by ANALYTICS_EVENT_NAMES, which inherits nothing.
    for (const name of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
      expect(() => analyticsEventSchemaFor(name), name).toThrow(UnknownEventError)
      let threw: unknown
      try {
        parseAnalyticsEvent(name, {})
      } catch (error) {
        threw = error
      }
      expect(threw, name).toBeInstanceOf(UnknownEventError)
    }
  })

  it('and does NOT throw for a name it does hold, which is what makes the refusal a measurement', () => {
    for (const name of ANALYTICS_EVENT_NAMES) {
      expect(() => analyticsEventSchemaFor(name), name).not.toThrow()
    }
  })
})

describe('parseAnalyticsEvent validates the payload as well as the name', () => {
  it('accepts a well-formed event of every name', () => {
    expect(parseAnalyticsEvent('page_view', { path: '/', entry: true })).toEqual({
      name: 'page_view',
      payload: { path: '/', entry: true },
    })
    expect(
      parseAnalyticsEvent('service_viewed', {
        path: '/services/asian-normal-massage',
        style: 'asian',
        treatment: 'normal_massage',
      }).name,
    ).toBe('service_viewed')
    expect(
      parseAnalyticsEvent('price_viewed', {
        path: '/services/arabic-morocco-bath-jacuzzi',
        style: 'arabic',
        treatment: 'morocco_bath_jacuzzi',
      }).name,
    ).toBe('price_viewed')
    expect(parseAnalyticsEvent('cta_click', { target: 'whatsapp', path: '/' }).name).toBe(
      'cta_click',
    )
    expect(parseAnalyticsEvent('whatsapp_ref_shown', { refCode: '7K2Q' }).name).toBe(
      'whatsapp_ref_shown',
    )
  })

  it('refuses a payload that fails its schema, and the refusal is not UnknownEventError', () => {
    // Two different faults with two different answers: an unknown name is a tag nobody deployed, a bad
    // payload is a tag deployed wrongly. Folding them into one refusal loses that.
    const bad = [
      ['page_view', { path: 'services', entry: true }, 'a path that is not site-relative'],
      ['page_view', { path: '/services?utm_source=x', entry: true }, 'a query string'],
      ['page_view', { path: '/' }, 'no entry flag'],
      ['page_view', { path: '/', entry: true, extra: 1 }, 'an unknown field'],
      ['cta_click', { target: 'email', path: '/' }, 'a CTA target nobody offers'],
      ['service_viewed', { path: '/x', style: 'thai', treatment: 'normal_massage' }, 'a style'],
      ['service_viewed', { path: '/x', style: 'asian', treatment: 'deep_tissue' }, 'a treatment'],
      ['whatsapp_ref_shown', { refCode: 'lower' }, 'a ref code outside the pattern'],
    ] as const
    for (const [name, payload, what] of bad) {
      let threw: unknown
      try {
        parseAnalyticsEvent(name, payload)
      } catch (error) {
        threw = error
      }
      expect(threw, `${name} accepted ${what}`).toBeDefined()
      expect(threw, `${name} rejected ${what} as an unknown NAME`).not.toBeInstanceOf(
        UnknownEventError,
      )
    }
  })

  it('takes its CTA targets from the one list docs/03 names', () => {
    expect([...CTA_TARGETS]).toEqual(['whatsapp', 'call', 'book'])
    for (const target of CTA_TARGETS) {
      expect(parseAnalyticsEvent('cta_click', { target, path: '/' }).name, target).toBe('cta_click')
    }
  })
})

describe('the open questions this taxonomy stands on', () => {
  it('names each one by its OPEN-QUESTIONS id and invents no value for it', () => {
    expect(Object.values(ANALYTICS_OPEN_QUESTIONS).sort()).toEqual([
      'Y12-ref-loop',
      'Y5-analytics-basis',
      'Y5-funnel-gap-bucket',
    ])
    // Gate 124 asserts each id is a row in docs/OPEN-QUESTIONS.md; a suite cannot read the file, and an
    // id that names nothing is exactly what that check exists to catch.
    for (const id of Object.values(ANALYTICS_OPEN_QUESTIONS)) {
      expect(id, id).toMatch(/^Y\d+-[a-z-]+$/)
    }
  })
})
