import { describe, expect, it } from 'vitest'
import type { Instant } from '../time.ts'
import { instantFromIso } from '../time.ts'
import { type DuplicateScore, scoreDuplicatePair } from './duplicate-score.ts'
import {
  CUSTOMER_MERGE_FIELDS,
  type CustomerMergeSubject,
  MERGE_FIELD_RESOLUTIONS,
  type MergeAuthority,
  mergePlanRefusalOf,
  planCustomerMerge,
  unionByNaturalKey,
} from './merge-plan.ts'

/**
 * C-CRM-05's pure half: who survives, what each field resolves to, and what a merge refuses outright.
 *
 * Every score here is produced by `scoreDuplicatePair` rather than written by hand. A hand-built
 * `DuplicateScore` would let this file assert a band C-CRM-02's table cannot actually produce — which is
 * the one way a test of "the auto band needs an identical number" could pass while the rule was gone.
 *
 * The record labels are `Customer NNNN`, which is what this system's records hold (ADR 0020). Nothing
 * here is a name, including in the fixtures.
 */

const AT = (iso: string): Instant => instantFromIso(iso)

const subject = (over: Partial<CustomerMergeSubject> = {}): CustomerMergeSubject => ({
  id: '00000000-0000-7000-8000-00000000c501',
  createdAt: AT('2026-01-01T08:00:00.000Z'),
  phoneE164: '+971590000501',
  displayName: null,
  nameMatchKey: null,
  locale: 'en',
  notes: null,
  createdVia: 'guest_booking',
  phoneVerifiedAt: null,
  ...over,
})

/** The same handset typed twice: the only shape that reaches the auto band (C-CRM-02's table). */
const identicalPhones = (): DuplicateScore =>
  scoreDuplicatePair(
    { phone: '+971590000501', label: 'Customer 0501' },
    { phone: '+971590000501', label: 'Customer 0501' },
  )

/** One digit apart with agreeing labels: the review band, which needs a person. */
const oneDigitApart = (): DuplicateScore =>
  scoreDuplicatePair(
    { phone: '+971590000501', label: 'Customer 0501' },
    { phone: '+971590000502', label: 'Customer 0501' },
  )

/** Two unrelated numbers and two unrelated labels: `distinct`, which nothing may merge. */
const unrelated = (): DuplicateScore =>
  scoreDuplicatePair(
    { phone: '+971590000501', label: 'Customer 0501' },
    { phone: '+971590000777', label: 'Sea Salt Scrub Regular' },
  )

const planOf = (
  a: CustomerMergeSubject,
  b: CustomerMergeSubject,
  score: DuplicateScore = identicalPhones(),
  authority: MergeAuthority = 'auto_merge',
) => {
  const decision = planCustomerMerge(a, b, score, authority)
  if (decision.kind !== 'plan') throw new Error(`expected a plan, got ${decision.refusal}`)
  return decision
}

