import { breachNotificationDeadline, notificationWasTimely, ROLES } from '@berelax/core'
import {
  addIncidentAddendum,
  createConnection,
  fileIncident,
  incidentDuties,
  readBreachNotificationHours,
  recordIncidentNotification,
  type Sql,
  unconfirmedAssumptionRows,
  withUnitOfWork,
} from '@berelax/db'
import {
  BREACH_NOTIFICATION_HOURS_SETTING_KEY,
  BREACH_NOTIFICATION_OBLIGATION_KEY,
  BREACH_SUBJECT_NOTIFICATION_OBLIGATION_KEY,
  INCIDENT_FIELDS,
  INCIDENT_STRUCTURAL_COLUMNS,
  INCIDENT_TABLES,
  incidentFieldsFor,
} from '@berelax/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * H-HARD-07 — the incident register and the breach clock, against a real PostgreSQL.
 *
 * ## Why every refusal is asserted BY ITS CODE
 *
 * `packages/db` translates a refusal by its SQLSTATE alone, so a probe that only asserted "the
 * statement threw" would pass when the statement bounced off something else entirely — a NOT NULL, a
 * CHECK on a neighbouring column, a foreign key. ADR 0043 records thirteen codes that each stood for
 * two rules, all green. So each case here names the five characters.
 *
 * ## Why this file does not clean up `incident`
 *
 * It cannot: `incident`, `incident_addendum` and `incident_notification` all refuse DELETE, which is
 * the property under test. So every case uses a reference of its own carrying a per-run token, every
 * assertion is about rows this run created, and nothing counts a total. The `obligation_instance` rows
 * a filing creates cannot be deleted either while their incident survives — `incident_id` is
 * `on delete restrict` and the incident never goes — so the same rule applies to them.
 *
 * That is the honest shape rather than a workaround. A register that could be emptied between runs
 * would be a register, and the thing being proved is that it is not one.
 */
const DATABASE_URL = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? ''
if (DATABASE_URL === '') {
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')
}

/** Per-run, so two runs' references never collide on `incident.reference`'s unique index. */
const RUN = Math.random().toString(36).slice(2, 8).toUpperCase()
const ref = (suffix: string) => `INC-${RUN}-${suffix}`

const DISCOVERED = '2026-10-01T09:00:00.000Z'
const ACTOR = { kind: 'staff', label: `staff incident-${RUN}` } as const

let sql: Sql

beforeAll(() => {
  sql = createConnection({ url: DATABASE_URL, max: 4 })
})

afterAll(async () => {
  await sql.end({ timeout: 5 })
})

/** The code a refusal carried, or the message when it carried none. */
async function refusalCode(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
    return 'ACCEPTED'
  } catch (error) {
    const code = (error as { code?: unknown }).code
    return typeof code === 'string' ? code : `no code: ${(error as Error).message}`
  }
}

const BREACH = {
  personalDataCategories: ['contact details', 'appointment history'],
  dataSubjectsAffectedEstimate: 40,
  recordsAffectedEstimate: 220,
  likelyConsequences:
    'The people affected could receive unsolicited contact, and an appointment history discloses that ' +
    'somebody is a client of this business at all.',
  crossBorderTransfer: false,
} as const

const NON_BREACH = {
  incidentClass: 'client_injury',
  occurredAtIso: DISCOVERED,
  discoveredAtIso: DISCOVERED,
  recordedByRole: 'manager',
  recordedByLabel: `manager incident-${RUN}`,
  summary: 'A client slipped on a wet floor leaving the shower area and grazed an elbow.',
  location: 'Corridor outside the wet room',
  immediateAction: 'Floor dried and signed, first-aid kit used, client offered a taxi home.',
  peopleAffectedCount: 1,
  injuryReported: true,
  emergencyServicesAttended: false,
  claimAnticipated: true,
} as const

