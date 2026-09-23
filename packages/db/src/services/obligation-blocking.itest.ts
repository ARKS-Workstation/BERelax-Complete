import { getDefinition, SETTINGS } from '@berelax/config'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createConnection, type Sql } from '../connection.ts'
import { readAvailabilityFacts } from '../queries/availability.ts'
import { type TherapistExclusion, therapistPoolCtes } from '../repositories/eligibility.ts'
import { withUnitOfWork } from '../tx.ts'
import {
  completeObligationInstance,
  fileObligationEvidence,
  generateObligationInstances,
  OVERDUE_BLOCKING_OBLIGATION_EXCLUSION,
  OVERDUE_BLOCKING_OBLIGATION_REASON,
  overdueBlockingObligationExclusion,
  readObligationDefinitions,
  readObligationInstances,
  rescheduleObligationInstance,
  setObligationAnchorDate,
} from './obligation.ts'

/**
 * M-VAT-10 — the compliance calendar against a real PostgreSQL: the seeded duties, the blocking
 * behaviour, and the absence of a writer for it.
 *
 * `.itest.ts` and not `.test.ts`: `packages/db` has no database in the unit runner. The pure half of the
 * rule is `packages/core/src/compliance/obligation.test.ts`, and the half that needs BOTH packages — the
 * deterministic generator driven by `obligationInstancePlan`, the publish path's `PublishingBlocked`, and
 * the structural agreement between the row shape and the port — is
 * `packages/fixtures/src/obligation-calendar.itest.ts`, because this package may never import
 * `packages/core`.
 *
 * Four claims live here:
 *
 *   1. **The seeded obligations are complete.** Every one carries a cadence, an owner role, a blocking
 *      consequence, an evidence requirement and an unverified flag — and the control is a deliberately
 *      incomplete row, which the database refuses. An enumeration over columns that cannot be null is
 *      not a check until something has been seen to fail it.
 *   2. **The availability consequence.** The availability query is called BEFORE and AFTER an overdue
 *      blocking credential obligation, and the therapist disappears from the result. Then the block is
 *      ended twice over — once by completing the occurrence and once by correcting its due date — and the
 *      therapist comes back, which is what stops the assertion passing against a query that returns
 *      nobody.
 *   3. **It composes.** The same exclusion applies alongside an unrelated one — C-CRM-01 is adding a
 *      therapist/customer do-not-pair exclusion to this very path — and each therapist is excluded with
 *      their own reason. Two filters inlined into one WHERE clause by two branches is the merge that
 *      keeps one of them; this is the assertion that would fail if that happened.
 *   4. **Blocking has no settings writer.** No declared setting key reaches it, an invented one is
 *      refused as undeclared, the generated column cannot be written, and the database refuses an UPDATE
 *      that changes anything but the due date — while the due-date change itself succeeds and writes an
 *      `audit_event`.
 *
 * ## Isolation
 *
 * The integration suite runs sequentially against ONE database and earlier files leave rows behind. The
 * trading date 2096-04-14 is used by no other suite; every room, service, variant, employee and shift
 * carries {@link MARKER}; the availability reads are narrowed to this file's two therapists with
 * `therapistIds`, so what the query can SEE is narrowed rather than rows being deleted; and the audit
 * assertion is a DELTA counted in SQL, never a total and never through a capped reader.
 *
 * **Nothing is left behind, and one case had to be written around a table nothing may delete from.** A
 * completion that has filed its evidence is permanent by design: `obligation_evidence` is append-only
 * (ZO004) and the occurrence beneath it is `ON DELETE RESTRICT`. So the completion cases assert INSIDE a
 * unit of work and then throw, which rolls the transaction back — the service's own writes are what the
 * assertions read, and the rows do not survive the test. {@link resetOccurrences} removes the rest, and
 * runs again at the start of each availability case so a crashed run cannot make the next one green.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

const MARKER = 'mvat10 obligation itest'
const PROBE = 'mvat10_probe'
const TRADING_DATE = '2096-04-14'
const DAY_BEFORE = '2096-04-13'
const NOW = Date.parse('2096-04-11T12:00:00+04:00')

/** The credential obligation used for the availability case. Seeded by 0052, per therapist, blocking. */
const CREDENTIAL_KEY = 'therapist_health_certificate_renewal'
/** The licence obligation the publish guard reads. Seeded by 0052, business-wide, blocking. */
const LICENCE_KEY = 'trade_licence_renewal'
/** Business-wide, manager-owned and evidence-requiring: the completion case. */
const COMPLETION_KEY = 'hygiene_inspection_log_review'
/**
 * This file's own obligation, and the one thing it has that no seeded one does: `evidence_required` false.
 *
 * Needed so the "the therapist comes back when it is completed" case can complete an occurrence and then
 * DELETE it. Completing a seeded credential obligation requires filing evidence, `obligation_evidence` is
 * append-only by design, and the occurrence beneath it is ON DELETE RESTRICT — so that path would leave a
 * completed occurrence against one of this file's therapists for ever, and the NEXT run would find it
 * already completed and assert against stale state. Every other property matches the seeded credential
 * obligations, including the blocking consequence, which is what the case is about.
 */
const PROBE_KEY = 'mvat10_probe_credential'

