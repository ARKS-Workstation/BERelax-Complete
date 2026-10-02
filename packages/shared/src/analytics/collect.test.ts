import { describe, expect, it } from 'vitest'
import {
  ANALYTICS_BREAKPOINT_BANDS,
  COLLECT_MAX_BATCH_EVENTS,
  COLLECT_MAX_BODY_BYTES,
  COLLECT_PATH,
  COLLECT_REFUSALS,
  collectBatchSchema,
  collectEventSchema,
  DEVICE_KINDS,
  isTradingDateBasis,
  SESSION_INACTIVITY_MS,
  TRADING_DATE_BASES,
} from './collect.ts'

/**
 * The collect wire contract: the caps, the envelope, and what a batch may not contain.
 *
 * The envelope is the boundary between an anonymous internet caller and the measurement store, so every
 * case here is paired with the input it must refuse. A schema asserted only against valid input is a schema
 * nobody has seen say no.
 */

const validEvent = {
  name: 'page_view',
  occurredAt: '2026-09-29T21:00:00.000+04:00',
  clientEventId: 'evt_01ABCdef-',
  payload: { path: '/en/treatments', entry: true },
}

const validBatch = {
  viewportWidth: 390,
  interactionCount: 2,
  interEventGapsMs: [812, 1_409],
  query: '?utm_source=google&utm_medium=cpc',
  referrer: 'https://www.google.com/',
  events: [validEvent],
}

describe('the collect envelope', () => {
  it('accepts a batch the collector would post', () => {
    const parsed = collectBatchSchema.safeParse(validBatch)
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true)
  })

  it('refuses an unknown extra property anywhere, which is the third cap', () => {
    // `strictObject` in both places, and both are asserted: a field the server silently dropped is a field
    // a later unit would believe is stored. The acceptance line names this as a 400 rather than as a
    // tolerated extra.
    expect(collectBatchSchema.safeParse({ ...validBatch, sessionId: 'abc' }).success).toBe(false)
    expect(collectEventSchema.safeParse({ ...validEvent, visitorId: 'abc' }).success).toBe(false)
  })

  it('refuses a batch that names its own session or visitor, because identity is a cookie', () => {
    // The same refusal as above, made explicitly about the two fields somebody would reach for. Identity
    // travels as a cookie: a body field is something the page's own JavaScript composes, and so is
    // something any third-party script on that page could compose too.
    for (const field of ['visitorId', 'sessionId', 'consent', 'bot']) {
      expect(collectBatchSchema.safeParse({ ...validBatch, [field]: 'x' }).success).toBe(false)
    }
  })

  it('refuses more events than the batch cap and accepts exactly the cap', () => {
    const event = (index: number) => ({ ...validEvent, clientEventId: `evt_${index}` })
    const atCap = Array.from({ length: COLLECT_MAX_BATCH_EVENTS }, (_, i) => event(i))
    expect(collectBatchSchema.safeParse({ ...validBatch, events: atCap }).success).toBe(true)
    expect(
      collectBatchSchema.safeParse({ ...validBatch, events: [...atCap, event(99)] }).success,
    ).toBe(false)
    // And an empty batch is refused too: a request carrying no events is a request with nothing to store,
    // and accepting it would spend a rate-limit slot and a transaction on nothing.
    expect(collectBatchSchema.safeParse({ ...validBatch, events: [] }).success).toBe(false)
  })

  it('leaves the event name to the taxonomy, and bounds it so an error message cannot quote a megabyte', () => {
    /*
     * The envelope deliberately does NOT hold the closed name list, and this case is the record of why.
     *
     * It held `analyticsEventNameSchema` first, and `collect.itest.ts` caught the cost: the envelope refused
     * a name outside the taxonomy as `invalid_envelope`, so the route's `unknown_event` refusal became a
     * name nothing could raise — and the answer a tag author needs ("that name is not in the taxonomy, here
     * is the list") was replaced by the one nobody can act on ("your batch is unreadable"). Membership is
     * decided in exactly one place, which is `parseAnalyticsEvent`.
     *
     * So a near miss PASSES here and is refused one layer along, and `whatsapp_ref_shown` — the longest real
     * name — comfortably fits the bound.
     */
    expect(collectEventSchema.safeParse({ ...validEvent, name: 'page_viewed' }).success).toBe(true)
    expect(collectEventSchema.safeParse({ ...validEvent, name: 'constructor' }).success).toBe(true)
    // What the envelope DOES refuse: a name with no characters, and one long enough to make the refusal
    // message that quotes it a denial of service of its own.
    expect(collectEventSchema.safeParse({ ...validEvent, name: '' }).success).toBe(false)
    expect(collectEventSchema.safeParse({ ...validEvent, name: 'x'.repeat(65) }).success).toBe(
      false,
    )
    expect(
      collectEventSchema.safeParse({ ...validEvent, name: 'whatsapp_ref_shown' }).success,
    ).toBe(true)
  })

  it('requires an instant with an offset, so "when" cannot be zone-ambiguous', () => {
    // Trading runs 11:00-02:00, so an instant without an offset can land on either side of a business day
    // boundary depending on who reads it. The pattern is what refuses one; nothing here parses it, because
    // this directory may not mention the clock at all.
    expect(
      collectEventSchema.safeParse({ ...validEvent, occurredAt: '2026-09-29T21:00:00' }).success,
    ).toBe(false)
    expect(
      collectEventSchema.safeParse({ ...validEvent, occurredAt: '2026-09-29T17:00:00Z' }).success,
    ).toBe(true)
    expect(collectEventSchema.safeParse({ ...validEvent, occurredAt: 'yesterday' }).success).toBe(
      false,
    )
  })

  it('bounds the client event id and refuses one that is not URL-safe', () => {
    expect(collectEventSchema.safeParse({ ...validEvent, clientEventId: '' }).success).toBe(false)
    expect(
      collectEventSchema.safeParse({ ...validEvent, clientEventId: 'a'.repeat(65) }).success,
    ).toBe(false)
    // It reaches a UNIQUE index; a value carrying arbitrary bytes would make that index unreadable to
    // anybody looking at a duplicate.
    expect(collectEventSchema.safeParse({ ...validEvent, clientEventId: 'a b' }).success).toBe(
      false,
    )
    expect(
      collectEventSchema.safeParse({ ...validEvent, clientEventId: "'; drop--" }).success,
    ).toBe(false)
  })

  it('takes a null viewport rather than making the field optional', () => {
    // A crawler and a `sendBeacon` from a backgrounded tab both report none, and `null` is a fact the
    // client states. An optional field would make "not told" and "not sent by this version of the
    // collector" the same absence.
    expect(collectBatchSchema.safeParse({ ...validBatch, viewportWidth: null }).success).toBe(true)
    expect(collectBatchSchema.safeParse({ ...validBatch, viewportWidth: 0 }).success).toBe(false)
    expect(collectBatchSchema.safeParse({ ...validBatch, viewportWidth: 390.5 }).success).toBe(
      false,
    )
    const { viewportWidth: _omitted, ...withoutViewport } = validBatch
    expect(collectBatchSchema.safeParse(withoutViewport).success).toBe(false)
  })

  it('bounds the query string and the referrer', () => {
    expect(
      collectBatchSchema.safeParse({ ...validBatch, query: `?q=${'x'.repeat(2100)}` }).success,
    ).toBe(false)
    expect(
      collectBatchSchema.safeParse({ ...validBatch, referrer: `https://x/${'y'.repeat(2100)}` })
        .success,
    ).toBe(false)
  })

  it('states each cap once, and the figures the acceptance list names', () => {
    expect(COLLECT_MAX_BODY_BYTES).toBe(64 * 1024)
    expect(COLLECT_MAX_BATCH_EVENTS).toBe(50)
    expect(SESSION_INACTIVITY_MS).toBe(30 * 60 * 1000)
    expect(COLLECT_PATH).toBe('/api/collect')
  })

  it('names every way it refuses, and each name once', () => {
    expect(new Set(COLLECT_REFUSALS).size).toBe(COLLECT_REFUSALS.length)
    // `rate_limited` is the only 429; the rest are 400. Asserted as membership rather than as a mapping,
    // because the status is the route's to choose and this tuple is the vocabulary.
    expect(COLLECT_REFUSALS).toContain('rate_limited')
    expect(COLLECT_REFUSALS).toContain('unknown_event')
  })
})