/** Files a breach with its two duties dated from the discovery, which is what the schema requires. */
async function fileBreach(
  reference: string,
  discoveredAtIso: string,
): Promise<{
  readonly incidentId: string
  readonly dueOn: string
  readonly deadlineAtIso: string
}> {
  const periodHours = await readBreachNotificationHours(sql)
  const clock = breachNotificationDeadline({ discoveredAtIso, periodHours })
  const filed = await withUnitOfWork(sql, ACTOR, (uow) =>
    fileIncident(uow, {
      reference,
      incidentClass: 'personal_data_breach',
      occurredAtIso: null,
      discoveredAtIso,
      recordedByRole: 'owner',
      recordedByLabel: `owner incident-${RUN}`,
      summary:
        'An export of the client list was taken to a personal device and could not be accounted for.',
      location: 'Reception terminal',
      immediateAction:
        'The staff credential was revoked and the export was traced in the audit trail.',
      peopleAffectedCount: BREACH.dataSubjectsAffectedEstimate,
      injuryReported: false,
      emergencyServicesAttended: false,
      claimAnticipated: false,
      breach: BREACH,
      duties: [
        { obligationKey: BREACH_NOTIFICATION_OBLIGATION_KEY, dueOn: clock.dueOn },
        { obligationKey: BREACH_SUBJECT_NOTIFICATION_OBLIGATION_KEY, dueOn: clock.dueOn },
      ],
    }),
  )
  expect(filed.obligationInstanceIds).toHaveLength(2)
  return { incidentId: filed.incidentId, dueOn: clock.dueOn, deadlineAtIso: clock.deadlineAtIso }
}

describe('a filed incident is immutable, and an addendum is the only way to add to it', () => {
  it('refuses UPDATE and DELETE by ZY521, and accepts the addendum that replaces them', async () => {
    const reference = ref('IMM')
    const filed = await withUnitOfWork(sql, ACTOR, (uow) =>
      fileIncident(uow, { ...NON_BREACH, reference }),
    )

    // Both events, because the half-written pair — one trigger copied for the other event with the
    // word not changed — is where this defect always hides, and the table's comment claims both.
    expect(
      await refusalCode(
        () => sql`update incident set summary = 'reworded' where id = ${filed.incidentId}::uuid`,
      ),
    ).toBe('ZY521')
    expect(
      await refusalCode(() => sql`delete from incident where id = ${filed.incidentId}::uuid`),
    ).toBe('ZY521')

    // The control, and it is what makes the two refusals mean something: the register is not simply
    // unwritable. New information goes in as a row with its own instant and its own actor.
    const addendum = await withUnitOfWork(sql, ACTOR, (uow) =>
      addIncidentAddendum(uow, {
        incidentId: filed.incidentId,
        addedAtIso: '2026-10-03T11:00:00.000Z',
        addedByRole: 'manager',
        addedByLabel: `manager incident-${RUN}`,
        body: 'The client telephoned to say they had seen a doctor and needed no further treatment.',
        correctsField: null,
      }),
    )
    expect(addendum.addendumId).toMatch(/^[0-9a-f-]{36}$/)

    // And the addendum itself cannot be rewritten: a correction to a correction is another addendum.
    expect(
      await refusalCode(
        () =>
          sql`update incident_addendum set body = 'reworded' where id = ${addendum.addendumId}::uuid`,
      ),
    ).toBe('ZY522')
    expect(
      await refusalCode(
        () => sql`delete from incident_addendum where id = ${addendum.addendumId}::uuid`,
      ),
    ).toBe('ZY522')
  })

  it('refuses a write to either GENERATED column, so no flag can disagree with what it describes', async () => {
    const reference = ref('GEN')
    await withUnitOfWork(sql, ACTOR, (uow) => fileIncident(uow, { ...NON_BREACH, reference }))
    // Not ZY521: a GENERATED column has no writer at all, so PostgreSQL refuses the statement before
    // any trigger runs (428C9). Asserted as its own code rather than folded in with the trigger,
    // because the two are different guarantees and a test that accepted either would not notice the
    // column becoming ordinary.
    expect(
      await refusalCode(
        () => sql`update incident set occurrence_known = false where reference = ${reference}`,
      ),
    ).toBe('428C9')
  })
})

