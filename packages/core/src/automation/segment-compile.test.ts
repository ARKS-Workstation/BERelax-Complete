import { describe, expect, it } from 'vitest'
import type { Instant } from '../time.ts'
import {
  compileSegment,
  SEGMENT_ATTRIBUTES,
  SEGMENT_COUNT_STALENESS_SECONDS,
  SEGMENT_MAX_TERMS,
  SEGMENT_PERMITTED_SCHEMAS,
  type SegmentDefinition,
  type SegmentRefusal,
  type SegmentRule,
  segmentCountFreshness,
  segmentRegistryFaults,
  serialiseSegmentDefinition,
  validateSegmentDefinition,
} from './segment-compile.ts'

/**
 * C-AUTO-10's segment compiler.
 *
 * Every case here is paired with a control that must fail, because that is the only way an assertion
 * about a refusal is worth anything: "the clinical reference is refused" passes against a compiler that
 * refuses everything, and "the lifecycle segment compiles" passes against one that refuses nothing.
 */

const ruleOf = (refusals: readonly SegmentRefusal[]): readonly SegmentRule[] =>
  refusals.map((refusal) => refusal.rule)

const lapsedVips: SegmentDefinition = {
  segmentKey: 'lapsed_vips',
  title: 'Lapsed VIPs',
  match: 'all',
  terms: [
    { attribute: 'customer.lifecycle_state', operator: 'in', value: ['lapsing', 'lapsed'] },
    { attribute: 'customer.is_vip', operator: 'equals', value: true },
  ],
}

describe('compileSegment', () => {
  it('compiles one parameterised query, with every value bound and none spliced', () => {
    const compiled = compileSegment(lapsedVips)
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return

    // One statement. The acceptance line's "one parameterised SQL query" is the claim, so the control is
    // that the text contains exactly one `select` of its own at the top level.
    expect(compiled.rows.text.match(/\bfrom customer c\b/g)).toHaveLength(1)
    expect(compiled.rows.values).toEqual([['lapsing', 'lapsed'], true])
    // Parameterised, which is the half a reader cannot take on trust: no value appears in the text.
    expect(compiled.rows.text).not.toContain('lapsing')
    expect(compiled.rows.text).not.toContain('true')
    expect(compiled.rows.text).toContain('$1')
    expect(compiled.rows.text).toContain('$2')
  })

  it('counts the same set it enumerates, from the same compilation', () => {
    const compiled = compileSegment(lapsedVips)
    if (!compiled.ok) throw new Error('fixture segment must compile')
    // The count wraps the rows query rather than restating its WHERE. A separately written count is the
    // shape that drifts, and the acceptance line asserts the cached count equals a live recount.
    expect(compiled.count.text).toContain(compiled.rows.text)
    expect(compiled.count.values).toEqual(compiled.rows.values)
  })

  it('never emits the visit aggregate for a segment that does not ask about visits', () => {
    const compiled = compileSegment(lapsedVips)
    if (!compiled.ok) throw new Error('fixture segment must compile')
    expect(compiled.rows.text).not.toContain('appointment')

    // The control: a segment that DOES ask gets it, so the absence above is a derivation rather than a
    // feature that never works.
    const withVisits = compileSegment({
      segmentKey: 'quiet_since_spring',
      title: 'Quiet since spring',
      match: 'all',
      terms: [
        {
          attribute: 'appointment.last_completed_trading_date',
          operator: 'on_or_before',
          value: '2026-04-01',
        },
      ],
    })
    if (!withVisits.ok) throw new Error('the visit segment must compile')
    expect(withVisits.rows.text).toContain('from appointment a')
    expect(withVisits.rows.text).toContain("a.status = 'completed'")
  })

  it('excludes an erased contact, and the exclusion is not a term an author can remove', () => {
    const compiled = compileSegment(lapsedVips)
    if (!compiled.ok) throw new Error('fixture segment must compile')
    expect(compiled.rows.text).toContain('c.erased_at is null')
  })
})