/**
 * The F07 roles, restated.
 *
 * `packages/db` may not import `@berelax/core`, so this list is the same duplication
 * `appointment_status_history.actor_role` carries — and it is made safe the same way: the CHECK
 * constraint is parsed out of `pg_constraint` and pinned to `ROLES` in
 * `packages/fixtures/src/obligation-calendar.itest.ts`, which may import both.
 */
const ROLE_NAMES = [
  'owner',
  'manager',
  'accountant',
  'receptionist',
  'therapist',
  'marketer',
  'auditor',
  'system',
]

const CADENCES = ['monthly', 'quarterly', 'annual', 'event_driven']
const BLOCKING_EFFECTS = ['none', 'therapist_unbookable', 'publishing_blocked']

const ACTOR = { kind: 'staff', label: 'M-VAT-10 itest' } as const

let sql: Sql
let variantId: string
let clearTherapistId: string
let lapsedTherapistId: string

const nextDay = (date: string): string => {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() + 1)
  return value.toISOString().slice(0, 10)
}
const at = (date: string, hhmm: string): number => Date.parse(`${date}T${hhmm}:00+04:00`)

/** The availability read, narrowed to this file's therapists. */
async function bookableTherapistIds(): Promise<readonly string[]> {
  const facts = await readAvailabilityFacts(
    sql,
    {
      tradingDate: TRADING_DATE,
      serviceVariantId: variantId,
      therapistIds: [clearTherapistId, lapsedTherapistId],
      // The shipped figures (Y9-lead). They belong to the request rather than to this file, and the
      // availability read refuses a request without them.
      minLeadMinutes: 120,
      maxAdvanceDays: 90,
    },
    NOW,
  )
  return facts.therapists.map((therapist) => therapist.therapistId).sort()
}

async function exclusionReasonFor(therapistId: string): Promise<string | undefined> {
  const facts = await readAvailabilityFacts(
    sql,
    {
      tradingDate: TRADING_DATE,
      serviceVariantId: variantId,
      therapistIds: [clearTherapistId, lapsedTherapistId],
      // The shipped figures (Y9-lead). They belong to the request rather than to this file, and the
      // availability read refuses a request without them.
      minLeadMinutes: 120,
      maxAdvanceDays: 90,
    },
    NOW,
  )
  return facts.excluded.find((entry) => entry.therapistId === therapistId)?.reason
}

/** Counted in SQL. A capped reader would pin both sides of a delta at its limit (brief rule 12). */
async function auditRowsFor(action: string): Promise<number> {
  const [row] = await sql<{ n: string }[]>`
    select count(*)::text as n from audit_event where action = ${action}
  `
  return Number((row as { n: string }).n)
}

/**
 * Every occurrence this file owns, removed.
 *
 * Called at the start of each availability case as well as in `beforeAll`, so a case does not inherit the
 * previous one's rows and — more importantly — so a run does not inherit a CRASHED run's. The exclusion
 * reads `status`, so one leftover completed occurrence would make "the therapist disappears" pass or fail
 * for a reason that has nothing to do with the code. Evidence-bearing occurrences are skipped, because
 * `obligation_evidence` is append-only and the occurrence beneath one is ON DELETE RESTRICT.
 */