describe('the breach clock starts at the discovery', () => {
  it('dates both duties from discovered_at and NOT from the filing', async () => {
    // Discovered on the 1st, filed now. If the deadline came from the filing it would be about today.
    const filed = await fileBreach(ref('CLOCK'), DISCOVERED)
    const periodHours = await readBreachNotificationHours(sql)
    const expected = breachNotificationDeadline({ discoveredAtIso: DISCOVERED, periodHours })

    const duties = await incidentDuties(sql, filed.incidentId)
    expect(duties.map((d) => d.obligationKey).sort()).toEqual(
      [BREACH_NOTIFICATION_OBLIGATION_KEY, BREACH_SUBJECT_NOTIFICATION_OBLIGATION_KEY].sort(),
    )
    for (const duty of duties) {
      expect(duty.dueOn, duty.obligationKey).toBe(expected.dueOn)
      expect(duty.status).toBe('open')
      expect(duty.notifiedAt).toBeNull()
    }

    // The control that makes the claim above about the DISCOVERY rather than about any date at all: a
    // deadline computed from the filing instant would land on a different day, and the test would pass
    // either way without it.
    // The Date `postgres.js` maps a timestamptz to, not `::text`. The text cast renders
    // `2026-10-01 09:00:00+00`, which `new Date` refuses — and the symptom was `RangeError: Invalid
    // time value` several lines later, which names neither the cast nor the column.
    const [row] = await sql<{ filedAt: Date }[]>`
      select filed_at as "filedAt" from incident where id = ${filed.incidentId}::uuid
    `
    if (row === undefined) throw new Error('the incident this case just filed was not found')
    const fromFiling = breachNotificationDeadline({
      discoveredAtIso: row.filedAt.toISOString(),
      periodHours,
    })
    expect(fromFiling.dueOn).not.toBe(expected.dueOn)
  })

  it('refuses a transaction that files a breach and dates nothing, by ZY524 at COMMIT', async () => {
    // The acceptance line as a schema rule rather than as this module's diligence. `duties` omitted
    // entirely, which is what a second writer added later would do by accident.
    const code = await refusalCode(() =>
      withUnitOfWork(sql, ACTOR, (uow) =>
        fileIncident(uow, {
          reference: ref('NODUTY'),
          incidentClass: 'personal_data_breach',
          occurredAtIso: null,
          discoveredAtIso: DISCOVERED,
          recordedByRole: 'owner',
          recordedByLabel: `owner incident-${RUN}`,
          summary: 'A breach filed without dating its notification duties.',
          location: 'Reception terminal',
          immediateAction: 'None yet.',
          peopleAffectedCount: 1,
          injuryReported: false,
          emergencyServicesAttended: false,
          claimAnticipated: false,
          breach: BREACH,
        }),
      ),
    )
    expect(code).toBe('ZY524')

    // And it really was refused at commit rather than merely reported: nothing survives.
    const [left] = await sql<{ n: string }[]>`
      select count(*)::text as n from incident where reference = ${ref('NODUTY')}
    `
    expect(Number(left?.n ?? -1)).toBe(0)
  })

  it('refuses a notification that predates the discovery it answers, by ZY525', async () => {
    const filed = await fileBreach(ref('EARLY'), DISCOVERED)
    const before = '2026-09-30T09:00:00.000Z'
    expect(
      await refusalCode(() =>
        withUnitOfWork(sql, ACTOR, (uow) =>
          recordIncidentNotification(uow, {
            incidentId: filed.incidentId,
            party: 'supervisory_authority',
            notifiedAtIso: before,
            notifiedByRole: 'owner',
            notifiedByLabel: `owner incident-${RUN}`,
            channel: 'Submitted through the authority portal',
            contentSummary: 'The categories of data, the estimate and the measures taken.',
          }),
        ),
      ),
    ).toBe('ZY525')
  })

  it('records a notification, answers whether it was timely ON THE INSTANT, and cannot be rewritten', async () => {
    const filed = await fileBreach(ref('NOTIFY'), DISCOVERED)
    // One hour before the deadline. Deliberately on the SAME civil day as the deadline, which is what
    // makes the instant-versus-date distinction visible: a date comparison cannot tell this apart from
    // a notification fourteen hours later, and one of the two is late.
    const inTime = new Date(Date.parse(filed.deadlineAtIso) - 3_600_000).toISOString()
    const recorded = await withUnitOfWork(sql, ACTOR, (uow) =>
      recordIncidentNotification(uow, {
        incidentId: filed.incidentId,
        party: 'supervisory_authority',
        notifiedAtIso: inTime,
        notifiedByRole: 'owner',
        notifiedByLabel: `owner incident-${RUN}`,
        channel: 'Submitted through the authority portal',
        contentSummary:
          'The categories of data, the estimate, the consequences and the measures taken.',
      }),
    )

    const duties = await incidentDuties(sql, filed.incidentId)
    const authority = duties.find((d) => d.obligationKey === BREACH_NOTIFICATION_OBLIGATION_KEY)
    expect(authority?.notifiedAt).not.toBeNull()
    expect(
      notificationWasTimely({
        deadlineAtIso: filed.deadlineAtIso,
        // Already ISO with a Z: `incidentDuties` formats it, so no caller has to know the format.
        notifiedAtIso: authority?.notifiedAt ?? null,
      }),
    ).toBe('timely')

    // Same civil date, thirteen hours later: LATE. The control for the sentence above — a comparison
    // done on dates answers 'timely' for both, and that is the answer a regulator would not accept.
    const late = new Date(Date.parse(filed.deadlineAtIso) + 12 * 3_600_000).toISOString()
    expect(late.slice(0, 10)).toBe(filed.deadlineAtIso.slice(0, 10))
    expect(notificationWasTimely({ deadlineAtIso: filed.deadlineAtIso, notifiedAtIso: late })).toBe(
      'late',
    )

    // The duty whose instance has no notification answers `unknown`, not `late`: "we cannot tell" and
    // "it was late" are different findings and the second is an accusation.
    const subjects = duties.find(
      (d) => d.obligationKey === BREACH_SUBJECT_NOTIFICATION_OBLIGATION_KEY,
    )
    expect(subjects?.notifiedAt).toBeNull()
    expect(notificationWasTimely({ deadlineAtIso: filed.deadlineAtIso, notifiedAtIso: null })).toBe(
      'unknown',
    )

    expect(
      await refusalCode(
        () =>
          sql`update incident_notification set notified_at = ${DISCOVERED}::timestamptz
               where id = ${recorded.notificationId}::uuid`,
      ),
    ).toBe('ZY523')
    expect(
      await refusalCode(
        () => sql`delete from incident_notification where id = ${recorded.notificationId}::uuid`,
      ),
    ).toBe('ZY523')
  })

  it('gives two breaches discovered on the same day two duties each, never one shared', async () => {
    // Why `incident_id` had to join `obligation_instance_one_per_due_date`. Without it the second
    // filing's insert would conflict with the first's instance on (obligation, subject, due_on), and
    // completing one notification would mark the other breach's duty done.
    const first = await fileBreach(ref('TWIN1'), DISCOVERED)
    const second = await fileBreach(ref('TWIN2'), DISCOVERED)
    expect(second.dueOn).toBe(first.dueOn)
    const a = await incidentDuties(sql, first.incidentId)
    const b = await incidentDuties(sql, second.incidentId)
    expect(a).toHaveLength(2)
    expect(b).toHaveLength(2)
    const [ids] = await sql<{ n: string }[]>`
      select count(distinct id)::text as n from obligation_instance
       where incident_id in (${first.incidentId}::uuid, ${second.incidentId}::uuid)
    `
    expect(Number(ids?.n ?? 0)).toBe(4)
  })
})

