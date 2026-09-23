import { randomUUID } from 'node:crypto'
import type { GenderMatchingMode, TherapistSkill } from '@berelax/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createConnection, type Sql } from '../connection.ts'
import {
  EXCLUSION_REASONS,
  readCommittedAppointments,
  readEligibleTherapists,
  readMandatoryDocumentTypes,
} from './eligibility.ts'

/**
 * B-AVAIL-04 — the therapist availability read model, against real PostgreSQL.
 *
 * `.itest.ts` and not `.test.ts`, the same correction B-AVAIL-01 recorded for
 * `booking-constraints.itest.ts` and B-LIFE-02 for `otp.itest.ts`: `packages/db` has no database in the
 * unit runner, so a database-backed suite named `.test.ts` there never connects. The manifest's `files`
 * list names `eligibility.test.ts`; that file exists too and holds the half that needs no database.
 *
 * ## Isolation
 *
 * The integration suite runs sequentially against ONE database and earlier files leave rows behind, so
 * nothing here assumes it holds the only employee. Two mechanisms, and both are production behaviour
 * rather than test scaffolding:
 *
 *   - every read passes `employeeIds`, so the query cannot see an employee this file did not create —
 *     which is what `resolveTarget` in `with-google.itest.ts` learned the hard way, and the reason
 *     that file disconnects the other connections instead of deleting rows a foreign key protects;
 *   - the trading dates are `2099-08-11` and `2099-08-12`, used by no other suite and no gate.
 *
 * `shift_assignment.employee_id` is ON DELETE RESTRICT and `leave_request.employee_id` likewise, so
 * `afterAll` unwinds in dependency order rather than deleting employees and hoping.
 *
 * Therapists are ids. `staff_reference` is `bavail04-a`, which is a handle and not a name.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/** The trading date under test. Trades 11:00–02:00 Dubai, so it ends on the 12th. */
const TRADING_DATE = '2099-08-11'
/** The next trading date, so "a shift on the wrong date covers nothing" has somewhere to point. */
const NEXT_DATE = '2099-08-12'
/** Every mandatory credential a fixture therapist holds expires here unless the case is about an expiry. */
const FAR_FUTURE = '2099-12-31'
/**
 * The mandatory type the expiry cases move about.
 *
 * Named once, because three cases below UPDATE and re-INSERT rows of exactly this type and a mismatch
 * between them would leave the therapist holding two different documents instead of one renewed. It must
 * be in the set the profile in force carries or the exclusion cases assert nothing; `labour_card` is the
 * first of the six 0058 put in force.
 */
const LAPSING_TYPE = 'labour_card'
const MARKER = 'bavail04 eligibility itest'
/** Dubai wall clock, written as an offset so the assertions read as the rota does. */
const dubai = (day: string, hhmm: string): string => `${day} ${hhmm}:00+04`

let sql: Sql
/** staff_reference -> id, for every employee this file creates. */
const staff = new Map<string, string>()
const shiftIds: string[] = []

const idOf = (reference: string): string => {
  const id = staff.get(reference)
  if (id === undefined) throw new Error(`no fixture employee ${reference}`)
  return id
}

const allIds = (): string[] => [...staff.values()]

/**
 * The mandatory credential set IN FORCE, far in the future, with `lapsed` overriding one type's expiry.
 *
 * Read from `regulatory_profile_current` rather than naming `professional_licence` and
 * `health_certificate`, which is what this file did until migration 0058 reconciled the row in force with
 * the column DEFAULT — docs/01 decision 20's six. A fixture naming two types stops meaning "holds every
 * mandatory document" the moment that answer changes, and the failure is `credential_missing` in cases
 * that are about the roster (0054's header, brief rule 12).
 *
 * `lapsed` has to name a type that is actually mandatory, or nobody is excluded and the case proves
 * nothing — which is why it is an override on THIS list rather than a separate array a caller assembles.
 */
async function mandatoryDocuments(
  lapsed: Readonly<Record<string, string>> = {},
): Promise<readonly { readonly type: string; readonly expiresOn: string }[]> {
  return (await readMandatoryDocumentTypes(sql)).map((type) => ({
    type,
    expiresOn: lapsed[type] ?? FAR_FUTURE,
  }))
}