async function resetOccurrences(): Promise<void> {
  await sql`
    delete from obligation_instance i
     where (i.subject_employee_id in (select id from employee where notes = ${MARKER})
            or i.obligation_id in (select id from obligation where key in (${LICENCE_KEY}, ${PROBE_KEY},
                                                                          'vat_return_filing'))
            or (i.obligation_id = (select id from obligation where key = ${COMPLETION_KEY})
                and i.due_on between '2091-01-01' and '2091-12-31'))
       and not exists (select 1 from obligation_evidence e where e.obligation_instance_id = i.id)
  `
}

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })

  await sql`
    insert into obligation
      (key, title, obligation_class, cadence, subject_scope, owner_role, blocking_effect,
       evidence_required, source_reference, authority)
    values (${PROBE_KEY}, ${'Probe credential obligation'}, 'credential', 'annual', 'therapist',
            'manager', 'therapist_unbookable', false, 'docs/04-uae-compliance.md §7', null)
    on conflict (key) do nothing
  `

  await sql`
    insert into business_day (trading_date, opens_at, closes_at, source)
    values (${TRADING_DATE}, ${`${TRADING_DATE} 11:00:00+04`}::timestamptz,
            ${`${nextDay(TRADING_DATE)} 02:00:00+04`}::timestamptz, 'weekly')
    on conflict (trading_date) do nothing
  `

  await sql`
    insert into rooms (code, name, room_type, capacity, display_order, notes)
    values (${'mvat10-room'}, ${'Probe mvat10'}, 'standard', 1, 93, ${MARKER})
    on conflict (code) do update set capacity = excluded.capacity
  `

  const [service] = await sql<{ id: string }[]>`
    insert into service
      (style, treatment_key, slug, internal_name, public_display_name, turnaround_minutes,
       display_order)
    values ('asian', ${PROBE}, ${'mvat10-probe'}, ${'Probe massage'}, ${'Normal Massage (Asian)'},
            20, 96)
    on conflict (style, treatment_key) do update set turnaround_minutes = excluded.turnaround_minutes
    returning id
  `
  const serviceId = (service as { id: string }).id
  await sql`
    insert into service_room_type_compat (service_style, service_treatment_key, room_type)
    values ('asian', ${PROBE}, 'standard')
    on conflict do nothing
  `
  await sql`
    insert into service_resource_shape
      (service_style, service_treatment_key, shape, therapists_required, rooms_required,
       min_room_capacity, required_room_type, therapist_buffer_minutes)
    values ('asian', ${PROBE}, 'solo', 1, 1, 1, null, 10)
    on conflict do nothing
  `
  const [variant] = await sql<{ id: string }[]>`
    insert into service_variant (service_id, duration_minutes, gross_price_fils, provisional_note)
    values (${serviceId}, 60, 20000, ${MARKER})
    on conflict (service_id, duration_minutes) do update set gross_price_fils = excluded.gross_price_fils
    returning id
  `
  variantId = (variant as { id: string }).id

  const staff: string[] = []
  for (const reference of ['mvat10-clear', 'mvat10-lapsed'] as const) {
    const [row] = await sql<{ id: string }[]>`
      insert into employee (staff_reference, gender, employed_from, notes)
      values (${reference}, 'female', '2096-01-01', ${MARKER})
      on conflict (staff_reference) do update set notes = excluded.notes
      returning id
    `
    const id = (row as { id: string }).id
    staff.push(id)
    await sql`
      insert into employee_skill (employee_id, skill) values (${id}, 'asian_style')
      on conflict do nothing
    `
    // Both mandatory document types, unexpired. The point of this file is the obligation, so the
    // credential gate that B-AVAIL-04 already owns must be satisfied: a therapist excluded by
    // `credential_missing` would make every assertion below pass for the wrong reason.
    for (const documentType of ['professional_licence', 'health_certificate'] as const) {
      await sql`
        insert into employee_document (employee_id, document_type, expires_on)
        values (${id}, ${documentType}::employee_document_type, '2099-12-31')
        on conflict do nothing
      `
    }
  }
  clearTherapistId = staff[0] as string
  lapsedTherapistId = staff[1] as string

  const [shift] = await sql<{ id: string }[]>`
    insert into shift (trading_date, period, label)
    values (${TRADING_DATE},
            ${`[${new Date(at(TRADING_DATE, '11:00')).toISOString()},${new Date(at(nextDay(TRADING_DATE), '02:00')).toISOString()})`}::tstzrange,
            ${MARKER})
    returning id::text as id
  `
  for (const id of staff) {
    await sql`
      insert into shift_assignment (shift_id, employee_id)
      values (${(shift as { id: string }).id}, ${id}) on conflict do nothing
    `
  }

  await resetOccurrences()
})

afterAll(async () => {
  // Every occurrence this file wrote EXCEPT the ones that carry evidence: those rows are protected by
  // `obligation_evidence.obligation_instance_id` (ON DELETE RESTRICT) and the evidence itself cannot be
  // deleted at all (ZO004). By subject and by key rather than by emptying the table, because another
  // suite's rows are not this file's to remove.
  await resetOccurrences()
  // And this file's own obligation DEFINITION, which is the row a later unit enumerating the calendar
  // would otherwise count as an eighth duty. It goes after the occurrences, because
  // `obligation_instance.obligation_id` is ON DELETE RESTRICT.
  await sql`delete from obligation where key = ${PROBE_KEY}`
  await sql`delete from shift_assignment where employee_id in (
    select id from employee where notes = ${MARKER}
  )`
  await sql`delete from shift where label = ${MARKER}`
  await sql`delete from employee_document where employee_id in (
    select id from employee where notes = ${MARKER}
  )`
  await sql`delete from employee_skill where employee_id in (
    select id from employee where notes = ${MARKER}
  )`
  await sql`delete from employee where notes = ${MARKER}`
  await sql`delete from service where treatment_key = ${PROBE}`
  await sql`delete from rooms where notes = ${MARKER}`
  await sql`delete from availability_epoch where trading_date = ${TRADING_DATE}`
  await sql`delete from business_day where trading_date = ${TRADING_DATE}`
  await sql?.end({ timeout: 5 })
})