describe('the breach fields belong to the breach class and to nothing else', () => {
  it('refuses breach fields on an incident that is not a breach', async () => {
    const code = await refusalCode(
      () => sql`
        insert into incident (
          reference, incident_class, discovered_at, recorded_by_role, recorded_by_label,
          summary, location, immediate_action, people_affected_count, injury_reported,
          emergency_services_attended, claim_anticipated,
          personal_data_categories, data_subjects_affected_estimate, records_affected_estimate,
          likely_consequences, cross_border_transfer
        ) values (
          ${ref('WRONGCLASS')}, 'equipment_failure', ${DISCOVERED}::timestamptz, 'manager',
          'manager fixture', 'A massage table leg sheared.', 'Room 3', 'Room taken out of use.',
          0, false, false, false,
          array['contact details'], 1, 1, 'None.', false
        )
      `,
    )
    expect(code).toBe('23514')
  })

  it('refuses a breach with the regulator fields missing, and an empty category list', async () => {
    const missing = await refusalCode(
      () => sql`
        insert into incident (
          reference, incident_class, discovered_at, recorded_by_role, recorded_by_label,
          summary, location, immediate_action, people_affected_count, injury_reported,
          emergency_services_attended, claim_anticipated
        ) values (
          ${ref('NOFIELDS')}, 'personal_data_breach', ${DISCOVERED}::timestamptz, 'owner',
          'owner fixture', 'A breach with none of the regulator fields filled in.', 'Reception',
          'None yet.', 1, false, false, false
        )
      `,
    )
    expect(missing).toBe('23514')

    // And a category list that is present and empty is not a list. `' '` as well as `''`, which is
    // what `text_array_has_blank` trims for.
    for (const categories of [`array[]::text[]`, `array[' ']`]) {
      const code = await refusalCode(() =>
        sql.unsafe(`
          insert into incident (
            reference, incident_class, discovered_at, recorded_by_role, recorded_by_label,
            summary, location, immediate_action, people_affected_count, injury_reported,
            emergency_services_attended, claim_anticipated,
            personal_data_categories, data_subjects_affected_estimate, records_affected_estimate,
            likely_consequences, cross_border_transfer
          ) values (
            '${ref('EMPTYCAT')}', 'personal_data_breach', '${DISCOVERED}', 'owner',
            'owner fixture', 'A breach whose category list is empty.', 'Reception',
            'None yet.', 1, false, false, false,
            ${categories}, 1, 1, 'Unsolicited contact.', false
          )
        `),
      )
      expect(code, categories).toBe('23514')
    }
  })

  it('refuses a filing that predates its own discovery, and a discovery before the occurrence', async () => {
    expect(
      await refusalCode(
        () => sql`
          insert into incident (
            reference, incident_class, discovered_at, filed_at, recorded_by_role, recorded_by_label,
            summary, location, immediate_action, people_affected_count, injury_reported,
            emergency_services_attended, claim_anticipated
          ) values (
            ${ref('BACKWARDS')}, 'hygiene_failure', ${DISCOVERED}::timestamptz,
            ${DISCOVERED}::timestamptz - interval '1 day', 'manager', 'manager fixture',
            'A filing dated before the discovery it records.', 'Laundry', 'None.', 0, false, false, false
          )
        `,
      ),
    ).toBe('23514')
    expect(
      await refusalCode(
        () => sql`
          insert into incident (
            reference, incident_class, occurred_at, discovered_at, recorded_by_role,
            recorded_by_label, summary, location, immediate_action, people_affected_count,
            injury_reported, emergency_services_attended, claim_anticipated
          ) values (
            ${ref('PRESCIENT')}, 'hygiene_failure', ${DISCOVERED}::timestamptz + interval '1 day',
            ${DISCOVERED}::timestamptz, 'manager', 'manager fixture',
            'An event discovered before it happened.', 'Laundry', 'None.', 0, false, false, false
          )
        `,
      ),
    ).toBe('23514')
  })
})