describe('the bands a merge may act on', () => {
  it('refuses a record merged into itself, and says why the count would be wrong', () => {
    const one = subject()
    const decision = planCustomerMerge(one, one, identicalPhones(), 'auto_merge')
    expect(mergePlanRefusalOf(decision)).toBe('merge_same_record')
    expect(decision.kind === 'refused' && decision.detail).toContain('cannot be merged into itself')
  })

  it('refuses a `distinct` pair under BOTH authorities', () => {
    const a = subject()
    const b = subject({ id: '00000000-0000-7000-8000-00000000c502' })
    for (const authority of ['auto_merge', 'operator_confirmed'] as const) {
      const decision = planCustomerMerge(a, b, unrelated(), authority)
      expect(mergePlanRefusalOf(decision), authority).toBe('merge_verdict_is_distinct')
    }
  })

  it('refuses the review band under `auto_merge` and accepts it under `operator_confirmed`', () => {
    const a = subject()
    const b = subject({ id: '00000000-0000-7000-8000-00000000c502' })
    const review = oneDigitApart()
    expect(review.verdict).toBe('review')
    expect(mergePlanRefusalOf(planCustomerMerge(a, b, review, 'auto_merge'))).toBe(
      'merge_needs_an_operator',
    )
    const confirmed = planCustomerMerge(a, b, review, 'operator_confirmed')
    expect(confirmed.kind).toBe('plan')
    // The control on the pair above: the band a person may confirm is not the band the score alone
    // reaches, or the two assertions would both pass against an authority check that did nothing.
    expect(planCustomerMerge(a, b, identicalPhones(), 'auto_merge').kind).toBe('plan')
  })

  it('carries the score and the two agreement cells onto the plan', () => {
    const score = identicalPhones()
    const plan = planOf(subject(), subject({ id: '00000000-0000-7000-8000-00000000c502' }), score)
    expect(plan.scorePerMille).toBe(score.scorePerMille)
    expect(plan.phoneAgreement).toBe('identical')
    expect(plan.labelAgreement).toBe('identical')
    // A number alone cannot say whether the phones agreed or only the labels did, which is why
    // merge_record stores both cells. The control: they are not the same value.
    expect(plan.phoneAgreement).toBe(plan.labelAgreement)
    expect(oneDigitApart().phone).not.toBe('identical')
  })

  it('returns null from mergePlanRefusalOf for a plan', () => {
    expect(
      mergePlanRefusalOf(
        planOf(subject(), subject({ id: '00000000-0000-7000-8000-00000000c502' })),
      ),
    ).toBeNull()
  })
})

describe('which record survives', () => {
  const older = subject({
    id: '00000000-0000-7000-8000-00000000c5ff',
    createdAt: AT('2025-03-04T09:00:00.000Z'),
  })
  const newer = subject({
    id: '00000000-0000-7000-8000-00000000c501',
    createdAt: AT('2026-07-08T09:00:00.000Z'),
  })

  it('is the earlier record, whichever way round the pair arrives', () => {
    expect(planOf(older, newer).survivorId).toBe(older.id)
    expect(planOf(newer, older).survivorId).toBe(older.id)
    expect(planOf(older, newer).loserId).toBe(newer.id)
    // The control: the ids are ordered the OTHER way, so a plan that returned the smaller id whatever
    // the instants said would pass the first two assertions and fail this one.
    expect(older.id > newer.id).toBe(true)
  })

  it('breaks an exact tie on the smaller id, not on the argument order', () => {
    const at = AT('2026-01-01T08:00:00.000Z')
    const low = subject({ id: '00000000-0000-7000-8000-00000000c501', createdAt: at })
    const high = subject({ id: '00000000-0000-7000-8000-00000000c502', createdAt: at })
    expect(planOf(low, high).survivorId).toBe(low.id)
    expect(planOf(high, low).survivorId).toBe(low.id)
  })

  it('lets an operator nominate the LATER record, in either argument order', () => {
    const review = oneDigitApart()
    for (const [a, b] of [
      [older, newer],
      [newer, older],
    ] as const) {
      const decision = planCustomerMerge(a, b, review, 'operator_confirmed', {
        nominatedSurvivorId: newer.id,
      })
      if (decision.kind !== 'plan') throw new Error(`expected a plan, got ${decision.refusal}`)
      expect(decision.survivorId).toBe(newer.id)
      expect(decision.loserId).toBe(older.id)
    }
    // The control: without the nomination the same pair keeps the earlier record, so the two
    // assertions above are about the override rather than about a default that happens to agree.
    expect(
      planCustomerMerge(older, newer, review, 'operator_confirmed').kind === 'plan' &&
        planCustomerMerge(older, newer, review, 'operator_confirmed'),
    ).toMatchObject({ survivorId: older.id })
  })

  it('nominating the DEFAULT survivor is accepted and changes nothing', () => {
    const review = oneDigitApart()
    const nominated = planCustomerMerge(older, newer, review, 'operator_confirmed', {
      nominatedSurvivorId: older.id,
    })
    const plain = planCustomerMerge(older, newer, review, 'operator_confirmed')
    expect(nominated).toEqual(plain)
  })

  it('refuses a nominee that is neither record of the pair', () => {
    const decision = planCustomerMerge(older, newer, oneDigitApart(), 'operator_confirmed', {
      nominatedSurvivorId: '00000000-0000-7000-8000-00000000c5aa',
    })
    expect(mergePlanRefusalOf(decision)).toBe('merge_survivor_not_in_the_pair')
    expect(decision.kind === 'refused' && decision.detail).toContain('neither of them')
  })

  it('refuses a nomination under `auto_merge`, because the score cannot have made it', () => {
    const decision = planCustomerMerge(older, newer, identicalPhones(), 'auto_merge', {
      nominatedSurvivorId: newer.id,
    })
    expect(mergePlanRefusalOf(decision)).toBe('merge_nomination_needs_an_operator')
    // The control: the same pair and the same authority WITHOUT a nomination is a plan, so the refusal
    // is about the nomination and not about the band.
    expect(planCustomerMerge(older, newer, identicalPhones(), 'auto_merge').kind).toBe('plan')
  })
})