describe('the seeded obligations', () => {
  it('every one declares a cadence, an owner role, a blocking flag, evidence and an unverified flag', async () => {
    const definitions = await readObligationDefinitions(sql)
    // The seven of 0052. Read by key rather than by count, because another unit may add an eighth and a
    // count assertion would fail for a reason that is not a defect.
    const seeded = definitions.filter((definition) => !definition.key.startsWith('mvat10_'))
    expect(seeded.length).toBeGreaterThanOrEqual(7)

    for (const definition of seeded) {
      expect(CADENCES, `${definition.key} cadence`).toContain(definition.cadence)
      expect(ROLE_NAMES, `${definition.key} owner role`).toContain(definition.ownerRole)
      expect(BLOCKING_EFFECTS, `${definition.key} blocking effect`).toContain(
        definition.blockingEffect,
      )
      // The flag is GENERATED from the consequence, so this is an assertion about the database rather
      // than about a value this reader computed.
      expect(definition.isBlocking, `${definition.key} is_blocking`).toBe(
        definition.blockingEffect !== 'none',
      )
      expect(typeof definition.evidenceRequired, `${definition.key} evidence`).toBe('boolean')
      expect(typeof definition.isUnverified, `${definition.key} unverified`).toBe('boolean')
      expect(definition.sourceReference, `${definition.key} source`).toMatch(/docs\/04/)
      if (definition.isUnverified) {
        // An unverified duty with no open question is invisible on the dashboard that exists to show it.
        expect(definition.openQuestionId, `${definition.key} open question`).toMatch(/^Y\d+-/)
        expect(definition.unverifiedNote, `${definition.key} note`).toBeTruthy()
      }
      // Rule 15. No seeded obligation carries a renewal date, because the build has seen no licence,
      // permit or certificate — and a plausible date is indistinguishable from a configured one.
      expect(definition.anchorOn, `${definition.key} anchor`).toBeUndefined()
    }

    // The two blocking consequences are paired with the two classes that can carry them.
    const byKey = new Map(seeded.map((definition) => [definition.key, definition]))
    expect(byKey.get(LICENCE_KEY)?.blockingEffect).toBe('publishing_blocked')
    expect(byKey.get(LICENCE_KEY)?.obligationClass).toBe('licence')
    expect(byKey.get(CREDENTIAL_KEY)?.blockingEffect).toBe('therapist_unbookable')
    expect(byKey.get(CREDENTIAL_KEY)?.obligationClass).toBe('credential')
    expect(byKey.get(CREDENTIAL_KEY)?.subjectScope).toBe('therapist')
    // And one that does NOT block, so "every obligation is blocking" would fail here.
    expect(byKey.get('vat_return_filing')?.blockingEffect).toBe('none')
    expect(byKey.get('vat_return_filing')?.isBlocking).toBe(false)
  })

  it('and the control: an incomplete obligation is refused by the database', async () => {
    // Without this the enumeration above is a loop over columns that cannot be null, which is a shape
    // assertion rather than a check. Each of these is a way a seeded row could be incomplete.
    const unverifiedWithNoQuestion = sql`
      insert into obligation
        (key, title, obligation_class, cadence, subject_scope, owner_role, evidence_required,
         is_unverified, source_reference)
      values ('mvat10_no_question', 'Probe', 'hygiene', 'monthly', 'business', 'manager', true,
              true, 'docs/04-uae-compliance.md §9')
    `
    await expect(unverifiedWithNoQuestion).rejects.toThrow(/obligation_unverified_names_a_question/)

    const unknownRole = sql`
      insert into obligation
        (key, title, obligation_class, cadence, subject_scope, owner_role, evidence_required,
         source_reference)
      values ('mvat10_unknown_role', 'Probe', 'hygiene', 'monthly', 'business', 'compliance_officer',
              true, 'docs/04-uae-compliance.md §9')
    `
    await expect(unknownRole).rejects.toThrow(/obligation_owner_role_known/)

    // A blocking consequence that does not follow from the class: a hygiene log that silently stopped a
    // booking would be a blocking rule nobody declared.
    const mismatchedConsequence = sql`
      insert into obligation
        (key, title, obligation_class, cadence, subject_scope, owner_role, blocking_effect,
         evidence_required, source_reference)
      values ('mvat10_wrong_effect', 'Probe', 'hygiene', 'monthly', 'business', 'manager',
              'therapist_unbookable', true, 'docs/04-uae-compliance.md §9')
    `
    await expect(mismatchedConsequence).rejects.toThrow(
      /obligation_blocking_effect_matches_class|obligation_therapist_effect_is_per_therapist/,
    )

    // The control on the control: a COMPLETE row is accepted, so the three refusals above are about the
    // omissions rather than about the insert failing for some unrelated reason.
    const complete = await sql<{ key: string }[]>`
      insert into obligation
        (key, title, obligation_class, cadence, subject_scope, owner_role, evidence_required,
         source_reference)
      values ('mvat10_complete', 'Probe', 'hygiene', 'monthly', 'business', 'manager', false,
              'docs/04-uae-compliance.md §9')
      returning key
    `
    expect(complete).toHaveLength(1)
    await sql`delete from obligation where key = 'mvat10_complete'`
  })
})