describe("the schema's columns match the declared insurer and regulator field list", () => {
  it('holds the declared fields and the actual columns equal, in both directions, for all three tables', async () => {
    const rows = await sql<{ tableName: string; columnName: string }[]>`
      select table_name as "tableName", column_name as "columnName"
        from information_schema.columns
       where table_schema = 'public'
         and table_name in ('incident', 'incident_addendum', 'incident_notification')
    `
    // The floor (ADR 0002). A query returning nothing would make every set comparison below pass over
    // two empty sets, which is the green tick over zero modules said about a field list.
    expect(rows.length).toBeGreaterThan(20)

    for (const table of INCIDENT_TABLES) {
      const actual = rows
        .filter((r) => r.tableName === table)
        .map((r) => r.columnName)
        .filter((name) => !INCIDENT_STRUCTURAL_COLUMNS.includes(name))
        .sort()
      const declared = incidentFieldsFor(table)
        .map((f) => f.column)
        .sort()
      // Both directions in one assertion over sorted arrays: a field an insurer asks for that has no
      // column is a question somebody answers in an email at the worst possible moment, and a column
      // nobody asks for is a field that gets left blank and then gets dropped.
      expect(actual, `${table}: declared vs actual`).toEqual(declared)
      expect(declared.length).toBeGreaterThan(0)
    }
  })

  it('declares every structural column it excludes, and nothing that is not one', async () => {
    // Without this, the easiest way to satisfy the both-directions test above is to declare a column
    // structural — and nothing would say so. The exclusion list is therefore itself held to the
    // columns that really are keys or a row's own creation instant.
    const rows = await sql<{ columnName: string }[]>`
      select distinct column_name as "columnName"
        from information_schema.columns
       where table_schema = 'public'
         and table_name in ('incident', 'incident_addendum', 'incident_notification')
         and column_name = any(${[...INCIDENT_STRUCTURAL_COLUMNS]}::text[])
    `
    expect(rows.map((r) => r.columnName).sort()).toEqual([...INCIDENT_STRUCTURAL_COLUMNS].sort())
  })

  it('gives every declared field an audience and a reason somebody could disagree with', () => {
    for (const field of INCIDENT_FIELDS) {
      expect(['insurer', 'regulator', 'both'], field.column).toContain(field.askedBy)
      expect(field.why.length, field.column).toBeGreaterThan(40)
    }
    // Both readers are actually represented. A list where every field said `both` would satisfy the
    // shape and record nothing about who asks for what.
    const audiences = new Set(INCIDENT_FIELDS.map((f) => f.askedBy))
    expect(audiences.has('insurer')).toBe(true)
    expect(audiences.has('regulator')).toBe(true)
  })

  it('restricts corrects_field to a real incident column', async () => {
    const reference = ref('CORRECT')
    const filed = await withUnitOfWork(sql, ACTOR, (uow) =>
      fileIncident(uow, { ...NON_BREACH, reference }),
    )
    // The shape CHECK is what the migration enforces; that the name is a REAL column is this
    // assertion, because a foreign key into the catalogue is not available for a column name.
    const declared = new Set(INCIDENT_FIELDS.map((f) => f.column))
    const added = await withUnitOfWork(sql, ACTOR, (uow) =>
      addIncidentAddendum(uow, {
        incidentId: filed.incidentId,
        addedAtIso: '2026-10-04T08:00:00.000Z',
        addedByRole: 'owner',
        addedByLabel: `owner incident-${RUN}`,
        body: 'The estimated loss turned out to be higher than first recorded.',
        correctsField: 'estimated_loss_fils',
      }),
    )
    expect(added.addendumId).toMatch(/^[0-9a-f-]{36}$/)
    const [row] = await sql<{ correctsField: string | null }[]>`
      select corrects_field as "correctsField" from incident_addendum
       where id = ${added.addendumId}::uuid
    `
    expect(row?.correctsField).not.toBeNull()
    expect(declared.has(row?.correctsField ?? '')).toBe(true)

    // And the shape refuses something that could not be a column name at all.
    expect(
      await refusalCode(
        () => sql`
          insert into incident_addendum (incident_id, added_at, added_by_role, added_by_label, body,
                                         corrects_field)
          values (${filed.incidentId}::uuid, now(), 'owner', 'owner fixture',
                  'A correction naming nothing.', 'Estimated Loss')
        `,
      ),
    ).toBe('23514')
  })

  it("holds each table's role CHECK equal to the F07 role set, in both directions", async () => {
    // The migration says in a comment that a test parses these out of pg_constraint and holds them
    // equal to ROLES. This is that test — without it the comment is a claim about a test that does not
    // exist, and the duplicated role list is the thing it was written to make safe.
    const rows = await sql<{ name: string; definition: string }[]>`
      select conname as name, pg_get_constraintdef(oid) as definition
        from pg_constraint
       where conname in ('incident_recorded_by_role_known', 'incident_addendum_role_known',
                         'incident_notification_role_known')
    `
    expect(rows).toHaveLength(3)
    for (const row of rows) {
      const accepted = [...row.definition.matchAll(/'([a-z_]+)'::text/g)]
        .map((m) => m[1])
        .filter((name): name is string => name !== undefined)
      expect(new Set(accepted), row.name).toEqual(new Set(ROLES))
    }
  })
})

