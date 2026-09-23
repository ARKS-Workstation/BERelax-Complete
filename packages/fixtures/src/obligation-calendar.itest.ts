import {
  assertPublishingNotBlocked,
  complianceAsOfDate,
  fixedClock,
  type HoursForDate,
  localDate,
  localTime,
  type ObligationDefinition,
  type ObligationInstanceFacts,
  obligationInstancePlan,
  PublishingBlocked,
  publishingBlockedObligationsOf,
  ROLES,
  type TradingHours,
  therapistsBlockedByObligations,
} from '@berelax/core'
import {
  createConnection,
  generateObligationInstances,
  type ObligationDefinitionRow,
  type ObligationInstanceRow,
  OVERDUE_BLOCKING_OBLIGATION_REASON,
  overdueBlockingObligationExclusion,
  readMandatoryDocumentTypes,
  readObligationDefinitions,
  readObligationInstances,
  rescheduleObligationInstance,
  type Sql,
  setObligationAnchorDate,
  therapistPoolCtes,
  withUnitOfWork,
} from '@berelax/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * M-VAT-10 — the two halves of the compliance calendar, joined.
 *
 * The **rule** is pure and lives in `@berelax/core` (`compliance/obligation.ts`): which dates a cadence
 * falls due on, what counts as overdue against a trading date, and which consequence a breach carries.
 * The **rows** live in PostgreSQL and are read and written by `@berelax/db`. Neither package may import
 * the other — `packages/db` must never import `packages/core` — so nothing but `@berelax/fixtures` can
 * assert that the pair works, and the pair is the whole claim of the unit:
 *
 *   1. the db row shape **is** the port, asserted with `satisfies` rather than by a comment, so a field
 *      one side drops fails `pnpm typecheck` and not a booking;
 *   2. generation over the next 12 months is **deterministic**: two runs under the same frozen clock
 *      produce identical rows, compared row by row including ids and creation instants, because the
 *      second run inserts nothing at all;
 *   3. the two implementations of "who is blocked" **agree**: the pure rule over rows read from the
 *      database, and the SQL exclusion composed into the availability read;
 *   4. the publish path refuses with **`PublishingBlocked` naming the obligation**, driven by real rows;
 *   5. the role vocabulary duplicated in the schema is pinned to `ROLES`, parsed out of `pg_constraint`.
 *
 * ## Isolation
 *
 * The integration suite runs sequentially against ONE database and earlier files leave rows behind. The
 * trading date 2095-05-20 is used by no other suite; every employee carries {@link MARKER}; the pool read
 * narrows `employeeIds` to this file's two therapists; and the seeded obligations' due dates are set
 * through the audited writer and **restored to NULL** in `afterAll`, because a seeded obligation carrying
 * an invented renewal date is exactly what migration 0052 refuses to ship.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

const MARKER = 'mvat10 calendar itest'
const TRADING_DATE = '2095-05-20'
const NEXT_DAY = '2095-05-21'
/** 11:00–02:00, the real hours (docs/13 §2). */
const HOURS: TradingHours = { open: localTime('11:00'), close: localTime('02:00') }
const HOURS_FOR: HoursForDate = () => HOURS
/**
 * 01:30 on the 21st, which is the **20th's** trading date.
 *
 * The frozen clock the determinism claim is made under, and the boundary the business-day rule turns on:
 * an obligation due on the 20th is not overdue at this instant, because the salon is still working the
 * 20th. `resolveTradingDate` is the one implementation of that and `complianceAsOfDate` is how the
 * calendar consults it.
 */
const CLOCK = fixedClock('2095-05-20T21:30:00Z')

const LICENCE_KEY = 'trade_licence_renewal'
const CREDENTIAL_KEY = 'therapist_health_certificate_renewal'
const HYGIENE_KEY = 'hygiene_inspection_log_review'
/** The three whose due dates this file sets, and restores. */
const ANCHORED = [LICENCE_KEY, CREDENTIAL_KEY, HYGIENE_KEY] as const

/**
 * The dates this file writes occurrences on, and nothing else does.
 *
 * Every due date below — the horizon's, the overdue ones, the corrected one — falls inside this window,
 * and `obligation-blocking.itest.ts` deliberately dates its own undeletable rows decades outside it. That
 * is what lets this file clean up after itself without reaching another suite's rows.
 */