describe('an overdue blocking credential obligation removes the therapist from availability', () => {
  beforeEach(async () => {
    // Each case starts from no occurrences, so none of them inherits another's rows — and so a crashed
    // run does not make the next one assert against a completed occurrence it did not write.
    await resetOccurrences()
  })

  it('the availability query returns them before, and does not after', async () => {
    const before = await bookableTherapistIds()
    expect(before).toEqual([clearTherapistId, lapsedTherapistId].sort())

    await generateObligationInstances(sql, [
      { obligationKey: CREDENTIAL_KEY, dueOn: DAY_BEFORE, subjectEmployeeId: lapsedTherapistId },
    ])

    const after = await bookableTherapistIds()
    expect(after).toEqual([clearTherapistId])
    // Named, not merely absent: the front desk has to be told to chase a renewal rather than shown an
    // empty calendar. And the reason is this unit's own, not one of the port's seven.
    expect(await exclusionReasonFor(lapsedTherapistId)).toBe(OVERDUE_BLOCKING_OBLIGATION_REASON)
    expect(await exclusionReasonFor(clearTherapistId)).toBeUndefined()
  })

  it('is strict about the due date: due on the trading date is not overdue on it', async () => {
    // The inclusive comparison would empty the rota on every renewal date. Its own case, because it is
    // the boundary the whole rule turns on: 01:30 on the 15th is still the 14th's trading date, and a
    // therapist must not vanish mid-shift on the day their renewal falls due.
    await generateObligationInstances(sql, [
      { obligationKey: CREDENTIAL_KEY, dueOn: TRADING_DATE, subjectEmployeeId: clearTherapistId },
    ])
    expect(await bookableTherapistIds()).toEqual([clearTherapistId, lapsedTherapistId].sort())
  })

  it('and comes back when the occurrence is completed, so the exclusion is not one-way', async () => {
    // {@link PROBE_KEY} rather than a seeded obligation, for the reason its declaration gives: completing
    // one of those requires evidence, and evidence cannot be deleted — which would leave this therapist
    // permanently completed and the next run asserting against it.
    await generateObligationInstances(sql, [
      { obligationKey: PROBE_KEY, dueOn: DAY_BEFORE, subjectEmployeeId: lapsedTherapistId },
    ])
    expect(await bookableTherapistIds()).toEqual([clearTherapistId])

    const [occurrence] = await readObligationInstances(sql, {
      keys: [PROBE_KEY],
      subjectEmployeeIds: [lapsedTherapistId],
    })
    await withUnitOfWork(sql, ACTOR, (uow) =>
      completeObligationInstance(uow, {
        instanceId: (occurrence as { instanceId: string }).instanceId,
        role: 'manager',
        actorLabel: 'M-VAT-10 itest',
      }),
    )

    expect(await bookableTherapistIds()).toEqual([clearTherapistId, lapsedTherapistId].sort())
  })

  it('and comes back when the due date is moved, with the change audited', async () => {
    // The other way a block ends: the renewal date was entered wrongly and somebody corrects it. The due
    // date is the ONLY thing about an obligation that may change, so this is the whole of the writable
    // surface — and it writes an audit row, counted as a delta in SQL.
    await generateObligationInstances(sql, [
      { obligationKey: CREDENTIAL_KEY, dueOn: DAY_BEFORE, subjectEmployeeId: lapsedTherapistId },
    ])
    expect(await bookableTherapistIds()).toEqual([clearTherapistId])

    const [occurrence] = await readObligationInstances(sql, {
      keys: [CREDENTIAL_KEY],
      subjectEmployeeIds: [lapsedTherapistId],
    })
    const action = 'compliance.obligation_instance.due_date_changed'
    const auditBefore = await auditRowsFor(action)
    const { previousDueOn } = await withUnitOfWork(sql, ACTOR, (uow) =>
      rescheduleObligationInstance(uow, {
        instanceId: (occurrence as { instanceId: string }).instanceId,
        dueOn: '2096-12-31',
        reason: 'M-VAT-10 itest: the certificate expiry read off the card',
      }),
    )
    expect(previousDueOn).toBe(DAY_BEFORE)
    expect(await auditRowsFor(action)).toBe(auditBefore + 1)
    expect(await bookableTherapistIds()).toEqual([clearTherapistId, lapsedTherapistId].sort())
  })

  it('and a non-blocking overdue obligation takes nobody off the floor', async () => {
    // `vat_return_filing` is overdue by two years here. The VAT return being late is a serious matter
    // and it is not a reason to stop taking bookings; a rule that conflated the two would take the floor
    // down for a filing deadline.
    await generateObligationInstances(sql, [
      { obligationKey: 'vat_return_filing', dueOn: '2094-01-01' },
    ])
    expect(await bookableTherapistIds()).toEqual([clearTherapistId, lapsedTherapistId].sort())
  })
})

describe('the exclusion composes with an unrelated one', () => {
  /**
   * A stand-in for C-CRM-01's do-not-pair exclusion: a second, independent rule over the same candidate
   * row. It excludes the therapist whose `staff_reference` is named, which is a fact this file owns and
   * has nothing to do with the compliance calendar — which is the point. What is being asserted is that
   * two exclusions both apply, each with its own reason.
   */
  const unrelatedExclusion = (staffReference: string): TherapistExclusion => ({
    name: 'itest_unrelated_exclusion',
    reason: 'do_not_pair_stand_in',
    when: sql`
      exists (select 1 from employee e where e.id = c.id and e.staff_reference = ${staffReference})
    `,
  })

  const poolReasons = async (
    exclusions: readonly TherapistExclusion[],
  ): Promise<Record<string, string | null>> => {
    const ctes = therapistPoolCtes(sql, {
      tradingDate: TRADING_DATE,
      requiredSkill: 'asian_style',
      employeeIds: [clearTherapistId, lapsedTherapistId],
      exclusions,
    })
    const rows = await sql<{ employee_id: string; reason: string | null }[]>`
      with ${ctes}
      select employee_id::text as employee_id, reason from tp_pool order by employee_id
    `
    return Object.fromEntries(rows.map((row) => [row.employee_id, row.reason]))
  }

  it('applies both, and names each therapist with its own reason', async () => {
    // The lapsed therapist is overdue again for this case; the clear one is excluded by the unrelated
    // rule. If two filters had been inlined into one expression and one had won, one of these two
    // assertions would read `null`.
    await sql`delete from obligation_instance where subject_employee_id = ${lapsedTherapistId}
              and not exists (select 1 from obligation_evidence e where e.obligation_instance_id = obligation_instance.id)`
    await generateObligationInstances(sql, [
      { obligationKey: CREDENTIAL_KEY, dueOn: '2096-04-01', subjectEmployeeId: lapsedTherapistId },
    ])

    const both = await poolReasons([
      overdueBlockingObligationExclusion(sql, { tradingDate: TRADING_DATE }),
      unrelatedExclusion('mvat10-clear'),
    ])
    expect(both[lapsedTherapistId]).toBe(OVERDUE_BLOCKING_OBLIGATION_REASON)
    expect(both[clearTherapistId]).toBe('do_not_pair_stand_in')

    // The controls, one per exclusion: with only the other rule in play, each therapist's own reason
    // disappears. Without these, an implementation that excluded everybody would pass the case above.
    const onlyUnrelated = await poolReasons([unrelatedExclusion('mvat10-clear')])
    expect(onlyUnrelated[lapsedTherapistId]).toBeNull()
    expect(onlyUnrelated[clearTherapistId]).toBe('do_not_pair_stand_in')

    const onlyObligation = await poolReasons([
      overdueBlockingObligationExclusion(sql, { tradingDate: TRADING_DATE }),
    ])
    expect(onlyObligation[lapsedTherapistId]).toBe(OVERDUE_BLOCKING_OBLIGATION_REASON)
    expect(onlyObligation[clearTherapistId]).toBeNull()
  })

  it('refuses two exclusions that share a name or a reason', () => {
    const mine = overdueBlockingObligationExclusion(sql, { tradingDate: TRADING_DATE })
    expect(mine.name).toBe(OVERDUE_BLOCKING_OBLIGATION_EXCLUSION)
    expect(() =>
      therapistPoolCtes(sql, {
        tradingDate: TRADING_DATE,
        requiredSkill: 'asian_style',
        exclusions: [mine, { ...mine, reason: 'something_else' }],
      }),
    ).toThrow(/share the name/)
    // And a composed reason may not be one of the port's seven: a caller told `credential_expired` would
    // be sent to renew a document that is not the problem.
    expect(() =>
      therapistPoolCtes(sql, {
        tradingDate: TRADING_DATE,
        requiredSkill: 'asian_style',
        exclusions: [{ ...mine, reason: 'credential_expired' }],
      }),
    ).toThrow(/port reasons/)
  })
})