describe('the scalar fields', () => {
  const survivor = subject({
    id: '00000000-0000-7000-8000-00000000c501',
    createdAt: AT('2025-01-01T08:00:00.000Z'),
  })

  it('reports every field, once, in the declared order', () => {
    const plan = planOf(
      survivor,
      subject({
        id: '00000000-0000-7000-8000-00000000c502',
        createdAt: AT('2026-01-01T08:00:00.000Z'),
      }),
    )
    expect(plan.fields.map((field) => field.field)).toEqual([...CUSTOMER_MERGE_FIELDS])
    for (const field of plan.fields) {
      expect(MERGE_FIELD_RESOLUTIONS).toContain(field.resolution)
    }
  })

  it('never transfers the number or its verification, and says why', () => {
    const loser = subject({
      id: '00000000-0000-7000-8000-00000000c502',
      createdAt: AT('2026-01-01T08:00:00.000Z'),
      phoneE164: '+971590000502',
      phoneVerifiedAt: AT('2026-02-02T10:00:00.000Z'),
    })
    const plan = planOf(survivor, loser)
    const phone = plan.fields.find((field) => field.field === 'phoneE164')
    const verified = plan.fields.find((field) => field.field === 'phoneVerifiedAt')
    expect(phone?.resolution).toBe('not_transferable')
    expect(phone?.loserValue).toBe('+971590000502')
    expect(phone?.why).toContain('UNIQUE')
    expect(verified?.resolution).toBe('not_transferable')
    expect(verified?.loserValue).toBe('2026-02-02T10:00:00.000Z')
    expect(verified?.survivorValue).toBeNull()
    // And neither reaches the update: a survivor that gained the loser's verification would claim a
    // number nobody proved had been proved.
    expect(Object.keys(plan.survivorUpdates)).toEqual([])
  })

  it('fills in a value the survivor has none of, and moves the match key with the name', () => {
    const loser = subject({
      id: '00000000-0000-7000-8000-00000000c502',
      createdAt: AT('2026-01-01T08:00:00.000Z'),
      displayName: 'Customer 0502',
      nameMatchKey: 'customer0502|0502',
      notes: 'Prefers the quiet room.',
    })
    const plan = planOf(survivor, loser)
    expect(plan.fields.find((field) => field.field === 'displayName')?.resolution).toBe(
      'loser_supplies',
    )
    expect(plan.survivorUpdates.displayName).toBe('Customer 0502')
    // A name written without its key is a record the duplicate scan can no longer find (0019).
    expect(plan.survivorUpdates.nameMatchKey).toBe('customer0502|0502')
    expect(plan.survivorUpdates.notes).toBe('Prefers the quiet room.')
  })

  it('never overwrites a value the survivor already has, and keeps the loser’s for the record', () => {
    const named = subject({
      id: '00000000-0000-7000-8000-00000000c501',
      createdAt: AT('2025-01-01T08:00:00.000Z'),
      displayName: 'Customer 0501',
      nameMatchKey: 'customer0501|0501',
      notes: 'Allergic to citrus oils.',
      locale: 'en',
    })
    const loser = subject({
      id: '00000000-0000-7000-8000-00000000c502',
      createdAt: AT('2026-01-01T08:00:00.000Z'),
      displayName: 'Customer 0502',
      nameMatchKey: 'customer0502|0502',
      notes: 'Prefers the quiet room.',
      locale: 'ar',
      createdVia: 'import',
    })
    const plan = planOf(named, loser)
    const byField = new Map(plan.fields.map((field) => [field.field, field]))
    for (const field of ['displayName', 'nameMatchKey', 'locale', 'notes', 'createdVia'] as const) {
      expect(byField.get(field)?.resolution, field).toBe('survivor_wins')
    }
    expect(byField.get('notes')?.loserValue).toBe('Prefers the quiet room.')
    expect(byField.get('locale')?.survivorValue).toBe('en')
    // Nothing is written to the survivor, which is the whole difference from the case above.
    expect(Object.keys(plan.survivorUpdates)).toEqual([])
  })

  it('reports two absent values and two equal values as `agreed`, discarding nothing', () => {
    const plan = planOf(
      survivor,
      subject({
        id: '00000000-0000-7000-8000-00000000c502',
        createdAt: AT('2026-01-01T08:00:00.000Z'),
      }),
    )
    const byField = new Map(plan.fields.map((field) => [field.field, field]))
    // Both null.
    expect(byField.get('notes')?.resolution).toBe('agreed')
    expect(byField.get('notes')?.loserValue).toBeNull()
    // Both the same.
    expect(byField.get('locale')?.resolution).toBe('agreed')
    expect(byField.get('createdVia')?.resolution).toBe('agreed')
  })
})