const WINDOW_FROM = '2094-01-01'
const WINDOW_UNTIL = '2098-01-01'

const ACTOR = { kind: 'staff', label: 'M-VAT-10 calendar itest' } as const

let sql: Sql
const staff: string[] = []

/**
 * The db row, as the port sees it.
 *
 * `satisfies` and not a cast: if `ObligationDefinitionRow` loses a field `ObligationDefinition` declares,
 * or the port gains one the row does not carry, this function fails `pnpm typecheck` rather than a test.
 * It is the drift guard the boundary rule makes necessary, and it is the same field copy `asPool` is in
 * `therapist-eligibility.itest.ts`.
 *
 * `ownerRole` is the one field that is narrowed rather than copied: the row types it as a `string`,
 * because `packages/db` cannot import `ROLES`, and the CHECK constraint that really constrains it is
 * pinned to `ROLES` by the case below. Narrowing here without that assertion would be a cast wearing a
 * function's clothes.
 */
const asDefinition = (row: ObligationDefinitionRow): ObligationDefinition => {
  const ownerRole = ROLES.find((role) => role === row.ownerRole)
  if (ownerRole === undefined) {
    throw new Error(`obligation ${row.key} names a role that is not in ROLES: ${row.ownerRole}`)
  }
  return {
    key: row.key,
    title: row.title,
    obligationClass: row.obligationClass,
    cadence: row.cadence,
    subjectScope: row.subjectScope,
    ownerRole,
    blockingEffect: row.blockingEffect,
    evidenceRequired: row.evidenceRequired,
    isUnverified: row.isUnverified,
    ...(row.anchorOn === undefined ? {} : { anchorOn: localDate(row.anchorOn) }),
    ...(row.openQuestionId === undefined ? {} : { openQuestionId: row.openQuestionId }),
  } satisfies ObligationDefinition
}

/** The same copy for an occurrence. The brand on `dueOn` is applied on this side of the boundary. */
const asFacts = (row: ObligationInstanceRow): ObligationInstanceFacts =>
  ({
    instanceId: row.instanceId,
    obligationKey: row.obligationKey,
    title: row.title,
    obligationClass: row.obligationClass,
    blockingEffect: row.blockingEffect,
    dueOn: localDate(row.dueOn),
    status: row.status,
    ...(row.subjectEmployeeId === undefined ? {} : { subjectEmployeeId: row.subjectEmployeeId }),
  }) satisfies ObligationInstanceFacts

/**
 * The rows of the horizon, whole: ids and creation instants included.
 *
 * Narrowed to due dates at or after the horizon's start, which is this file's isolation and not a
 * convenience. `obligation-blocking.itest.ts` completes occurrences of the same hygiene obligation WITH
 * evidence, and those cannot be deleted by anybody — `obligation_evidence` is append-only and the
 * occurrence beneath one is ON DELETE RESTRICT — so a reader that took every occurrence of these three
 * keys would count another suite's permanent rows and the determinism comparison would fail on a number
 * rather than on a difference. That file dates them decades earlier for exactly this reason.
 */
async function occurrenceRows(): Promise<readonly Record<string, unknown>[]> {
  return sql<Record<string, unknown>[]>`
    select i.id::text as id, o.key, i.subject_employee_id::text as subject, i.due_on::text as due_on,
           i.status::text as status, i.created_at, i.updated_at
      from obligation_instance i
      join obligation o on o.id = i.obligation_id
     where o.key = any(${[...ANCHORED]}::text[])
       and i.due_on >= ${TRADING_DATE}::date
     order by o.key, i.subject_employee_id nulls first, i.due_on
  `
}

/**
 * Every occurrence this file wrote, removed.
 *
 * Bounded by {@link WINDOW_FROM}/{@link WINDOW_UNTIL} rather than by key alone, so it removes this
 * file's rows and cannot reach another suite's. Evidence-bearing occurrences are skipped, because
 * `obligation_evidence` is append-only (ZO004) and nothing may delete what was filed at the time.
 */