describe('completing an occurrence', () => {
  /**
   * Two fixed dates, and the completions below are rolled back deliberately.
   *
   * A committed completion cannot be undone by anybody: `obligation_evidence` is append-only (ZO004) and
   * the occurrence it is filed against is ON DELETE RESTRICT, which is the schema working exactly as
   * designed. So the happy path runs inside a unit of work that ends by throwing — the assertions are
   * made INSIDE the transaction, against the rows the service actually wrote — and the transaction rolls
   * back, leaving the occurrence open and nothing to clean up but the occurrence itself. The alternative
   * this replaced was a due date randomised per run, which piles up permanent rows and collides with an
   * earlier run's date often enough to matter.
   *
   * The dates are outside every other window this unit uses (2094-2098 in
   * packages/fixtures/src/obligation-calendar.itest.ts, 2096-04 above), so nothing here can delete or
   * count another file's rows.
   */
  const DUE_ON = '2091-03-15'
  const OWNER_DUE_ON = '2091-03-16'

  /** The marker a rolled-back assertion block throws with, so the rejection is the rollback and not a bug. */
  const ROLLBACK = 'ROLLBACK: this completion is asserted and then undone'

  /** Counted on a given handle, so a delta can be read INSIDE an uncommitted transaction. */
  const auditRowsOn = async (handle: Sql, action: string): Promise<number> => {
    const [row] = await handle<{ n: string }[]>`
      select count(*)::text as n from audit_event where action = ${action}
    `
    return Number((row as { n: string }).n)
  }

  const occurrenceFor = async (dueOn: string): Promise<string> => {
    await generateObligationInstances(sql, [{ obligationKey: COMPLETION_KEY, dueOn }])
    const found = (await readObligationInstances(sql, { keys: [COMPLETION_KEY] })).find(
      (row) => row.dueOn === dueOn,
    )
    if (found === undefined) throw new Error(`no ${COMPLETION_KEY} occurrence due ${dueOn}`)
    return found.instanceId
  }

  it('requires the declared role, and refuses evidence-less completion by name', async () => {
    const instanceId = await occurrenceFor(DUE_ON)

    // The wrong role. `hygiene_inspection_log_review` is owed by the manager.
    await expect(
      withUnitOfWork(sql, ACTOR, (uow) =>
        completeObligationInstance(uow, {
          instanceId,
          role: 'receptionist',
          actorLabel: 'M-VAT-10 itest',
        }),
      ),
    ).rejects.toThrow(/RoleNotPermitted/)

    // The right role, no attachment.
    await expect(
      withUnitOfWork(sql, ACTOR, (uow) =>
        completeObligationInstance(uow, {
          instanceId,
          role: 'manager',
          actorLabel: 'M-VAT-10 itest',
        }),
      ),
    ).rejects.toThrow(/EvidenceRequired/)

    // Both refusals rolled their transaction back, so the occurrence is still open and completable.
    const stillOpen = await readObligationInstances(sql, { keys: [COMPLETION_KEY] })
    expect(stillOpen.find((row) => row.instanceId === instanceId)?.status).toBe('open')
  })

  it('completes with the declared role and an attachment, and writes an audit_event', async () => {
    const instanceId = await occurrenceFor(DUE_ON)
    const action = 'compliance.obligation_instance.completed'

    await expect(
      withUnitOfWork(sql, ACTOR, async (uow) => {
        const before = await auditRowsOn(uow.sql, action)
        await fileObligationEvidence(uow, {
          instanceId,
          storageKey: `compliance/${instanceId}/inspection.pdf`,
          contentHash: 'b'.repeat(64),
          uploadedByLabel: 'M-VAT-10 itest',
        })
        await completeObligationInstance(uow, {
          instanceId,
          role: 'manager',
          actorLabel: 'M-VAT-10 itest',
        })
        const [row] = await uow.sql<{ status: string; completed_by_role: string }[]>`
          select status::text as status, completed_by_role
            from obligation_instance where id = ${instanceId}::uuid
        `
        expect(row).toEqual({ status: 'completed', completed_by_role: 'manager' })
        // A DELTA, counted in SQL on the transaction's own handle: `audit_event` is append-only and only
        // ever grows (ADR 0008), and the outer connection cannot see an uncommitted row.
        expect(await auditRowsOn(uow.sql, action)).toBe(before + 1)
        throw new Error(ROLLBACK)
      }),
    ).rejects.toThrow(/ROLLBACK/)

    // And it really was undone, which is what makes this file re-runnable.
    const after = await readObligationInstances(sql, { keys: [COMPLETION_KEY] })
    expect(after.find((row) => row.instanceId === instanceId)?.status).toBe('open')
  })

  it('lets the owner complete an obligation owed by somebody else', async () => {
    // ROLE_DEFINITIONS gives the proprietor every permission, and a rule that locked them out of their
    // own compliance calendar would be worked around by reassigning the obligation — which loses the
    // declared owner as well as the refusal. Asserted rather than assumed.
    const instanceId = await occurrenceFor(OWNER_DUE_ON)
    await expect(
      withUnitOfWork(sql, ACTOR, async (uow) => {
        await fileObligationEvidence(uow, {
          instanceId,
          storageKey: `compliance/${instanceId}/inspection.pdf`,
          contentHash: 'c'.repeat(64),
          uploadedByLabel: 'M-VAT-10 itest',
        })
        await completeObligationInstance(uow, {
          instanceId,
          role: 'owner',
          actorLabel: 'M-VAT-10 itest',
        })
        const [row] = await uow.sql<{ status: string }[]>`
          select status::text as status from obligation_instance where id = ${instanceId}::uuid
        `
        expect(row).toEqual({ status: 'completed' })
        throw new Error(ROLLBACK)
      }),
    ).rejects.toThrow(/ROLLBACK/)
  })

  it('refuses to edit or delete filed evidence', async () => {
    const instanceId = await occurrenceFor(DUE_ON)
    // Both attempts are made in a transaction that files the evidence first, so the refusal is asserted
    // against a real row and the whole thing rolls back — which is the only way to test a table nothing
    // may delete from without leaving a row behind for ever.
    for (const [what, mutate] of [
      [
        'update',
        (uow: { sql: Sql }, id: string) =>
          uow.sql`update obligation_evidence set storage_key = 'x' where id = ${id}::uuid`,
      ],
      [
        'delete',
        (uow: { sql: Sql }, id: string) =>
          uow.sql`delete from obligation_evidence where id = ${id}::uuid`,
      ],
    ] as const) {
      await expect(
        withUnitOfWork(sql, ACTOR, async (uow) => {
          const { evidenceId } = await fileObligationEvidence(uow, {
            instanceId,
            storageKey: `compliance/${instanceId}/${what}.pdf`,
            contentHash: (what === 'update' ? 'd' : 'e').repeat(64),
            uploadedByLabel: 'M-VAT-10 itest',
          })
          await mutate(uow, evidenceId)
        }),
      ).rejects.toThrow(/append-only/)
    }

    // Nothing was filed, so nothing is protected: the occurrence is still deletable in `afterAll`.
    const [remaining] = await sql<{ n: string }[]>`
      select count(*)::text as n from obligation_evidence
       where obligation_instance_id = ${instanceId}::uuid
    `
    expect(Number((remaining as { n: string }).n)).toBe(0)
  })
})