describe('a segment may not read the clinical schema', () => {
  it('refuses a reference into the clinical schema BY NAME, naming the schema', () => {
    const refusals = validateSegmentDefinition({
      segmentKey: 'probe_clinical',
      title: 'Contacts with a flag set',
      match: 'all',
      terms: [
        {
          attribute: 'clinical.contraindication_flag.flag_key',
          operator: 'equals',
          value: 'pregnancy',
        },
      ],
    })
    // `toBe` on the rule rather than `toContain` over the list, so a failure prints BOTH rule names in
    // full. A `toContain` diff abbreviates the expected string, and a gate case asserting rejection BY
    // NAME (ADR 0003) then cannot find the name in the output it is given.
    expect(refusals[0]?.rule).toBe('segment-attribute-outside-the-permitted-schemas')
    // The message has to name the schema, not merely refuse: the refusal a reader needs is the one that
    // says what they asked for, because "unknown attribute" about a reference whose problem is that it
    // IS known sends them looking for a typo.
    expect(refusals[0]?.detail).toContain('clinical')
    // And it must not be reported as merely unknown, which is the weaker answer and the one the
    // registry lookup would give if the schema check ran second.
    expect(ruleOf(refusals)).not.toContain('segment-unknown-attribute')
  })

  it('refuses to compile it at all, so no query reaches a caller', () => {
    const compiled = compileSegment({
      segmentKey: 'probe_clinical',
      title: 'Contacts with a flag set',
      match: 'all',
      terms: [{ attribute: 'clinical.intake_submission.answers', operator: 'is_not_null' }],
    })
    expect(compiled.ok).toBe(false)
  })

  it('refuses a clinical table spelled without its schema too — the registry is a closed set', () => {
    const refusals = validateSegmentDefinition({
      segmentKey: 'probe_clinical_bare',
      title: 'Contacts with a note',
      match: 'all',
      terms: [{ attribute: 'treatment_note.body', operator: 'is_not_null' }],
    })
    expect(ruleOf(refusals)).toContain('segment-unknown-attribute')
  })

  it('holds the REGISTRY to the permitted schemas, which the term rules cannot', () => {
    // The committed registry is clean. That is the control, and on its own it proves nothing.
    expect(segmentRegistryFaults()).toEqual([])

    // The direction the term rules cannot see: an ENTRY pointing outside the permitted schemas. Every
    // refusal above would still pass with this entry in place, and the compiler would emit a join into
    // the clinical schema for a definition that named it by a perfectly ordinary two-part reference.
    const faults = segmentRegistryFaults({
      ...SEGMENT_ATTRIBUTES,
      'contraindication_flag.flag_key': {
        schema: 'clinical',
        table: 'contraindication_flag',
        column: 'flag_key',
        type: 'text',
        operators: ['equals'],
        sqlExpression: 'f.flag_key',
        requiresVisitAggregate: false,
        label: 'Contraindication flag',
      },
    })
    expect(ruleOf(faults)).toEqual(['segment-registry-entry-outside-the-permitted-schemas'])
  })

  it('permits exactly one schema, so the list cannot quietly grow', () => {
    expect([...SEGMENT_PERMITTED_SCHEMAS]).toEqual(['public'])
  })
})