async function addEmployee(args: {
  readonly reference: string
  readonly gender?: 'female' | 'male'
  readonly employedFrom?: string
  readonly employedUntil?: string | null
  readonly skills?: readonly string[]
  readonly documents?: readonly { readonly type: string; readonly expiresOn: string }[]
}): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into employee (staff_reference, gender, employed_from, employed_until, notes)
    values (
      ${args.reference}, ${args.gender ?? null}, ${args.employedFrom ?? '2099-01-01'},
      ${args.employedUntil ?? null}, ${MARKER}
    )
    returning id
  `
  const id = (row as { id: string }).id
  staff.set(args.reference, id)
  for (const skill of args.skills ?? ['asian_style']) {
    await sql`insert into employee_skill (employee_id, skill) values (${id}, ${skill}::therapist_skill)`
  }
  const documents = args.documents ?? (await mandatoryDocuments())
  for (const document of documents) {
    await sql`
      insert into employee_document (employee_id, document_type, expires_on)
      values (${id}, ${document.type}::employee_document_type, ${document.expiresOn})
    `
  }
  return id
}

/** Rosters everyone named on one span of one trading date, and remembers the shift for teardown. */
async function roster(args: {
  readonly tradingDate: string
  readonly from: string
  readonly to: string
  readonly day?: string
  readonly toDay?: string
  readonly references: readonly string[]
}): Promise<string> {
  const day = args.day ?? args.tradingDate
  const toDay = args.toDay ?? day
  const [row] = await sql<{ id: string }[]>`
    insert into shift (trading_date, period, label)
    values (
      ${args.tradingDate},
      ${`[${dubai(day, args.from)},${dubai(toDay, args.to)})`}::tstzrange,
      ${MARKER}
    )
    returning id
  `
  const id = (row as { id: string }).id
  shiftIds.push(id)
  for (const reference of args.references) {
    await sql`insert into shift_assignment (shift_id, employee_id) values (${id}, ${idOf(reference)})`
  }
  return id
}

const poolFor = async (
  overrides: {
    readonly requiredSkill?: TherapistSkill
    readonly clientGender?: 'female' | 'male'
    readonly genderMatching?: GenderMatchingMode
  } = {},
) =>
  readEligibleTherapists(sql, {
    tradingDate: TRADING_DATE,
    requiredSkill: overrides.requiredSkill ?? 'asian_style',
    employeeIds: allIds(),
    ...(overrides.clientGender === undefined ? {} : { clientGender: overrides.clientGender }),
    ...(overrides.genderMatching === undefined ? {} : { genderMatching: overrides.genderMatching }),
  })

const reasonFor = async (
  reference: string,
  overrides: {
    readonly requiredSkill?: TherapistSkill
    readonly clientGender?: 'female' | 'male'
    readonly genderMatching?: GenderMatchingMode
  } = {},
) => {
  const pool = await readEligibleTherapists(sql, {
    tradingDate: TRADING_DATE,
    requiredSkill: overrides.requiredSkill ?? 'asian_style',
    employeeIds: [idOf(reference)],
    ...(overrides.clientGender === undefined ? {} : { clientGender: overrides.clientGender }),
    ...(overrides.genderMatching === undefined ? {} : { genderMatching: overrides.genderMatching }),
  })
  return pool.excluded[0]?.reason ?? null
}

beforeAll(async () => {
  sql = createConnection({ url, max: 2 })
  for (const tradingDate of [TRADING_DATE, NEXT_DATE]) {
    const closes = tradingDate === TRADING_DATE ? NEXT_DATE : '2099-08-13'
    await sql`
      insert into business_day (trading_date, opens_at, closes_at, source)
      values (
        ${tradingDate}, ${dubai(tradingDate, '11')}::timestamptz,
        ${dubai(closes, '02')}::timestamptz, 'weekly'
      )
      on conflict (trading_date) do nothing
    `
  }

  // One eligible therapist and one per exclusion reason. Each fixture differs from `a` in exactly one
  // respect, which is what lets a reason be attributed to the thing that caused it.
  await addEmployee({
    reference: 'bavail04-a',
    gender: 'female',
    skills: ['asian_style', 'arabic_style'],
  })
  await addEmployee({ reference: 'bavail04-b', gender: 'male' })
  await addEmployee({ reference: 'bavail04-ended', employedUntil: '2099-08-10' })
  await addEmployee({ reference: 'bavail04-noskill', skills: ['arabic_style'] })
  // Holds ONE document, and it is not one the profile in force demands, so every mandatory type is
  // absent: `credential_missing`. `health_certificate` was mandatory before 0058 and is not now, which
  // makes it exactly the right value here — the reason is unchanged and the case is no longer relying on
  // it being in the set.
  await addEmployee({
    reference: 'bavail04-nolicence',
    documents: [{ type: 'health_certificate', expiresOn: FAR_FUTURE }],
  })
  await addEmployee({
    reference: 'bavail04-lapsed',
    documents: await mandatoryDocuments({ [LAPSING_TYPE]: '2099-08-10' }),
  })
  await addEmployee({ reference: 'bavail04-unrostered' })
  await addEmployee({ reference: 'bavail04-onleave' })
  await addEmployee({ reference: 'bavail04-halfday' })

  // Everybody but `unrostered` is on the evening shift, 17:00 to close.
  await roster({
    tradingDate: TRADING_DATE,
    from: '17',
    to: '02',
    toDay: NEXT_DATE,
    references: [
      'bavail04-a',
      'bavail04-b',
      'bavail04-ended',
      'bavail04-noskill',
      'bavail04-nolicence',
      'bavail04-lapsed',
      'bavail04-onleave',
      'bavail04-halfday',
    ],
  })

  await sql`
    insert into leave_request (employee_id, period, kind, status, decided_at)
    values
      (
        ${idOf('bavail04-onleave')},
        ${`[${dubai(TRADING_DATE, '11')},${dubai(NEXT_DATE, '02')})`}::tstzrange,
        'annual', 'approved', now()
      ),
      (
        ${idOf('bavail04-halfday')},
        ${`[${dubai(TRADING_DATE, '19')},${dubai(TRADING_DATE, '21')})`}::tstzrange,
        'annual', 'approved', now()
      )
  `
})

afterAll(async () => {
  const ids = allIds()
  if (ids.length > 0) {
    await sql`delete from appointment where therapist_id = any(${ids}::uuid[])`
    await sql`delete from booking where notes = ${MARKER}`
    await sql`delete from leave_request where employee_id = any(${ids}::uuid[])`
    await sql`delete from shift_assignment where employee_id = any(${ids}::uuid[])`
    if (shiftIds.length > 0) await sql`delete from shift where id = any(${shiftIds}::uuid[])`
    await sql`delete from employee_document where employee_id = any(${ids}::uuid[])`
    await sql`delete from employee_skill where employee_id = any(${ids}::uuid[])`
    await sql`delete from employee where id = any(${ids}::uuid[])`
  }
  await sql`delete from service_variant where provisional_note = ${MARKER}`
  await sql`delete from business_day where trading_date in (${TRADING_DATE}, ${NEXT_DATE})`
  await sql?.end({ timeout: 5 })
})

describe('acceptance — the tables and the view availability reads exist, with those columns', () => {
  it('holds every column the read model selects, and the view is a view', async () => {
    const rows = await sql<{ table_name: string; column_name: string; table_type: string }[]>`
      select c.table_name, c.column_name, t.table_type
        from information_schema.columns c
        join information_schema.tables t
          on t.table_schema = c.table_schema and t.table_name = c.table_name
       where c.table_schema = 'public'
         and c.table_name in (
           'employee', 'employee_skill', 'shift', 'shift_assignment', 'employee_document',
           'leave_request', 'employee_approved_leave'
         )
    `
    const columnsOf = (table: string): string[] =>
      rows
        .filter((row) => row.table_name === table)
        .map((row) => row.column_name)
        .sort()
    // Asserted as a superset rather than an equality: P-HR adds columns to these tables, and a test
    // that pinned the full list would fail on every legitimate extension. What must not disappear is
    // what the read model selects.
    expect(columnsOf('employee')).toEqual(
      expect.arrayContaining([
        'id',
        'staff_reference',
        'gender',
        'employed_from',
        'employed_until',
      ]),
    )
    expect(columnsOf('employee_skill')).toEqual(expect.arrayContaining(['employee_id', 'skill']))
    expect(columnsOf('shift')).toEqual(expect.arrayContaining(['id', 'trading_date', 'period']))
    expect(columnsOf('shift_assignment')).toEqual(
      expect.arrayContaining(['shift_id', 'employee_id']),
    )
    expect(columnsOf('employee_document')).toEqual(
      expect.arrayContaining(['employee_id', 'document_type', 'expires_on']),
    )
    expect(columnsOf('leave_request')).toEqual(
      expect.arrayContaining(['employee_id', 'period', 'status', 'decided_at']),
    )
    // The approved-leave half is a VIEW, so the `status = 'approved'` predicate cannot be forgotten by
    // a caller. A table of the same name would satisfy the column assertion and none of the claim.
    expect(columnsOf('employee_approved_leave')).toEqual(
      expect.arrayContaining(['leave_request_id', 'employee_id', 'period']),
    )
    expect(rows.find((row) => row.table_name === 'employee_approved_leave')?.table_type).toBe(
      'VIEW',
    )
    expect(rows.find((row) => row.table_name === 'leave_request')?.table_type).toBe('BASE TABLE')
  })

  it('reuses the therapist_skill enum of 0017 rather than declaring a second one', async () => {
    // 0017's own comment asks for this: "P-HR's employee_skill should reference this type rather than
    // declare its own". Two enums of the same shape are two Postgres types, and the join to
    // service_skill.required_skill would then need a cast — which is where the spellings drift.
    const [row] = await sql<{ udt_name: string }[]>`
      select udt_name from information_schema.columns
       where table_name = 'employee_skill' and column_name = 'skill'
    `
    expect(row?.udt_name).toBe('therapist_skill')
    const [joined] = await sql<{ n: string }[]>`
      select count(*)::text as n
        from employee_skill es join service_skill ss on ss.required_skill = es.skill
       where es.employee_id = ${idOf('bavail04-a')}
    `
    // The join runs with no cast, which is the whole claim. Two skills, two styles.
    expect(Number(joined?.n)).toBe(2)
  })

  it('has no style column on employee, because style is an attribute of the treatment', async () => {
    // ADR 0021. An `employee.style treatment_style` column would compile and read naturally and make a
    // therapist trained in both styles inexpressible — and the first screen that read it to decide a
    // price would recouple pricing to assignment. Asserted as an absence, because that is what it is.
    const rows = await sql<{ column_name: string; udt_name: string }[]>`
      select column_name, udt_name from information_schema.columns
       where table_schema = 'public' and table_name in ('employee', 'employee_document')
    `
    expect(rows.filter((row) => row.udt_name === 'treatment_style')).toEqual([])
    expect(rows.map((row) => row.column_name)).not.toContain('style')
    // The control: the enum does exist and IS used, one join away, so the assertion above is an
    // absence in the right place rather than a spelling nothing would ever have matched.
    const [used] = await sql<{ n: string }[]>`
      select count(*)::text as n from information_schema.columns
       where table_schema = 'public' and udt_name = 'treatment_style'
    `
    expect(Number(used?.n)).toBeGreaterThan(0)
  })
})

describe('acceptance — the seven exclusion reasons, each caused by one thing', () => {
  it('puts the fully eligible therapists in the pool with their presence', async () => {
    const pool = await poolFor()
    expect(pool.therapists.map((therapist) => therapist.therapistId).sort()).toEqual(
      [idOf('bavail04-a'), idOf('bavail04-b'), idOf('bavail04-halfday')].sort(),
    )
    expect(pool.therapists.find((t) => t.therapistId === idOf('bavail04-a'))?.gender).toBe('female')
    // Gender absent, not null: nobody has told the build (Y8-staff), and `halfday` was created without
    // one. A provider that answered `gender: null` would make B-AVAIL-05 handle two spellings of
    // "unknown".
    const halfday = pool.therapists.find((t) => t.therapistId === idOf('bavail04-halfday'))
    expect(halfday === undefined ? 'missing' : 'gender' in halfday).toBe(false)
  })

  it('reports each reason against the fixture that causes it, and only that one', async () => {
    expect(await reasonFor('bavail04-ended')).toBe('not_employed')
    expect(await reasonFor('bavail04-noskill')).toBe('missing_skill')
    expect(await reasonFor('bavail04-nolicence')).toBe('credential_missing')
    expect(await reasonFor('bavail04-lapsed')).toBe('credential_expired')
    expect(await reasonFor('bavail04-unrostered')).toBe('not_rostered')
    expect(await reasonFor('bavail04-onleave')).toBe('on_approved_leave')
    // The control. Every fixture above differs from this one in exactly one respect, so a rule that
    // excluded everybody — which is what a credential check reading the wrong column does — would fail
    // here rather than pass seven assertions.
    expect(await reasonFor('bavail04-a')).toBeNull()
    // The seventh (B-AVAIL-05) needs a client to be a question at all: `a` is female and eligible on
    // every other count, so a male client is the one thing that changes about her.
    expect(await reasonFor('bavail04-a', { clientGender: 'male' })).toBe('gender_mismatch')
    // And every reason the reader can produce has been produced, so none of the seven is dead.
    const produced = new Set([
      ...(await Promise.all(
        [
          'bavail04-ended',
          'bavail04-noskill',
          'bavail04-nolicence',
          'bavail04-lapsed',
          'bavail04-unrostered',
          'bavail04-onleave',
        ].map((reference) => reasonFor(reference)),
      )),
      await reasonFor('bavail04-a', { clientGender: 'male' }),
    ])
    expect([...produced].sort()).toEqual([...EXCLUSION_REASONS].sort())
  })

  it('applies same-gender matching last, and only when the query names a client', async () => {
    // B-AVAIL-05, against real rows. `ended` left employment on the 10th AND has no recorded gender, so
    // a rule applied anywhere but last would report the gender rather than the employment — and would
    // name a fact about a person to a caller already being told they do not work here.
    expect(await reasonFor('bavail04-ended', { clientGender: 'female' })).toBe('not_employed')
    expect(await reasonFor('bavail04-noskill', { clientGender: 'female' })).toBe('missing_skill')
    // No client gender is not "any therapist will do": it is a query that is not about a client, so
    // nothing is narrowed. The booking-level refusal is `requires_client_gender`, one layer up.
    expect(await reasonFor('bavail04-a')).toBeNull()
    expect(await reasonFor('bavail04-b')).toBeNull()
    // A female client keeps the female therapist and removes the male one, which is the rule in both
    // directions rather than a filter that happens to empty the pool.
    const female = await poolFor({ clientGender: 'female' })
    expect(female.therapists.map((t) => t.therapistId)).toContain(idOf('bavail04-a'))
    expect(female.therapists.map((t) => t.therapistId)).not.toContain(idOf('bavail04-b'))
    const male = await poolFor({ clientGender: 'male' })
    expect(male.therapists.map((t) => t.therapistId)).toContain(idOf('bavail04-b'))
    expect(male.therapists.map((t) => t.therapistId)).not.toContain(idOf('bavail04-a'))
    // A therapist whose gender nobody has recorded is a MISMATCH and not a wildcard: `halfday` was
    // created without one (Y8-staff), and `is distinct from` in the `case` is what makes the NULL
    // exclude rather than silently pass. `<>` there would be NULL, which a `case` reads as false.
    expect(await reasonFor('bavail04-halfday', { clientGender: 'female' })).toBe('gender_mismatch')
    expect(await reasonFor('bavail04-halfday', { clientGender: 'male' })).toBe('gender_mismatch')
    // The presence rows go with the therapist. A pool that dropped the id and kept the shifts would
    // hand the solver presence for somebody it was never given.
    expect(female.shifts.map((shift) => shift.therapistId)).not.toContain(idOf('bavail04-b'))
  })

  it('narrows by gender only in strict mode — advisory leaves the pool to the slot layer', async () => {
    // Advisory does not withhold the cross-gender slot; it labels it (`gender-match.ts`). So the pool is
    // the same pool, and the assertion is an equality rather than an absence: a reader that narrowed in
    // advisory mode as well would be enforcing a mode the owner did not choose.
    const advisory = await poolFor({ clientGender: 'female', genderMatching: 'advisory' })
    const noClient = await poolFor()
    expect(advisory.therapists.map((t) => t.therapistId).sort()).toEqual(
      noClient.therapists.map((t) => t.therapistId).sort(),
    )
    expect(advisory.excluded.map((t) => t.reason)).not.toContain('gender_mismatch')
    // And the fail-safe, which is the whole of this unit: a mode nobody set, or set to a value that is
    // no longer legal, is STRICT. `'off'` was accepted by the registry's schema until B-AVAIL-05.
    for (const stale of [undefined, 'off', 'OFF', '', 'Advisory'] as const) {
      const pool = await readEligibleTherapists(sql, {
        tradingDate: TRADING_DATE,
        requiredSkill: 'asian_style',
        employeeIds: allIds(),
        clientGender: 'female',
        ...(stale === undefined ? {} : { genderMatching: stale as GenderMatchingMode }),
      })
      expect(
        pool.therapists.map((t) => t.therapistId),
        `mode ${String(stale)}`,
      ).not.toContain(idOf('bavail04-b'))
    }
  })

  it('answers the skill question by set membership, not by an attribute of the person', async () => {
    // `a` holds both skills and `b` holds one, from the same table and the same query. A style column
    // on the person could not express the first of those.
    const asian = await poolFor()
    const arabic = await poolFor({ requiredSkill: 'arabic_style' })
    expect(asian.therapists.map((t) => t.therapistId)).toContain(idOf('bavail04-b'))
    expect(arabic.therapists.map((t) => t.therapistId)).toContain(idOf('bavail04-a'))
    expect(arabic.therapists.map((t) => t.therapistId)).not.toContain(idOf('bavail04-b'))
    expect(arabic.excluded.find((t) => t.therapistId === idOf('bavail04-b'))?.reason).toBe(
      'missing_skill',
    )
  })
})

describe('acceptance — a credential expiring either side of the TRADING date', () => {
  /**
   * Two assertions on the same fixture therapist, as the acceptance line asks, plus the case that says
   * the comparison is against the trading date and not the calendar date.
   *
   * 2099-08-11 trades 11:00 to 02:00, so its last two hours fall on the 12th. A licence expiring on
   * the 11th covers all of them. Comparing against the slot's calendar date would exclude this
   * therapist from 00:00 onwards every single night.
   */
  const licenceExpiring = async (expiresOn: string): Promise<string | null> => {
    const id = idOf('bavail04-lapsed')
    await sql`
      update employee_document set expires_on = ${expiresOn}
       where employee_id = ${id} and document_type = ${LAPSING_TYPE}::employee_document_type
    `
    return reasonFor('bavail04-lapsed')
  }

  it('excludes when the licence expired before the trading date and includes when it has not', async () => {
    expect(await licenceExpiring('2099-08-10')).toBe('credential_expired')
    expect(await licenceExpiring('2099-08-11')).toBeNull()
    expect(await licenceExpiring('2099-08-12')).toBeNull()
    // Restored, so the reason matrix above still holds for a later case in this file.
    expect(await licenceExpiring('2099-08-10')).toBe('credential_expired')
  })

  it('takes the latest expiry per type, so a renewal reinstates the therapist', async () => {
    const id = idOf('bavail04-lapsed')
    // A renewal is a NEW ROW (employee_document_one_row_per_expiry), not an edit, so the file still
    // shows the lapsed licence. A reader taking the first or the earliest row reports this therapist as
    // expired on the strength of a licence they have already replaced.
    await sql`
      insert into employee_document (employee_id, document_type, expires_on)
      values (${id}, ${LAPSING_TYPE}::employee_document_type, '2100-08-31')
    `
    expect(await reasonFor('bavail04-lapsed')).toBeNull()
    const [count] = await sql<{ n: string }[]>`
      select count(*)::text as n from employee_document
       where employee_id = ${id} and document_type = ${LAPSING_TYPE}::employee_document_type
    `
    expect(Number(count?.n)).toBe(2)
    await sql`
      delete from employee_document
       where employee_id = ${id} and document_type = ${LAPSING_TYPE}::employee_document_type
         and expires_on = '2100-08-31'
    `
    expect(await reasonFor('bavail04-lapsed')).toBe('credential_expired')
  })
})

describe('acceptance — approved leave excludes, pending does not', () => {
  it('does not exclude a pending request, and does once it is approved', async () => {
    const id = idOf('bavail04-b')
    const [request] = await sql<{ id: string }[]>`
      insert into leave_request (employee_id, period, kind, status)
      values (
        ${id},
        ${`[${dubai(TRADING_DATE, '11')},${dubai(NEXT_DATE, '02')})`}::tstzrange,
        'annual', 'pending'
      )
      returning id
    `
    const requestId = (request as { id: string }).id
    // Pending, and the therapist is still bookable. The failure this catches is a reader that selects
    // from `leave_request` instead of the view: it would pass the approval assertion below and make
    // asking for leave the same act as being granted it.
    expect(await reasonFor('bavail04-b')).toBeNull()

    await sql`update leave_request set status = 'approved', decided_at = now() where id = ${requestId}`
    expect(await reasonFor('bavail04-b')).toBe('on_approved_leave')

    // And rejected is not approved either, which is the third state a boolean could not hold.
    await sql`update leave_request set status = 'rejected' where id = ${requestId}`
    expect(await reasonFor('bavail04-b')).toBeNull()
    await sql`delete from leave_request where id = ${requestId}`
  })

  it('shortens presence for part-day leave rather than removing the therapist', async () => {
    const pool = await poolFor()
    const presence = pool.shifts
      .filter((shift) => shift.therapistId === idOf('bavail04-halfday'))
      .map((shift) => [
        new Date(shift.period.startsAt).toISOString(),
        new Date(shift.period.endsAt).toISOString(),
      ])
    // 17:00–02:00 less 19:00–21:00 is two fragments, and the therapist stays in the pool. Half a day of
    // leave that removed them altogether would lose the evening they are available for.
    expect(presence).toEqual([
      [
        new Date(dubai(TRADING_DATE, '17')).toISOString(),
        new Date(dubai(TRADING_DATE, '19')).toISOString(),
      ],
      [
        new Date(dubai(TRADING_DATE, '21')).toISOString(),
        new Date(dubai(NEXT_DATE, '02')).toISOString(),
      ],
    ])
    // The control: the therapist with no leave has one unbroken fragment over the same shift.
    expect(pool.shifts.filter((shift) => shift.therapistId === idOf('bavail04-a'))).toHaveLength(1)
  })

  it('merges two abutting shift rows into one presence', async () => {
    // A roster written in two halves is one presence. `range_agg` normalises adjacent ranges, which is
    // the same rule `mergePeriods` in @berelax/core applies — and the difference between merging on `>`
    // and on `>=` is whether a treatment crossing the join is refused.
    const extra = await roster({
      tradingDate: TRADING_DATE,
      from: '14',
      to: '17',
      references: ['bavail04-a'],
    })
    const pool = await poolFor()
    const presence = pool.shifts.filter((shift) => shift.therapistId === idOf('bavail04-a'))
    expect(presence).toHaveLength(1)
    expect(new Date(presence[0]?.period.startsAt as number).toISOString()).toBe(
      new Date(dubai(TRADING_DATE, '14')).toISOString(),
    )
    await sql`delete from shift_assignment where shift_id = ${extra}`
    await sql`delete from shift where id = ${extra}`
  })

  it('ignores a shift filed under a different trading date', async () => {
    // Inert rather than dangerous, which is why `shift` carries no trigger asserting the span lies
    // inside its date's window: the wrong date means the shift covers no candidate of the date being
    // solved, so the error under-offers instead of rostering somebody who is not there.
    const misfiled = await roster({
      tradingDate: NEXT_DATE,
      from: '17',
      to: '22',
      day: NEXT_DATE,
      references: ['bavail04-unrostered'],
    })
    expect(await reasonFor('bavail04-unrostered')).toBe('not_rostered')
    const nextDay = await readEligibleTherapists(sql, {
      tradingDate: NEXT_DATE,
      requiredSkill: 'asian_style',
      employeeIds: [idOf('bavail04-unrostered')],
    })
    // The control: the same row IS presence on its own date, so the assertion above is about the date
    // and not about a shift the reader cannot see at all.
    expect(nextDay.therapists.map((t) => t.therapistId)).toEqual([idOf('bavail04-unrostered')])
    await sql`delete from shift_assignment where shift_id = ${misfiled}`
    await sql`delete from shift where id = ${misfiled}`
  })
})

describe('narrowing is what isolates this read, and it answers for every id it is given', () => {
  it('sees only the ids it is given, and more when it is given none', async () => {
    const narrowed = await readEligibleTherapists(sql, {
      tradingDate: TRADING_DATE,
      requiredSkill: 'asian_style',
      employeeIds: [idOf('bavail04-a')],
    })
    expect(narrowed.therapists.map((t) => t.therapistId)).toEqual([idOf('bavail04-a')])
    expect(narrowed.excluded).toEqual([])
    const everybody = await readEligibleTherapists(sql, {
      tradingDate: TRADING_DATE,
      requiredSkill: 'asian_style',
    })
    // An absent list means EVERY employee, not none: `= any(array[]::uuid[])` is false for every row,
    // so an empty array would silently mean nobody where the caller meant everybody.
    const answered = [
      ...everybody.therapists.map((t) => t.therapistId),
      ...everybody.excluded.map((t) => t.therapistId),
    ]
    expect(answered.length).toBeGreaterThanOrEqual(allIds().length)
    for (const id of allIds()) expect(answered).toContain(id)
  })

  it('places every candidate in exactly one list', async () => {
    const pool = await poolFor()
    const answered = [
      ...pool.therapists.map((t) => t.therapistId),
      ...pool.excluded.map((t) => t.therapistId),
    ]
    expect(answered.sort()).toEqual(allIds().sort())
    expect(new Set(answered).size).toBe(answered.length)
  })

  it('returns presence only for therapists that are in the pool', async () => {
    const pool = await poolFor()
    const eligible = new Set(pool.therapists.map((t) => t.therapistId))
    // `onleave` is rostered, so a presence query that did not filter would return fragments for a
    // therapist the pool excluded — and the solver would then be given a shift for an id it was never
    // given, which is two inputs disagreeing about who the query was about.
    expect(pool.excluded.map((t) => t.therapistId)).toContain(idOf('bavail04-onleave'))
    for (const shift of pool.shifts) expect(eligible.has(shift.therapistId)).toBe(true)
  })
})

describe('the mandatory list comes from regulatory_profile, not from this module', () => {
  it('reads the profile in force, which 0058 reconciles with the column DEFAULT', async () => {
    // The literal is decision 20's stricter healthcare reading, in the order the migration writes it.
    // It was 0030's `{professional_licence, health_certificate}` until P-HR-03: 0054 revised the column
    // DEFAULT to these six and deliberately left the ROW carrying the old pair, and 0058 is the
    // reconciliation that migration's header hands to that unit.
    //
    // Asserted as a LITERAL and not against the column default, deliberately. This is the one place in
    // the estate that pins the set actually in force to a value written down in a test, so a migration
    // or a suite that changes what every availability query gates on has to change this line too and be
    // read while doing it. `packages/fixtures/src/hr-credentials.itest.ts` asserts the other half — that
    // the DEFAULT and the row agree — by inserting a version that names no set at all.
    expect(await readMandatoryDocumentTypes(sql)).toEqual([
      'labour_card',
      'emirates_id',
      'residence_visa',
      'occupational_health_card',
      'medical_fitness_certificate',
      'good_conduct_certificate',
    ])
    // And the type the expiry cases above move about is in it, which is what stops those cases passing
    // vacuously against a document nothing demands.
    expect(await readMandatoryDocumentTypes(sql)).toContain(LAPSING_TYPE)
  })
})

describe('readCommittedAppointments', () => {
  /** A booking and one appointment row per therapist, as 0024 stores them. */
  const bookAppointment = async (args: {
    readonly references: readonly string[]
    readonly from: string
    readonly to: string
    readonly roomCode: string
    readonly shape: string
    /** Shared by every row this call writes, so a two-therapist shape is ONE delivery (0038). */
    readonly deliveryId?: string
  }): Promise<string> => {
    const [customer] = await sql<{ id: string }[]>`
      insert into customer (phone_e164, created_via) values ('+971590000411', 'guest_booking')
      on conflict (phone_e164) do update set created_via = excluded.created_via
      returning id
    `
    const [booking] = await sql<{ id: string }[]>`
      insert into booking (customer_id, source, notes)
      values (${(customer as { id: string }).id}, 'front_desk', ${MARKER})
      returning id
    `
    const bookingId = (booking as { id: string }).id
    // One delivery id shared by every row of this call: two therapists over one client is ONE delivery
    // and ONE client place in the room (0038). Passed in rather than defaulted, because the default is a
    // fresh id per row, which counts the pair as two places.
    const deliveryId = args.deliveryId ?? randomUUID()
    const [room] = await sql<{ id: string }[]>`select id from rooms where code = ${args.roomCode}`
    // This file's own variant. 0017 seeds the eight services and no variants — B-CAT-06's seed owns
    // the 32 price points — so a suite that needed one has to create it, exactly as
    // catalogue-compliance.itest.ts and gate 26q do. `on conflict do nothing` so a variant another
    // suite left behind is reused rather than duplicated, and the delete in afterAll is keyed on this
    // file's own marker so it can only ever remove its own row.
    await sql`
      insert into service_variant (service_id, duration_minutes, gross_price_fils, provisional_note)
      select s.id, 120, 20000, ${MARKER} from service s
       where s.style = 'asian' and s.treatment_key = 'normal_massage'
      on conflict (service_id, duration_minutes) do nothing
    `
    const [variant] = await sql<{ id: string }[]>`
      select v.id from service_variant v join service s on s.id = v.service_id
       where s.style = 'asian' and s.treatment_key = 'normal_massage' and v.duration_minutes = 120
    `
    for (const reference of args.references) {
      await sql`
        insert into appointment
          (booking_id, trading_date, service_variant_id, shape, therapist_id, room_id, period,
           status, delivery_id, room_places, turnaround_minutes, therapist_buffer_minutes,
           gross_price_fils, net_fils, vat_fils)
        values (
          ${bookingId}, ${TRADING_DATE}, ${(variant as { id: string }).id}, ${args.shape}::service_shape,
          ${idOf(reference)}, ${(room as { id: string }).id},
          ${`[${dubai(TRADING_DATE, args.from)},${dubai(TRADING_DATE, args.to)})`}::tstzrange,
          'confirmed', ${deliveryId}, 1, 20, 10, 20000, 19048, 952
        )
      `
    }
    return bookingId
  }

  it('returns one record per appointment ROW, each carrying the delivery it belongs to', async () => {
    // Rows are what block THERAPISTS: each of the two rows of a Four Hands holds its own person over the
    // same period, which is what `therapistsFreeFor` asks. Deliveries are what fill a ROOM: 0038 counts
    // client places per `delivery_id`, so these two rows are ONE place. Before 0038 the trigger counted
    // rows against `rooms.capacity` — a column 0012 documents as CLIENTS — and the two readings
    // disagreed, which is what made Four Hands unbookable in every capacity-1 standard room.
    const deliveryId = randomUUID()
    const bookingId = await bookAppointment({
      references: ['bavail04-a', 'bavail04-b'],
      from: '19',
      to: '20',
      roomCode: 'room-couples',
      shape: 'four_hands',
      deliveryId,
    })
    const rows = await readCommittedAppointments(sql, { tradingDate: TRADING_DATE })
    const mine = rows.filter((row) =>
      row.therapistIds.some((id) => id === idOf('bavail04-a') || id === idOf('bavail04-b')),
    )
    expect(mine).toHaveLength(2)
    expect(mine.every((row) => row.therapistIds.length === 1)).toBe(true)
    expect(mine.map((row) => row.roomId)).toEqual([mine[0]?.roomId, mine[0]?.roomId])
    // Both rows, one delivery, one client place — the pair core groups by.
    expect(mine.map((row) => row.delivery)).toEqual([
      { id: deliveryId, places: 1 },
      { id: deliveryId, places: 1 },
    ])
    // The two snapshot columns 0038 added, read from the appointment and no longer re-derived from the
    // catalogue: the fixture wrote 20 and 10, and those are the figures that come back.
    expect(mine[0]?.turnaroundMinutes).toBe(20)
    expect(mine[0]?.therapistBufferMinutes).toBe(10)

    // The control for the delivery grouping: a SEPARATE row with its own delivery id is its own place,
    // so the assertion above is the grouping rather than a reader that answers one id for everything.
    const soloBooking = await bookAppointment({
      references: ['bavail04-a'],
      from: '21',
      to: '22',
      roomCode: 'room-couples',
      shape: 'solo',
    })
    const withSolo = await readCommittedAppointments(sql, { tradingDate: TRADING_DATE })
    const solo = withSolo.filter((row) => row.id !== mine[0]?.id && row.id !== mine[1]?.id)
    expect(solo).toHaveLength(1)
    expect(solo[0]?.delivery.id).not.toBe(deliveryId)
    await sql`delete from appointment where booking_id = ${soloBooking}`
    await sql`delete from booking where id = ${soloBooking}`

    // Cancelling releases both, because the select is on `holds_resources` — the generated column the
    // exclusion constraint and the capacity trigger read, so "still holds" has one definition.
    await sql`update appointment set status = 'cancelled_by_customer' where booking_id = ${bookingId}`
    const afterCancel = await readCommittedAppointments(sql, { tradingDate: TRADING_DATE })
    expect(afterCancel.filter((row) => row.therapistIds.includes(idOf('bavail04-a')))).toHaveLength(
      0,
    )
    // The control: the rows are still there, so "released" is about the predicate rather than a delete.
    const [still] = await sql<{ n: string }[]>`
      select count(*)::text as n from appointment where booking_id = ${bookingId}
    `
    expect(Number(still?.n)).toBe(2)
    await sql`delete from appointment where booking_id = ${bookingId}`
    await sql`delete from booking where id = ${bookingId}`
    await sql`delete from customer where phone_e164 = '+971590000411'`
  })
})

describe('privileges — an employee is ended, never deleted', () => {
  it('refuses DELETE on employee and leave_request from the application role, and grants the rest', async () => {
    const [row] = await sql<
      {
        emp_select: boolean
        emp_insert: boolean
        emp_update: boolean
        emp_delete: boolean
        leave_delete: boolean
        shift_delete: boolean
      }[]
    >`
      select has_table_privilege('berelax_app', 'employee', 'SELECT')      as emp_select,
             has_table_privilege('berelax_app', 'employee', 'INSERT')      as emp_insert,
             has_table_privilege('berelax_app', 'employee', 'UPDATE')      as emp_update,
             has_table_privilege('berelax_app', 'employee', 'DELETE')      as emp_delete,
             has_table_privilege('berelax_app', 'leave_request', 'DELETE') as leave_delete,
             has_table_privilege('berelax_app', 'shift', 'DELETE')         as shift_delete
    `
    expect(row?.emp_delete).toBe(false)
    expect(row?.leave_delete).toBe(false)
    // The controls. Without the first three, the revoke is satisfied by a role with no access at all;
    // without the fourth, it is satisfied by a blanket revoke that would also make an unpublished
    // roster impossible to rewrite.
    expect(row?.emp_select).toBe(true)
    expect(row?.emp_insert).toBe(true)
    expect(row?.emp_update).toBe(true)
    expect(row?.shift_delete).toBe(true)
  })
})