describe('the 72-hour deadline is provisional and says so where assumptions are read', () => {
  it('is a provisional setting and appears in the Unconfirmed Assumptions result', async () => {
    const rows = await unconfirmedAssumptionRows(sql)
    const mine = rows.find((r) => r.reference === BREACH_NOTIFICATION_HOURS_SETTING_KEY)
    expect(mine, 'the breach period is on the Unconfirmed Assumptions panel').toBeDefined()
    expect(mine?.source).toBe('app_setting')
    expect(mine?.openQuestionId).toBe('Y1-breach-clock')
    // The note has to say the figure was CHOSEN. A provisional flag with a note that reads like a
    // citation is the thing the flag exists to prevent.
    expect(mine?.note ?? '').toMatch(/UNVERIFIED|not confirmed|reading of a secondary source/i)
  })

  it('holds both breach obligations unverified with an open question and no authority named', async () => {
    const rows = await sql<
      {
        key: string
        isUnverified: boolean
        openQuestionId: string | null
        authority: string | null
        cadence: string
        blockingEffect: string
        obligationClass: string
      }[]
    >`
      select key, is_unverified as "isUnverified", open_question_id as "openQuestionId",
             authority, cadence::text as cadence, blocking_effect::text as "blockingEffect",
             obligation_class::text as "obligationClass"
        from obligation
       where key in (${BREACH_NOTIFICATION_OBLIGATION_KEY},
                     ${BREACH_SUBJECT_NOTIFICATION_OBLIGATION_KEY})
       order by key
    `
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.isUnverified, row.key).toBe(true)
      expect(row.openQuestionId, row.key).not.toBeNull()
      // Rule 15, as an assertion rather than as a comment: no authority is named, because the build
      // has not been told which body supervises this business and a plausible one reads as configured.
      expect(row.authority, row.key).toBeNull()
      expect(row.cadence, row.key).toBe('event_driven')
      // No blocking consequence. Blocking publishing on an overdue breach notification would be this
      // build inventing one, and 0052 ties each effect to the class that may hold it.
      expect(row.blockingEffect, row.key).toBe('none')
      expect(row.obligationClass, row.key).toBe('privacy')
    }
  })

  it('refuses a period the schema does not allow, so the deadline cannot be set past a month', async () => {
    // The bound is what keeps a relaxation a judgement rather than a silencing: a deadline of a year
    // is not a breach notification regime, and nothing on a settings screen would say so.
    const { validateSetting } = await import('@berelax/config')
    expect(() => validateSetting(BREACH_NOTIFICATION_HOURS_SETTING_KEY, 8760)).toThrow()
    expect(() => validateSetting(BREACH_NOTIFICATION_HOURS_SETTING_KEY, 0)).toThrow()
    expect(validateSetting(BREACH_NOTIFICATION_HOURS_SETTING_KEY, 72)).toBe(72)
  })
})

