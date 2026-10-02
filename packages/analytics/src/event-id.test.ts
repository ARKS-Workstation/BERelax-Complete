import { FUNNEL_STAGES } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import {
  analyticsEventCanonicalForm,
  analyticsEventId,
  EVENT_ID_LENGTH,
  EVENT_ID_SEPARATOR,
  ANALYTICS_AGGREGATE_KINDS as KINDS,
} from './event-id.ts'
import { ANALYTICS_AGGREGATE_KINDS } from './index.ts'

/**
 * The shared event identity (A-MEAS-03's first acceptance line).
 *
 * The acceptance line is *"the same booking yields one event_id used by both the client tag and the
 * server push; a test asserts equality and that the id is stable across retries"*. The equality across
 * the two SURFACES is asserted in `packages/fixtures/src/analytics-dispatch.itest.ts`, which computes the
 * id the way a tag loader would and compares it with the one stored on the dispatch row. What is asserted
 * here is the property that makes that possible: the id is a pure function of three declared facts, and
 * nothing else can change it.
 */
const BOOKING = '0193f2c1-0000-7000-8000-000000000001'

describe('the id is derived and therefore stable', () => {
  it('is the same value every time, for the same subject', () => {
    const first = analyticsEventId({ kind: 'booking', aggregateId: BOOKING, stage: 'paid' })
    // "Stable across retries" is this: there is no counter, no clock and no randomness to differ.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(analyticsEventId({ kind: 'booking', aggregateId: BOOKING, stage: 'paid' })).toBe(first)
    }
  })

  it('is 32 lowercase hex characters', () => {
    expect(analyticsEventId({ kind: 'booking', aggregateId: BOOKING, stage: 'paid' })).toMatch(
      new RegExp(`^[0-9a-f]{${EVENT_ID_LENGTH}}$`),
    )
  })

  it('names no aggregate id, which is why it may travel', () => {
    // ADR 0059's whole-payload argument: a business identifier that leaves the building is a join key
    // into our own records for whoever holds it.
    expect(
      analyticsEventId({ kind: 'booking', aggregateId: BOOKING, stage: 'paid' }),
    ).not.toContain(BOOKING)
  })
})

describe('the stage is part of the identity', () => {
  it('gives every funnel stage of one booking a different id', () => {
    const ids = new Set(
      FUNNEL_STAGES.map((stage) =>
        analyticsEventId({ kind: 'booking', aggregateId: BOOKING, stage }),
      ),
    )
    // The failure this refuses: an id over the aggregate alone makes all eight stages one event, so seven
    // are discarded as duplicates and the campaign appears to produce bookings that never got paid.
    expect(ids.size).toBe(FUNNEL_STAGES.length)
  })

  it('gives every aggregate kind of one id a different id', () => {
    const ids = new Set(
      KINDS.map((kind) => analyticsEventId({ kind, aggregateId: BOOKING, stage: 'paid' })),
    )
    // A credit note that shared its invoice's id would deduplicate against the sale it reverses.
    expect(ids.size).toBe(KINDS.length)
  })
})

describe('the separator', () => {
  it('cannot appear in any kind or any stage, in both directions', () => {
    // A separator that can appear inside a field is not a separator: it lets two distinct inputs produce
    // one canonical form, which is one conversion reported instead of two for ever.
    for (const kind of KINDS) expect(kind).not.toContain(EVENT_ID_SEPARATOR)
    for (const stage of FUNNEL_STAGES) expect(stage).not.toContain(EVENT_ID_SEPARATOR)
    // And the control: the separator IS in the canonical form, so a change that dropped it would be
    // caught here rather than by two ids colliding months later.
    expect(
      analyticsEventCanonicalForm({ kind: 'booking', aggregateId: BOOKING, stage: 'paid' }),
    ).toBe(`booking${EVENT_ID_SEPARATOR}${BOOKING}${EVENT_ID_SEPARATOR}paid`)
  })

  it('refuses an aggregate id that contains it', () => {
    expect(() =>
      analyticsEventId({ kind: 'booking', aggregateId: `a${EVENT_ID_SEPARATOR}b`, stage: 'paid' }),
    ).toThrow(/two distinct conversions/)
  })

  it('keeps apart two subjects a bare concatenation would merge', () => {
    // `'book' + 'ing1'` and `'booking' + '1'` are the same string. The canonical form's explicit
    // separators are what stop that, and this is the pair that proves it.
    const a = analyticsEventId({ kind: 'invoice', aggregateId: 'ab', stage: 'paid' })
    const b = analyticsEventId({ kind: 'invoice', aggregateId: 'a', stage: 'paid' })
    expect(a).not.toBe(b)
  })
})

describe('the refusals', () => {
  it('refuses a blank aggregate id rather than hashing one', () => {
    // The digest of a blank id is stable and SHARED, so every conversion in a run whose ids failed to
    // load would be reported as one event — a wrong figure rather than an error.
    expect(() => analyticsEventId({ kind: 'booking', aggregateId: '   ', stage: 'paid' })).toThrow(
      /blank aggregate id/,
    )
  })

  it('refuses a stage this build does not have', () => {
    expect(() =>
      // @ts-expect-error — the point of the case: a stage outside the funnel is refused at runtime too,
      // because the id for it would be stable, unique and about nothing.
      analyticsEventId({ kind: 'booking', aggregateId: BOOKING, stage: 'purchased' }),
    ).toThrow()
  })

  it('refuses an aggregate kind this build does not declare', () => {
    expect(() =>
      // @ts-expect-error — same claim for the other closed vocabulary.
      analyticsEventId({ kind: 'appointment', aggregateId: BOOKING, stage: 'paid' }),
    ).toThrow(/is not one of/)
  })
})

describe('the vocabulary is re-exported rather than restated', () => {
  it('is the same tuple the barrel exports', () => {
    // A second list of kinds would drift; this is the check that holds the barrel and the module equal.
    expect([...ANALYTICS_AGGREGATE_KINDS]).toEqual([...KINDS])
  })
})