describe('the blocking flag has no settings writer', () => {
  it('no declared setting key reaches it, and an invented one is refused as undeclared', () => {
    // The registry is the whole vocabulary of things a settings screen can write, so this is an
    // enumeration of every writable key rather than a search for a name somebody might have used.
    const touching = SETTINGS.filter((setting) =>
      /obligation|blocking|compliance_calendar/i.test(setting.key),
    )
    expect(touching.map((setting) => setting.key)).toEqual([])

    // And the key a future screen would reach for does not exist — `writeSetting` reads the definition
    // first, so an undeclared key cannot be written at all.
    expect(() => getDefinition('compliance.obligation_blocking_enabled')).toThrow()
    // The control: a key that IS declared resolves, so the throw above is about this key rather than
    // about `getDefinition` throwing for everything.
    expect(getDefinition('booking.cancellation_window_hours').key).toBe(
      'booking.cancellation_window_hours',
    )
  })

  it('the database refuses to change the flag, the consequence or the class', async () => {
    // GENERATED: there is no writer at all for the flag itself.
    await expect(
      sql`update obligation set is_blocking = false where key = ${LICENCE_KEY}`,
    ).rejects.toThrow(/can only be updated to DEFAULT/)

    // And the indirect route — changing what the flag is generated FROM — is refused for every role,
    // including the owner this connection runs as.
    await expect(
      sql`update obligation set blocking_effect = 'none' where key = ${LICENCE_KEY}`,
    ).rejects.toThrow(/ObligationShapeIsNotConfigurable/)
    await expect(
      sql`update obligation set obligation_class = 'hygiene' where key = ${LICENCE_KEY}`,
    ).rejects.toThrow(/ObligationShapeIsNotConfigurable/)
    // Nor the owner role or the evidence requirement: the due date is the ONLY thing that may change.
    await expect(
      sql`update obligation set owner_role = 'receptionist' where key = ${LICENCE_KEY}`,
    ).rejects.toThrow(/ObligationShapeIsNotConfigurable/)

    const [row] = await sql<{ blocking_effect: string; is_blocking: boolean }[]>`
      select blocking_effect, is_blocking from obligation where key = ${LICENCE_KEY}
    `
    expect(row).toEqual({ blocking_effect: 'publishing_blocked', is_blocking: true })
  })

  it('the due date changes, and the change writes an audit_event', async () => {
    const action = 'compliance.obligation.due_date_changed'
    const before = await auditRowsFor(action)

    const { previousAnchorOn } = await withUnitOfWork(sql, ACTOR, (uow) =>
      setObligationAnchorDate(uow, {
        key: LICENCE_KEY,
        anchorOn: '2096-06-30',
        reason: 'M-VAT-10 itest: the renewal date read off the licence',
      }),
    )
    expect(previousAnchorOn).toBeNull()

    const [after] = await sql<{ anchor_on: string }[]>`
      select anchor_on::text as anchor_on from obligation where key = ${LICENCE_KEY}
    `
    expect((after as { anchor_on: string }).anchor_on).toBe('2096-06-30')
    // A DELTA, counted in SQL: `audit_event` is append-only and only ever grows (ADR 0008).
    expect(await auditRowsFor(action)).toBe(before + 1)

    const [recorded] = await sql<{ before_state: unknown; after_state: unknown }[]>`
      select before_state, after_state from audit_event
       where action = ${action} and entity_id = ${LICENCE_KEY}
       order by occurred_at desc limit 1
    `
    expect((recorded as { after_state: { anchorOn: string; reason: string } }).after_state).toEqual(
      {
        anchorOn: '2096-06-30',
        reason: 'M-VAT-10 itest: the renewal date read off the licence',
      },
    )

    // A due-date change with no reason is refused: the audit row exists so an inspection can be
    // answered, and "updated" answers nothing.
    await expect(
      withUnitOfWork(sql, ACTOR, (uow) =>
        setObligationAnchorDate(uow, { key: LICENCE_KEY, anchorOn: '2096-07-01', reason: '  ' }),
      ),
    ).rejects.toThrow(/reason/)

    // Put it back, so the seeded row leaves this file as it arrived: no invented renewal date.
    await withUnitOfWork(sql, ACTOR, (uow) =>
      setObligationAnchorDate(uow, {
        key: LICENCE_KEY,
        anchorOn: null,
        reason: 'M-VAT-10 itest: restoring the unanswered state',
      }),
    )
    const [restored] = await sql<{ anchor_on: string | null }[]>`
      select anchor_on::text as anchor_on from obligation where key = ${LICENCE_KEY}
    `
    expect((restored as { anchor_on: string | null }).anchor_on).toBeNull()
  })
})