describe('the erasure conflict acceptance line, which C-CRM-10 already owns', () => {
  it('resolves a financial record under statutory retention rather than deleting it', async () => {
    // Acceptance line 4 of this unit is C-CRM-10's mechanism, and it is asserted at length in
    // `packages/fixtures/src/rights.itest.ts` and `packages/core/src/privacy/rights-policy.test.ts`.
    // Restating it here would be a second statement of the same fact (brief rule), so what this case
    // asserts is the PROPERTY this unit depends on: that the policy engine's answer for a ledger row
    // is a retention with a reason, and never a delete. Gate case 176l is what proves the assertion
    // can fail.
    const { ERASURE_RULES, isRetainingAction } = await import('@berelax/core')
    const retaining = [...ERASURE_RULES.values()].filter((rule) => isRetainingAction(rule.action))
    expect(retaining.length).toBeGreaterThan(5)
    const statutory = retaining.filter((rule) => rule.action === 'retain_statutory')
    expect(statutory.length).toBeGreaterThan(0)
    for (const rule of statutory) {
      // The two reasons ADR 0034 requires: a maintainer's reason and the sentence a data subject is
      // given. A retention with one of the two is a conflict recorded in a place nobody reads.
      expect(rule.obligationColumn, rule.key).toBeDefined()
      expect((rule.subjectReason ?? '').length, rule.key).toBeGreaterThan(20)
    }
  })
})