async function resetOccurrences(): Promise<void> {
  await sql`
    delete from obligation_instance i
     where i.obligation_id in (select id from obligation where key = any(${[...ANCHORED]}::text[]))
       and i.due_on >= ${WINDOW_FROM}::date
       and i.due_on < ${WINDOW_UNTIL}::date
       and not exists (select 1 from obligation_evidence e where e.obligation_instance_id = i.id)
  `
}

async function setAnchor(key: string, anchorOn: string | null): Promise<void> {
  await withUnitOfWork(sql, ACTOR, (uow) =>
    setObligationAnchorDate(uow, {
      key,
      anchorOn,
      reason: 'M-VAT-10 calendar itest: the due date the horizon is generated from',
    }),
  )
}

/** The literals a CHECK constraint accepts, read out of its own definition in the catalogue. */
async function checkVocabulary(table: string, constraint: string): Promise<readonly string[]> {
  const [row] = await sql<{ definition: string }[]>`
    select pg_get_constraintdef(c.oid) as definition
      from pg_constraint c join pg_class t on t.oid = c.conrelid
     where t.relname = ${table} and c.conname = ${constraint}
  `
  const definition = row?.definition
  if (definition === undefined) throw new Error(`no constraint ${constraint} on ${table}`)
  return [...definition.matchAll(/'([a-z_]+)'::text/g)].map((match) => match[1] as string).sort()
}

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })

  await sql`
    insert into business_day (trading_date, opens_at, closes_at, source)
    values (${TRADING_DATE}, ${`${TRADING_DATE} 11:00:00+04`}::timestamptz,
            ${`${NEXT_DAY} 02:00:00+04`}::timestamptz, 'weekly')
    on conflict (trading_date) do nothing
  `

  for (const reference of ['mvat10cal-a', 'mvat10cal-b'] as const) {
    const [row] = await sql<{ id: string }[]>`
      insert into employee (staff_reference, gender, employed_from, notes)
      values (${reference}, 'female', '2095-01-01', ${MARKER})
      on conflict (staff_reference) do update set notes = excluded.notes
      returning id
    `
    const id = (row as { id: string }).id
    staff.push(id)
    await sql`
      insert into employee_skill (employee_id, skill) values (${id}, 'asian_style')
      on conflict do nothing
    `
    // The mandatory set IN FORCE, not a hard-coded pair: migration 0058 reconciled the row with the
    // column DEFAULT (docs/01 decision 20's six), and a fixture naming two of them stops meaning "holds
    // every mandatory document" the moment that answer changes (0054's header, brief rule 12).
    for (const documentType of await readMandatoryDocumentTypes(sql)) {
      await sql`
        insert into employee_document (employee_id, document_type, expires_on)
        values (${id}, ${documentType}::employee_document_type, '2099-12-31')
        on conflict do nothing
      `
    }
  }
  const [shift] = await sql<{ id: string }[]>`
    insert into shift (trading_date, period, label)
    values (${TRADING_DATE},
            ${`[${TRADING_DATE} 11:00:00+04,${NEXT_DAY} 02:00:00+04)`}::tstzrange, ${MARKER})
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
  await resetOccurrences()
  // The seeded rows leave this file exactly as they arrived: no renewal date. A seeded obligation
  // carrying an invented one is what 0052 refuses to ship, and a test that left one behind would have
  // put it there.
  for (const key of ANCHORED) await setAnchor(key, null)
  await sql`delete from shift_assignment where employee_id = any(${staff}::uuid[])`
  await sql`delete from shift where label = ${MARKER}`
  await sql`delete from employee_document where employee_id = any(${staff}::uuid[])`
  await sql`delete from employee_skill where employee_id = any(${staff}::uuid[])`
  await sql`delete from employee where notes = ${MARKER}`
  await sql`delete from availability_epoch where trading_date = ${TRADING_DATE}`
  await sql`delete from business_day where trading_date = ${TRADING_DATE}`
  await sql?.end({ timeout: 5 })
})

describe('the row shape is the port', () => {
  it('reads every seeded definition through the port type, and pins the role vocabulary to ROLES', async () => {
    const rows = await readObligationDefinitions(sql)
    const definitions = rows.map(asDefinition)
    expect(definitions.length).toBe(rows.length)
    expect(definitions.some((definition) => definition.key === LICENCE_KEY)).toBe(true)

    // The duplication the boundary forces — a CHECK constraint restating `ROLES` because the database
    // cannot import the policy layer — pinned in BOTH directions. A role added to `ROLES` and not to the
    // constraint is an obligation nobody can own; one added to the constraint and not to `ROLES` is an
    // owner the authorisation layer has never heard of.
    for (const [table, constraint] of [
      ['obligation', 'obligation_owner_role_known'],
      ['obligation_instance', 'obligation_instance_completed_by_role_known'],
    ] as const) {
      expect(await checkVocabulary(table, constraint)).toEqual([...ROLES].sort())
    }
  })

  it('and no seeded obligation generates anything until somebody enters a due date', async () => {
    const definitions = (await readObligationDefinitions(sql)).map(asDefinition)
    const from = complianceAsOfDate(CLOCK.now(), HOURS_FOR)
    // Every seeded row has `anchorOn` absent (0052 seeds no dates), so the plan is empty — which is the
    // honest behaviour: a calendar of invented renewal dates is worse than an empty one.
    const seeded = definitions.filter((definition) => !definition.key.startsWith('mvat10'))
    expect(seeded.every((definition) => definition.anchorOn === undefined)).toBe(true)
    expect(
      obligationInstancePlan({ definitions: seeded, from, months: 12, therapistIds: staff }),
    ).toEqual([])
  })
})

describe('generation over the next 12 months is deterministic', () => {
  it('two runs under the frozen clock produce identical rows', async () => {
    // The clock is frozen at 01:30 on the 21st, which is the 20th's trading date — so the horizon starts
    // on the 20th and not on the calendar date. That is the business-day rule reaching the generator.
    const from = complianceAsOfDate(CLOCK.now(), HOURS_FOR)
    expect(from).toBe(TRADING_DATE)

    await setAnchor(LICENCE_KEY, '2095-06-30')
    await setAnchor(CREDENTIAL_KEY, '2095-07-15')
    await setAnchor(HYGIENE_KEY, '2095-05-31')

    const definitions = (await readObligationDefinitions(sql))
      .map(asDefinition)
      .filter((definition) => (ANCHORED as readonly string[]).includes(definition.key))
    const plan = obligationInstancePlan({ definitions, from, months: 12, therapistIds: staff })
    // 1 annual licence + 1 annual credential per therapist (2) + 12 monthly hygiene = 15.
    expect(plan).toHaveLength(15)

    const first = await generateObligationInstances(sql, [...plan])
    expect(first).toEqual({ planned: 15, inserted: 15 })
    const afterFirst = await occurrenceRows()

    // The SECOND run. The plan is recomputed from the same clock, so this is the whole pipeline twice
    // rather than one insert repeated.
    const replan = obligationInstancePlan({ definitions, from, months: 12, therapistIds: staff })
    expect(replan).toEqual(plan)
    const second = await generateObligationInstances(sql, [...replan])
    expect(second).toEqual({ planned: 15, inserted: 0 })
    const afterSecond = await occurrenceRows()

    // Row for row, INCLUDING the ids and the creation instants — which is a stronger claim than a
    // projection comparison and is only true because the second run inserted nothing.
    expect(afterSecond).toEqual(afterFirst)
    expect(afterSecond).toHaveLength(15)

    // The control. Without it, "two runs are identical" would pass against a generator that wrote
    // nothing: a longer horizon must write MORE rows, and the extra ones must be dated beyond the first
    // horizon's end.
    const longer = obligationInstancePlan({ definitions, from, months: 24, therapistIds: staff })
    expect(longer.length).toBeGreaterThan(plan.length)
    const third = await generateObligationInstances(sql, [...longer])
    expect(third.inserted).toBeGreaterThan(0)
    const afterLonger = await occurrenceRows()
    expect(afterLonger.length).toBe(longer.length)
    // And the first horizon's rows are untouched by the second pass: the ids did not move.
    expect(afterLonger.filter((row) => afterFirst.some((was) => was['id'] === row['id']))).toEqual(
      afterFirst,
    )

    await resetOccurrences()
  })
})

describe('the two implementations of "who is blocked" agree', () => {
  it('the pure rule and the composed SQL exclusion name the same therapist', async () => {
    const from = complianceAsOfDate(CLOCK.now(), HOURS_FOR)
    const blockedTherapist = staff[0] as string
    const otherTherapist = staff[1] as string

    await generateObligationInstances(sql, [
      // Overdue: the day before the trading date.
      { obligationKey: CREDENTIAL_KEY, dueOn: '2095-05-19', subjectEmployeeId: blockedTherapist },
      // Due ON the trading date, which is not overdue on it — the boundary the rule turns on.
      { obligationKey: CREDENTIAL_KEY, dueOn: TRADING_DATE, subjectEmployeeId: otherTherapist },
    ])

    const facts = (
      await readObligationInstances(sql, {
        keys: [CREDENTIAL_KEY],
        subjectEmployeeIds: staff,
      })
    ).map(asFacts)
    const pure = therapistsBlockedByObligations(facts, from)
    expect([...pure]).toEqual([blockedTherapist])

    // The SQL half: the same question asked inside the availability read's own pool fragment.
    const ctes = therapistPoolCtes(sql, {
      tradingDate: TRADING_DATE,
      requiredSkill: 'asian_style',
      employeeIds: staff,
      exclusions: [overdueBlockingObligationExclusion(sql, { tradingDate: TRADING_DATE })],
    })
    const rows = await sql<{ employee_id: string; reason: string | null }[]>`
      with ${ctes}
      select employee_id::text as employee_id, reason from tp_pool order by employee_id
    `
    const bySql = rows
      // The constant, not a second spelling of the string: a reason typed out here would go on matching
      // nothing the day the exclusion renamed it, and the agreement would read as agreement.
      .filter((row) => row.reason === OVERDUE_BLOCKING_OBLIGATION_REASON)
      .map((row) => row.employee_id)
    expect(bySql).toEqual([...pure])
    // Not trivially empty on either side: the other therapist is in the pool with no reason at all.
    expect(rows.find((row) => row.employee_id === otherTherapist)?.reason).toBeNull()

    // And the control on the business-day rule, in both implementations at once: asked about the NEXT
    // trading date, the occurrence due on the 20th IS overdue and the second therapist is blocked too.
    const nextDayPure = therapistsBlockedByObligations(facts, localDate(NEXT_DAY))
    expect([...nextDayPure].sort()).toEqual([...staff].sort())

    await resetOccurrences()
  })
})

describe('the publish path', () => {
  it('refuses with PublishingBlocked naming the obligation, and allows it once the date is corrected', async () => {
    const from = complianceAsOfDate(CLOCK.now(), HOURS_FOR)
    await generateObligationInstances(sql, [
      { obligationKey: LICENCE_KEY, dueOn: '2094-11-30' },
      // Overdue and NOT blocking: the filing being late does not stop the site publishing.
      { obligationKey: HYGIENE_KEY, dueOn: '2094-11-30' },
    ])

    const blockers = (await readObligationInstances(sql, { blockingOnly: true })).map(asFacts)
    let caught: unknown
    try {
      assertPublishingNotBlocked(blockers, from)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(PublishingBlocked)
    expect((caught as PublishingBlocked).message).toContain(LICENCE_KEY)
    expect(publishingBlockedObligationsOf(caught)).toContain(LICENCE_KEY)
    // The hygiene review is overdue by a year and is not in the refusal: only a blocking LICENCE
    // obligation blocks publishing.
    expect(publishingBlockedObligationsOf(caught)).not.toContain(HYGIENE_KEY)

    // The correction: the renewal date is moved to the real one, through the audited writer, and the
    // publish path stops refusing. This is the control that stops the assertion above passing against a
    // guard that refuses everything.
    const [occurrence] = (await readObligationInstances(sql, { keys: [LICENCE_KEY] })).filter(
      (row) => row.dueOn === '2094-11-30',
    )
    await withUnitOfWork(sql, ACTOR, (uow) =>
      rescheduleObligationInstance(uow, {
        instanceId: (occurrence as ObligationInstanceRow).instanceId,
        dueOn: '2095-11-30',
        reason: 'M-VAT-10 calendar itest: the renewal date read off the licence',
      }),
    )
    const corrected = (await readObligationInstances(sql, { blockingOnly: true })).map(asFacts)
    expect(() => assertPublishingNotBlocked(corrected, from)).not.toThrow()

    await resetOccurrences()
  })
})