describe('the device and breakpoint vocabularies', () => {
  it('holds the four words the database CHECK admits, in one statement', () => {
    expect([...DEVICE_KINDS]).toEqual(['mobile', 'tablet', 'desktop', 'unknown'])
  })

  it('names a band for every width, including below the smallest breakpoint', () => {
    // 360 is a floor and not a target, so a 320px viewport is a real phone that falls below every declared
    // breakpoint and still has to land somewhere named.
    expect(ANALYTICS_BREAKPOINT_BANDS.at(-1)?.name).toBe('base')
    expect(ANALYTICS_BREAKPOINT_BANDS.at(-1)?.minWidth).toBe(0)
  })
})

describe('the trading-date basis vocabulary', () => {
  it('is `trading` plus the resolver’s three reasons, and nothing else', () => {
    expect([...TRADING_DATE_BASES]).toEqual([
      'trading',
      'before_opening',
      'after_closing',
      'premises_closed',
    ])
  })

  it('recognises exactly those four and refuses a near miss', () => {
    for (const basis of TRADING_DATE_BASES) expect(isTradingDateBasis(basis)).toBe(true)
    // The control. `closed` reads like a basis and is not one; a `startsWith` or a substring test would
    // admit it, and the column would then carry a word no reader could interpret.
    expect(isTradingDateBasis('closed')).toBe(false)
    expect(isTradingDateBasis('premises')).toBe(false)
    expect(isTradingDateBasis('')).toBe(false)
  })
})