describe('validateSegmentDefinition', () => {
  it('passes the committed fixture segment, which is the control for every refusal below', () => {
    expect(validateSegmentDefinition(lapsedVips)).toEqual([])
  })

  it('refuses an operator the attribute does not accept', () => {
    const refusals = validateSegmentDefinition({
      ...lapsedVips,
      terms: [{ attribute: 'customer.is_vip', operator: 'at_least', value: 1 }],
    })
    expect(ruleOf(refusals)).toContain('segment-operator-not-permitted-for-attribute')
  })

  it('refuses a value of the wrong type rather than coercing it', () => {
    const refusals = validateSegmentDefinition({
      ...lapsedVips,
      terms: [{ attribute: 'customer.is_vip', operator: 'equals', value: 'yes' }],
    })
    expect(ruleOf(refusals)).toContain('segment-value-wrong-type')
  })

  it('refuses a fractional count, because it means the caller handed over an average', () => {
    const refusals = validateSegmentDefinition({
      ...lapsedVips,
      terms: [{ attribute: 'appointment.completed_visit_count', operator: 'at_least', value: 2.5 }],
    })
    expect(ruleOf(refusals)).toContain('segment-value-wrong-type')
  })

  it('refuses an empty "in" list rather than matching nobody', () => {
    const refusals = validateSegmentDefinition({
      ...lapsedVips,
      terms: [{ attribute: 'customer.lifecycle_state', operator: 'in', value: [] }],
    })
    expect(ruleOf(refusals)).toContain('segment-value-list-is-empty')
  })

  it('refuses a segment with no terms, so "everybody" has to be written', () => {
    expect(ruleOf(validateSegmentDefinition({ ...lapsedVips, terms: [] }))).toContain(
      'segment-no-terms',
    )
  })

  it('refuses more terms than the ceiling', () => {
    const terms = Array.from({ length: SEGMENT_MAX_TERMS + 1 }, () => ({
      attribute: 'customer.is_vip' as const,
      operator: 'equals' as const,
      value: true,
    }))
    expect(ruleOf(validateSegmentDefinition({ ...lapsedVips, terms }))).toContain(
      'segment-too-many-terms',
    )
  })

  it('refuses a key the database would refuse, rather than at the insert', () => {
    expect(
      ruleOf(validateSegmentDefinition({ ...lapsedVips, segmentKey: 'Lapsed VIPs' })),
    ).toContain('segment-key-not-lower-snake-case')
  })
})

describe('serialiseSegmentDefinition', () => {
  it('is stable under key order, so a stored segment is comparable with a committed one', () => {
    const reordered: SegmentDefinition = {
      title: lapsedVips.title,
      terms: lapsedVips.terms,
      match: lapsedVips.match,
      segmentKey: lapsedVips.segmentKey,
    }
    expect(serialiseSegmentDefinition(reordered)).toBe(serialiseSegmentDefinition(lapsedVips))
    // The control: a DIFFERENT segment must not serialise the same, or the comparison means nothing.
    expect(serialiseSegmentDefinition({ ...lapsedVips, match: 'any' })).not.toBe(
      serialiseSegmentDefinition(lapsedVips),
    )
  })
})

describe('segmentCountFreshness', () => {
  const at = 1_800_000_000_000 as Instant

  it('distinguishes "never counted" from a count of zero', () => {
    expect(segmentCountFreshness({ cachedCount: null, cachedCountAt: null, at })).toEqual({
      kind: 'never_counted',
    })
    const zero = segmentCountFreshness({
      cachedCount: 0,
      cachedCountAt: at,
      at,
    })
    expect(zero.kind).toBe('fresh')
    if (zero.kind === 'never_counted') throw new Error('a dated zero is a count')
    expect(zero.count).toBe(0)
  })

  it('carries the age on BOTH verdicts, so a screen cannot show the number without it', () => {
    const fresh = segmentCountFreshness({
      cachedCount: 42,
      cachedCountAt: (at - 60_000) as Instant,
      at,
    })
    const stale = segmentCountFreshness({
      cachedCount: 42,
      cachedCountAt: (at - (SEGMENT_COUNT_STALENESS_SECONDS + 1) * 1000) as Instant,
      at,
    })
    expect(fresh.kind).toBe('fresh')
    expect(stale.kind).toBe('stale')
    if (fresh.kind === 'never_counted' || stale.kind === 'never_counted') {
      throw new Error('both are dated counts')
    }
    expect(fresh.ageSeconds).toBe(60)
    expect(stale.ageSeconds).toBe(SEGMENT_COUNT_STALENESS_SECONDS + 1)
    expect(fresh.countedAt).toBe(at - 60_000)
  })

  it('is exactly at the ceiling is STALE, not fresh', () => {
    const atCeiling = segmentCountFreshness({
      cachedCount: 1,
      cachedCountAt: (at - SEGMENT_COUNT_STALENESS_SECONDS * 1000) as Instant,
      at,
    })
    expect(atCeiling.kind).toBe('stale')
  })
})