describe('the publishing consequence reads the same rows', () => {
  it('an overdue licence obligation is returned to the publish guard, and a completed one is not', async () => {
    await generateObligationInstances(sql, [{ obligationKey: LICENCE_KEY, dueOn: '2095-01-01' }])
    const blocking = await readObligationInstances(sql, { blockingOnly: true, keys: [LICENCE_KEY] })
    const overdue = blocking.find((row) => row.dueOn === '2095-01-01')
    expect(overdue?.blockingEffect).toBe('publishing_blocked')
    expect(overdue?.status).toBe('open')
    // The refusal itself — `PublishingBlocked` naming the obligation — is `@berelax/core`'s and is
    // asserted against these rows in packages/fixtures/src/obligation-calendar.itest.ts, because this
    // package may not import that one.

    // The control: `blockingOnly` really narrows. A non-blocking obligation is absent from the same read.
    await generateObligationInstances(sql, [
      { obligationKey: 'vat_return_filing', dueOn: '2095-01-01' },
    ])
    const everything = await readObligationInstances(sql, {
      keys: [LICENCE_KEY, 'vat_return_filing'],
    })
    const blockingOnly = await readObligationInstances(sql, {
      keys: [LICENCE_KEY, 'vat_return_filing'],
      blockingOnly: true,
    })
    expect(everything.map((row) => row.obligationKey)).toContain('vat_return_filing')
    expect(blockingOnly.map((row) => row.obligationKey)).not.toContain('vat_return_filing')
    await sql`
      delete from obligation_instance
       where due_on = '2095-01-01'
         and obligation_id = (select id from obligation where key = 'vat_return_filing')
    `
  })

  it('refuses a plan naming an obligation this database does not define', async () => {
    // The permissive version drops the row on the join and generates nothing — and a blocking
    // obligation with no occurrence never blocks, which is a compliance control that is missing rather
    // than failing.
    await expect(
      generateObligationInstances(sql, [
        { obligationKey: 'mvat10_not_defined', dueOn: '2096-01-01' },
      ]),
    ).rejects.toThrow(/mvat10_not_defined/)
  })
})