describe('unionByNaturalKey', () => {
  interface Send {
    readonly messageId: string
    readonly windowStart: string
  }
  const key = (row: Send) => `${row.windowStart}|${row.messageId}`
  const send = (messageId: string): Send => ({ messageId, windowStart: '2026-05-01' })

  it('gives a survivor count of exactly 2 from one in-window send on each record', () => {
    const result = unionByNaturalKey([send('m-1')], [send('m-2')], key)
    // The worked example the acceptance criterion names: never 1 (a row dropped, so the merged contact
    // gets a fresh allowance) and never 4 (both sets counted twice, so one send silences somebody).
    expect(result.keptCount).toBe(2)
    expect(result.deduplicated).toHaveLength(0)
  })

  it('counts a message recorded against BOTH records exactly once', () => {
    const result = unionByNaturalKey([send('m-1')], [send('m-1')], key)
    expect(result.keptCount).toBe(1)
    expect(result.deduplicated).toHaveLength(1)
    // The control that makes the count mean something: the same shapes with different message ids are
    // two, so the de-duplication is about the key and not about the loser's rows being ignored.
    expect(unionByNaturalKey([send('m-1')], [send('m-2')], key).keptCount).toBe(2)
  })

  it('folds a duplicate the survivor already held, because the cap would over-count it', () => {
    const result = unionByNaturalKey([send('m-1'), send('m-1')], [send('m-2')], key)
    expect(result.keptCount).toBe(2)
    expect(result.deduplicated).toHaveLength(1)
  })

  it('keeps the survivor’s rows first, so the kept set is the survivor’s own order', () => {
    const result = unionByNaturalKey([send('m-9')], [send('m-1')], key)
    expect(result.kept.map((row) => row.messageId)).toEqual(['m-9', 'm-1'])
  })

  it('is total over empty inputs in both positions', () => {
    expect(unionByNaturalKey<Send>([], [], key).keptCount).toBe(0)
    expect(unionByNaturalKey([], [send('m-1')], key).keptCount).toBe(1)
    expect(unionByNaturalKey([send('m-1')], [], key).keptCount).toBe(1)
  })
})
