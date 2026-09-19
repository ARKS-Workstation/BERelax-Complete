import {
  type ApprovedLeave,
  ASIA_DUBAI,
  assertPoolIsTotal,
  ELIGIBILITY_EXCLUSION_REASONS,
  type EligibilityExclusionReason,
  type EligibilityFacts,
  type EligibilityQuery,
  type GenderMatchedSlot,
  type HoursForDate,
  type Instant,
  instantFromIso,
  localDate,
  localTime,
  poolSolverInput,
  resolveTherapistPool,
  type ScheduledAppointment,
  type SlotRequest,
  solveAvailability,
  solveGenderMatchedAvailability,
  type TherapistCredential,
  type TherapistEligibilityProvider,
  type TherapistGender,
  type TherapistPool,
  type TherapistRecord,
  type TherapistShift,
  type TradingHours,
  toLocal,
} from '@berelax/core'
import {
  createConnection,
  EXCLUSION_REASONS,
  type ExclusionReason,
  readCommittedAppointments,
  readEligibleTherapists,
  readGenderMatching,
  readMandatoryDocumentTypes,
  type Sql,
  type TherapistPoolRead,
} from '@berelax/db'
import { requiredSkillFor, type TherapistSkill } from '@berelax/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * B-AVAIL-04 — the two halves of the eligibility port, joined.
 *
 * The **rule** is pure and lives in `@berelax/core` (`resolveTherapistPool`). The **rows** live in
 * PostgreSQL and are read by `@berelax/db` (`readEligibleTherapists`), which computes the same answer
 * in SQL. Neither package may import the other — `packages/db` must never import `packages/core` — so
 * nothing but `@berelax/fixtures` can assert that the pair works, and the pair is the whole claim of
 * this unit:
 *
 *   1. the db reader is **structurally the port**, asserted with `satisfies` rather than by a comment,
 *      so a P-HR extension that changes either side fails `pnpm typecheck`;
 *   2. the two implementations **agree**, over a matrix that produces every one of the seven exclusion
 *      reasons from real rows — which is what makes two implementations of one rule safe rather than
 *      one rule plus a future disagreement. The seventh is B-AVAIL-05's `gender_mismatch`, and the last
 *      describe block below is that unit's half: the matrix with a client attached, the ordering that
 *      keeps gender last, and the strict default read out of a database with NO `app_setting` row;
 *   3. the pool **feeds the solver unchanged**: `poolSolverInput` supplies `therapistIds` and `shifts`
 *      and nothing in `solveAvailability` learns what a credential or a leave request is. The
 *      acceptance list's worked example — shift ends 22:00, a 90-minute treatment excluded at 21:00 and
 *      included at 20:20 — is asserted end to end through that wiring;
 *   4. flipping `regulatory_profile` changes **which therapists are excluded**, against real rows and
 *      with no deploy, exactly as the banned-claims lexicon does (B-CAT-05);
 *   5. a slot this read model offers is one the **database will accept**: the appointment rows are
 *      written and committed, and the same query then stops offering the slot.
 *
 * ## Isolation
 *
 * The integration suite runs sequentially against one database and earlier files leave rows behind, so
 * every read narrows `employeeIds` to the employees this file created, and the trading date
 * `2099-08-21` is used by no other suite and no gate. `regulatory_profile` is append-only (ADR 0008):
 * the flip supersedes and inserts, the assertion is a DELTA, and the restore is a further row rather
 * than a delete.
 *
 * Therapists are ids throughout. `staff_reference` is a handle, never a name.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

const TRADING_DATE = '2099-08-21'
const NEXT_DAY = '2099-08-22'
const MARKER = 'bavail04 pair itest'
const PROBE_PHONE = '+971590000421'
/** 11:00–02:00, the real hours, which is what makes a treatment able to cross midnight. */
const HOURS: TradingHours = { open: localTime('11:00'), close: localTime('02:00') }
const HOURS_FOR: HoursForDate = () => HOURS
const dubai = (day: string, hhmm: string): string => `${day} ${hhmm}:00+04`
const at = (day: string, hhmm: string): Instant => instantFromIso(`${day}T${hhmm}:00+04:00`)
const wall = (instant: Instant): string => toLocal(instant, ASIA_DUBAI).time

/** The buffer and duration the acceptance line's 22:00 / 21:00 / 20:20 figures are derived from. */
const BUFFER_MINUTES = 10
const DURATION_MINUTES = 90
const TURNAROUND_MINUTES = 20

let sql: Sql
let roomId: string
let variantId: string
let seededMandatory: readonly string[]
const staff = new Map<string, string>()
const shiftIds: string[] = []

const idOf = (reference: string): string => {
  const id = staff.get(reference)
  if (id === undefined) throw new Error(`no fixture employee ${reference}`)
  return id
}
const allIds = (): string[] => [...staff.values()]

/**
 * The db reader, as the port.
 *
 * `satisfies` and not a cast: if `TherapistPoolRead` loses a field the port declares, or the port gains
 * one the reader does not produce, this line fails `pnpm typecheck` rather than a test. It is the drift
 * guard the boundary rule makes necessary — the two shapes cannot be one shared type, because that
 * would be an import `db-must-not-import-core` forbids.
 */
const asPool = (read: TherapistPoolRead): TherapistPool => ({
  // `therapists` and `excluded` are copied WHOLE, not mapped: their types have to be assignable to the
  // port's as they stand, so a field the port needs and the reader stopped producing — a dropped
  // gender, a reason renamed — is a compile error on this line rather than an `undefined` at runtime.
  therapists: read.therapists,
  excluded: read.excluded,
  // `shifts` is the one field that is re-wrapped, and only to brand the instants. `Instant` is
  // `Brand<number, 'Instant'>` in `@berelax/core`, and `packages/db` may not import core — so the
  // reader answers in epoch milliseconds and the brand is applied here, on the one side of the boundary
  // that can see both. This is the same field copy `asPolicy` is in `catalogue-compliance.itest.ts`.
  shifts: read.shifts.map((shift) => ({
    therapistId: shift.therapistId,
    period: {
      startsAt: shift.period.startsAt as Instant,
      endsAt: shift.period.endsAt as Instant,
    },
  })),
})

const dbProvider = {
  eligibleTherapists: async (query: EligibilityQuery) =>
    asPool(
      await readEligibleTherapists(sql, {
        tradingDate: query.tradingDate,
        requiredSkill: query.requiredSkill,
        ...(query.therapistIds === undefined ? {} : { employeeIds: query.therapistIds }),
        // Forwarded, not dropped. A provider that silently ignored these two would still satisfy the
        // port's type and would answer a DIFFERENT question from the pure rule — which is the only way
        // the agreement test below can be passing and wrong at the same time.
        ...(query.clientGender === undefined ? {} : { clientGender: query.clientGender }),
        ...(query.genderMatching === undefined ? {} : { genderMatching: query.genderMatching }),
      }),
    ),
} satisfies TherapistEligibilityProvider

/**
 * The two reason lists are the SAME set, checked at compile time in both directions.
 *
 * `packages/db` may not import `packages/core`, so `EXCLUSION_REASONS` and
 * `ELIGIBILITY_EXCLUSION_REASONS` are two hand-kept lists of one vocabulary, and until B-AVAIL-05 the
 * only thing holding them together was a comment in each. A reason present on one side only is a
 * therapist excluded for a reason the caller cannot name: the SQL `case` emits it, `exclusionReasonFrom`
 * throws on it, and the failure arrives at a booking rather than at `pnpm typecheck`. Either half of this
 * pair becoming `never` is a compile error on the assignment below — which is what gate 35h mutates.
 */
type DbReasonsAreCoreReasons = ExclusionReason extends EligibilityExclusionReason ? true : never
type CoreReasonsAreDbReasons = EligibilityExclusionReason extends ExclusionReason ? true : never
const REASON_UNIONS_AGREE: readonly [DbReasonsAreCoreReasons, CoreReasonsAreDbReasons] = [
  true,
  true,
]

async function addEmployee(args: {
  readonly reference: string
  readonly gender?: TherapistGender
  readonly employedFrom?: string
  readonly employedUntil?: string | null
  readonly skills?: readonly TherapistSkill[]
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
  for (const skill of args.skills ?? (['asian_style'] as const)) {
    await sql`
      insert into employee_skill (employee_id, skill) values (${id}, ${skill}::therapist_skill)
    `
  }
  for (const document of args.documents ?? [
    { type: 'professional_licence', expiresOn: '2099-12-31' },
    { type: 'health_certificate', expiresOn: '2099-12-31' },
  ]) {
    await sql`
      insert into employee_document (employee_id, document_type, expires_on)
      values (${id}, ${document.type}::employee_document_type, ${document.expiresOn})
    `
  }
  return id
}

async function roster(args: {
  readonly from: readonly [string, string]
  readonly to: readonly [string, string]
  readonly references: readonly string[]
}): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into shift (trading_date, period, label)
    values (
      ${TRADING_DATE},
      ${`[${dubai(args.from[0], args.from[1])},${dubai(args.to[0], args.to[1])})`}::tstzrange,
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

/**
 * The same rows the SQL reads, assembled into the facts the pure rule takes.
 *
 * Deliberately raw `select`s rather than a second call to the reader: the point is to compare two
 * implementations over ONE set of rows, and reusing the reader's own queries to build the input would
 * make the comparison circular.
 */
async function readFacts(): Promise<EligibilityFacts> {
  const ids = allIds()
  const employees = await sql<
    {
      id: string
      gender: TherapistGender | null
      employed_from: Date
      employed_until: Date | null
    }[]
  >`
    select id, gender, employed_from, employed_until from employee
     where id = any(${ids}::uuid[]) order by id
  `
  const skills = await sql<{ employee_id: string; skill: TherapistSkill }[]>`
    select employee_id, skill from employee_skill where employee_id = any(${ids}::uuid[])
  `
  const documents = await sql<{ employee_id: string; document_type: string; expires_on: Date }[]>`
    select employee_id, document_type, expires_on from employee_document
     where employee_id = any(${ids}::uuid[])
  `
  const shifts = await sql<{ employee_id: string; starts_at: Date; ends_at: Date }[]>`
    select sa.employee_id, lower(s.period) as starts_at, upper(s.period) as ends_at
      from shift_assignment sa join shift s on s.id = sa.shift_id
     where s.trading_date = ${TRADING_DATE} and sa.employee_id = any(${ids}::uuid[])
  `
  // The VIEW, not the table: a pending request must not remove a therapist, and reading the table here
  // would make the pure side agree with a db reader that had the same bug.
  const leave = await sql<{ employee_id: string; starts_at: Date; ends_at: Date }[]>`
    select employee_id, lower(period) as starts_at, upper(period) as ends_at
      from employee_approved_leave where employee_id = any(${ids}::uuid[])
  `
  const asDate = (value: Date): string => value.toISOString().slice(0, 10)
  const therapists: TherapistRecord[] = employees.map((row) => {
    const credentials: TherapistCredential[] = documents
      .filter((document) => document.employee_id === row.id)
      .map((document) => ({
        documentType: document.document_type,
        expiresOn: localDate(asDate(document.expires_on)),
      }))
    return {
      therapistId: row.id,
      employedFrom: localDate(asDate(row.employed_from)),
      skills: skills.filter((skill) => skill.employee_id === row.id).map((skill) => skill.skill),
      credentials,
      ...(row.gender === null ? {} : { gender: row.gender }),
      ...(row.employed_until === null
        ? {}
        : { employedUntil: localDate(asDate(row.employed_until)) }),
    }
  })
  const asShift = (row: {
    employee_id: string
    starts_at: Date
    ends_at: Date
  }): TherapistShift => ({
    therapistId: row.employee_id,
    period: {
      startsAt: row.starts_at.getTime() as Instant,
      endsAt: row.ends_at.getTime() as Instant,
    },
  })
  const asLeave = (row: {
    employee_id: string
    starts_at: Date
    ends_at: Date
  }): ApprovedLeave => ({
    therapistId: row.employee_id,
    period: {
      startsAt: row.starts_at.getTime() as Instant,
      endsAt: row.ends_at.getTime() as Instant,
    },
  })
  return {
    mandatoryDocumentTypes: await readMandatoryDocumentTypes(sql),
    therapists,
    shifts: shifts.map(asShift),
    approvedLeave: leave.map(asLeave),
  }
}

/** Both implementations' answers to one query, normalised for comparison. */
async function bothPools(query: EligibilityQuery): Promise<{
  readonly pure: TherapistPool
  readonly database: TherapistPool
}> {
  const facts = await readFacts()
  const pure = resolveTherapistPool(facts, query)
  const database = await dbProvider.eligibleTherapists(query)
  return { pure, database }
}

const comparable = (pool: TherapistPool) => ({
  therapists: [...pool.therapists]
    .map((therapist) => ({
      therapistId: therapist.therapistId,
      skills: [...therapist.skills].sort(),
      ...(therapist.gender === undefined ? {} : { gender: therapist.gender }),
    }))
    .sort((a, b) => (a.therapistId < b.therapistId ? -1 : 1)),
  shifts: [...pool.shifts]
    .map((shift) => ({
      therapistId: shift.therapistId,
      startsAt: shift.period.startsAt,
      endsAt: shift.period.endsAt,
    }))
    .sort((a, b) => a.therapistId.localeCompare(b.therapistId) || a.startsAt - b.startsAt),
  excluded: [...pool.excluded].sort((a, b) => (a.therapistId < b.therapistId ? -1 : 1)),
})

interface ProfileSnapshot {
  readonly mandatory: readonly string[]
  readonly note: string
}

/**
 * Supersedes the profile in force and inserts a new one, which is how 0004 says a profile changes.
 *
 * Every field but the one under test is carried over from the retired row rather than restated —
 * `opening-balances.itest.ts` and `catalogue-compliance.itest.ts` both record what restating a field
 * costs: a fixture that restores *nearly* the original row breaks another suite one file later.
 */
async function supersedeMandatory(snapshot: ProfileSnapshot): Promise<number> {
  const [row] = await sql<{ version: number }[]>`
    with retired as (
      update regulatory_profile set superseded_at = now() where superseded_at is null
      returning licence_class, emirate, clinical_retention_years, financial_retention_years,
                erasure_overrides_retention, medical_claims_permitted, permitted_public_titles,
                banned_claim_terms, is_provisional
    )
    insert into regulatory_profile
      (licence_class, emirate, clinical_retention_years, financial_retention_years,
       erasure_overrides_retention, medical_claims_permitted, permitted_public_titles,
       banned_claim_terms, is_provisional, source_note, mandatory_therapist_document_types)
    select retired.licence_class, retired.emirate, retired.clinical_retention_years,
           retired.financial_retention_years, retired.erasure_overrides_retention,
           retired.medical_claims_permitted, retired.permitted_public_titles,
           retired.banned_claim_terms, retired.is_provisional, ${snapshot.note},
           ${sql.array([...snapshot.mandatory])}::employee_document_type[]
    from retired
    returning version
  `
  return Number((row as { version: number }).version)
}

async function profileRowCount(): Promise<number> {
  const [row] = await sql<{ n: string }[]>`select count(*)::text as n from regulatory_profile`
  return Number((row as { n: string }).n)
}

/** The solver request for the worked example, less the two fields the pool supplies. */
const solverRequest = (
  pool: TherapistPool,
  appointments: readonly ScheduledAppointment[],
  stepMinutes: number,
): SlotRequest => ({
  now: at(TRADING_DATE, '12'),
  tradingDate: localDate(TRADING_DATE),
  hoursFor: HOURS_FOR,
  closures: [],
  durationMinutes: DURATION_MINUTES,
  turnaroundMinutes: TURNAROUND_MINUTES,
  therapistBufferMinutes: BUFFER_MINUTES,
  minLeadMinutes: 120,
  maxAdvanceDays: 90_000,
  rooms: [{ id: roomId, roomType: 'standard', capacity: 1, isBookable: true }],
  compatibleRoomTypes: ['standard'],
  appointments,
  blocks: [],
  stepMinutes,
  // The whole of the wiring. Nothing in solveAvailability learns what a credential is.
  ...poolSolverInput(pool),
})

beforeAll(async () => {
  sql = createConnection({ url, max: 2 })
  seededMandatory = await readMandatoryDocumentTypes(sql)
  await sql`
    insert into business_day (trading_date, opens_at, closes_at, source)
    values (
      ${TRADING_DATE}, ${dubai(TRADING_DATE, '11')}::timestamptz,
      ${dubai(NEXT_DAY, '02')}::timestamptz, 'weekly'
    )
    on conflict (trading_date) do nothing
  `
  const [room] = await sql<{ id: string }[]>`select id from rooms where code = 'room-1'`
  roomId = (room as { id: string }).id
  await sql`
    insert into service_variant (service_id, duration_minutes, gross_price_fils, provisional_note)
    select s.id, 90, 30000, ${MARKER} from service s
     where s.style = 'asian' and s.treatment_key = 'normal_massage'
    on conflict (service_id, duration_minutes) do nothing
  `
  const [variant] = await sql<{ id: string }[]>`
    select v.id from service_variant v join service s on s.id = v.service_id
     where s.style = 'asian' and s.treatment_key = 'normal_massage' and v.duration_minutes = 90
  `
  variantId = (variant as { id: string }).id

  // `short` is the acceptance line's therapist: rostered 17:00–22:00 and nothing else.
  await addEmployee({ reference: 'bavail04p-short', gender: 'female' })
  // The matrix, one fixture per exclusion reason plus a fully eligible control.
  await addEmployee({
    reference: 'bavail04p-ok',
    gender: 'male',
    skills: ['asian_style', 'arabic_style'],
  })
  await addEmployee({ reference: 'bavail04p-ended', employedUntil: '2099-08-20' })
  await addEmployee({ reference: 'bavail04p-noskill', skills: ['arabic_style'] })
  await addEmployee({
    reference: 'bavail04p-nolicence',
    documents: [{ type: 'health_certificate', expiresOn: '2099-12-31' }],
  })
  await addEmployee({
    reference: 'bavail04p-lapsed',
    documents: [
      { type: 'professional_licence', expiresOn: '2099-08-20' },
      { type: 'health_certificate', expiresOn: '2099-12-31' },
    ],
  })
  await addEmployee({ reference: 'bavail04p-unrostered' })
  await addEmployee({ reference: 'bavail04p-onleave' })
  await addEmployee({ reference: 'bavail04p-halfday' })
  // Holds only a work_permit, which the seeded profile does not require. The flip makes it the only
  // credential that counts, at which point this therapist is the only one who keeps it.
  await addEmployee({
    reference: 'bavail04p-permit',
    documents: [{ type: 'work_permit', expiresOn: '2099-12-31' }],
  })

  await roster({
    from: [TRADING_DATE, '17'],
    to: [TRADING_DATE, '22'],
    references: ['bavail04p-short'],
  })
  await roster({
    from: [TRADING_DATE, '11'],
    to: [NEXT_DAY, '02'],
    references: [
      'bavail04p-ok',
      'bavail04p-ended',
      'bavail04p-noskill',
      'bavail04p-nolicence',
      'bavail04p-lapsed',
      'bavail04p-onleave',
      'bavail04p-halfday',
      'bavail04p-permit',
    ],
  })
  await sql`
    insert into leave_request (employee_id, period, kind, status, decided_at)
    values
      (
        ${idOf('bavail04p-onleave')},
        ${`[${dubai(TRADING_DATE, '11')},${dubai(NEXT_DAY, '02')})`}::tstzrange,
        'annual', 'approved', now()
      ),
      (
        ${idOf('bavail04p-halfday')},
        ${`[${dubai(TRADING_DATE, '19')},${dubai(TRADING_DATE, '21')})`}::tstzrange,
        'sick', 'approved', now()
      ),
      (
        ${idOf('bavail04p-ok')},
        ${`[${dubai(TRADING_DATE, '11')},${dubai(NEXT_DAY, '02')})`}::tstzrange,
        'annual', 'pending', null
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
  await sql`delete from customer where phone_e164 = ${PROBE_PHONE}`
  await sql`delete from business_day where trading_date = ${TRADING_DATE}`
  await sql?.end({ timeout: 5 })
})

describe('acceptance — the db reader IS the port, and the two implementations agree', () => {
  it('answers a narrowed query identically, field for field', async () => {
    const query: EligibilityQuery = {
      tradingDate: localDate(TRADING_DATE),
      requiredSkill: requiredSkillFor('asian'),
      therapistIds: allIds(),
    }
    const { pure, database } = await bothPools(query)
    // The whole answer, not just the eligible ids: the reasons and the leave-adjusted presence are
    // where two implementations of one rule actually drift.
    expect(comparable(database)).toEqual(comparable(pure))
    // And the answer is not trivially empty on either side, which is what a `toEqual` between two
    // broken implementations would otherwise be satisfied by.
    expect(pure.therapists.length).toBeGreaterThan(0)
    expect(pure.excluded.length).toBeGreaterThan(0)
    assertPoolIsTotal(database, allIds())
    assertPoolIsTotal(pure, allIds())
  })

  it('produces every one of the six exclusion reasons from real rows, on both sides', async () => {
    const query: EligibilityQuery = {
      tradingDate: localDate(TRADING_DATE),
      requiredSkill: requiredSkillFor('asian'),
      therapistIds: allIds(),
    }
    const { pure, database } = await bothPools(query)
    const reasonOf = (pool: TherapistPool, reference: string): string | undefined =>
      pool.excluded.find((therapist) => therapist.therapistId === idOf(reference))?.reason
    const cases = [
      ['bavail04p-ended', 'not_employed'],
      ['bavail04p-noskill', 'missing_skill'],
      ['bavail04p-nolicence', 'credential_missing'],
      ['bavail04p-lapsed', 'credential_expired'],
      ['bavail04p-unrostered', 'not_rostered'],
      ['bavail04p-onleave', 'on_approved_leave'],
    ] as const
    for (const [reference, reason] of cases) {
      expect(reasonOf(pure, reference)).toBe(reason)
      expect(reasonOf(database, reference)).toBe(reason)
    }
    // Every reason exercised means none of the six is dead in either implementation.
    expect(new Set(cases.map(([, reason]) => reason)).size).toBe(6)
    // The controls: a pending request does not exclude, and part-day leave does not either.
    expect(reasonOf(database, 'bavail04p-ok')).toBeUndefined()
    expect(reasonOf(database, 'bavail04p-halfday')).toBeUndefined()
    // …and the half-day therapist's presence is two fragments on both sides, which is the assertion a
    // pool that merely listed ids could not make.
    const fragments = (pool: TherapistPool): string[][] =>
      pool.shifts
        .filter((shift) => shift.therapistId === idOf('bavail04p-halfday'))
        .map((shift) => [wall(shift.period.startsAt), wall(shift.period.endsAt)])
    expect(fragments(database)).toEqual([
      ['11:00', '19:00'],
      ['21:00', '02:00'],
    ])
    expect(fragments(pure)).toEqual(fragments(database))
  })
})

describe('acceptance — a shift ending mid-treatment removes the slot', () => {
  /**
   * The acceptance figures, end to end through the wiring: shift ends 22:00, 90-minute treatment, a
   * 10-minute therapist buffer either side. 21:00 needs 20:50–22:40 and is excluded; 20:20 needs
   * 20:10–22:00 and is included, because the interval is half-open and a treatment may finish exactly
   * at shift end.
   *
   * The grid is 10 minutes from 11:00, which puts 20:20, 21:00 and 17:10 all on it. On the default
   * quarter hour none of the acceptance figures is a candidate at all, and the test would be asserting
   * the grid rather than the rule.
   */
  const slotsForShort = async (): Promise<readonly string[]> => {
    const pool = await dbProvider.eligibleTherapists({
      tradingDate: localDate(TRADING_DATE),
      requiredSkill: requiredSkillFor('asian'),
      therapistIds: [idOf('bavail04p-short')],
    })
    const solution = solveAvailability(solverRequest(pool, [], 10))
    return solution.slots.map((slot) => wall(slot.startsAt))
  }

  it('offers 20:20 and not 21:00 against a shift that ends at 22:00', async () => {
    const starts = await slotsForShort()
    expect(starts).toContain('20:20')
    expect(starts).not.toContain('21:00')
    // The last offered start is 20:20 exactly, which is the figure rather than a range: 20:40 + 90 + 10
    // is 22:20, and the therapist has gone home.
    expect(starts.at(-1)).toBe('20:20')
    // And the shift's own start is respected at the other end. 17:00 is NOT offered: the LEADING half
    // of the buffer needs 16:50, ten minutes before the therapist is on, and forgetting that half is
    // what books a therapist into a treatment starting while they are still finishing their break. The
    // first offered start is 17:10 — shift start plus the buffer, exactly.
    expect(starts[0]).toBe('17:10')
    expect(starts).not.toContain('17:00')
  })

  it('offers 21:00 once the roster is extended, so the rule is the shift and not the hour', async () => {
    // The control. Without it, "21:00 is absent" is satisfied by a solver that never offers 21:00 — or
    // by a pool that is empty for a reason having nothing to do with the shift.
    const extra = await roster({
      from: [TRADING_DATE, '22'],
      to: [NEXT_DAY, '02'],
      references: ['bavail04p-short'],
    })
    try {
      const starts = await slotsForShort()
      expect(starts).toContain('21:00')
      expect(starts).toContain('20:20')
    } finally {
      await sql`delete from shift_assignment where shift_id = ${extra}`
      await sql`delete from shift where id = ${extra}`
    }
    // Restored: 21:00 is gone again, so the control did not leave the fixture changed for a later case.
    expect(await slotsForShort()).not.toContain('21:00')
  })
})

describe('acceptance — the mandatory document types are read from regulatory_profile', () => {
  it('changes which therapists are excluded when the profile in force changes', async () => {
    const query: EligibilityQuery = {
      tradingDate: localDate(TRADING_DATE),
      requiredSkill: requiredSkillFor('asian'),
      therapistIds: allIds(),
    }
    const before = await profileRowCount()
    const seeded = await bothPools(query)
    const reasonOf = (pool: TherapistPool, reference: string): string | undefined =>
      pool.excluded.find((therapist) => therapist.therapistId === idOf(reference))?.reason
    // Under the seeded profile the work-permit-only therapist has neither mandatory document.
    expect(await readMandatoryDocumentTypes(sql)).toEqual(seededMandatory)
    expect(reasonOf(seeded.database, 'bavail04p-permit')).toBe('credential_missing')
    expect(reasonOf(seeded.database, 'bavail04p-nolicence')).toBe('credential_missing')
    expect(reasonOf(seeded.database, 'bavail04p-ok')).toBeUndefined()

    const version = await supersedeMandatory({
      mandatory: ['work_permit'],
      note: 'B-AVAIL-04 pair itest: work permit is the only mandatory credential (probe)',
    })
    try {
      const flipped = await bothPools(query)
      expect(await readMandatoryDocumentTypes(sql)).toEqual(['work_permit'])
      // The flip, and the reason the list is data: a lawyer's answer reaches the credential gate with
      // no deploy. The therapist who was excluded is now eligible, and the ones who were eligible are
      // not — both directions, because a rule that simply stopped checking would satisfy only the first.
      expect(reasonOf(flipped.database, 'bavail04p-permit')).toBeUndefined()
      expect(reasonOf(flipped.database, 'bavail04p-ok')).toBe('credential_missing')
      expect(reasonOf(flipped.database, 'bavail04p-lapsed')).toBe('credential_missing')
      // And the pure rule follows the same row, so the two do not disagree about a changed profile.
      expect(comparable(flipped.database)).toEqual(comparable(flipped.pure))

      // An empty list is a legitimate value — no credential gate — and it is what says the check reads
      // the profile rather than merely reacting to a change in it.
      await supersedeMandatory({
        mandatory: [],
        note: 'B-AVAIL-04 pair itest: no credential gate (probe)',
      })
      const ungated = await bothPools(query)
      expect(reasonOf(ungated.database, 'bavail04p-lapsed')).toBeUndefined()
      expect(reasonOf(ungated.database, 'bavail04p-nolicence')).toBeUndefined()
      expect(comparable(ungated.database)).toEqual(comparable(ungated.pure))
    } finally {
      // Restored by INSERTING the seeded list again, never by deleting a row: the table is append-only
      // (ADR 0008), so the profile in force on any past date stays recoverable.
      await supersedeMandatory({
        mandatory: seededMandatory,
        note: 'B-AVAIL-04 pair itest: restoring the seeded mandatory credentials',
      })
    }
    // A delta, never a total: three rows added, nothing deleted, and the version moved forward.
    expect(await profileRowCount()).toBe(before + 3)
    expect(version).toBeGreaterThan(0)
    expect(await readMandatoryDocumentTypes(sql)).toEqual(seededMandatory)
    const restored = await bothPools(query)
    expect(comparable(restored.database)).toEqual(comparable(seeded.database))
  })
})

describe('acceptance — it does not offer a slot the database would then refuse', () => {
  it('commits the offered slot, and then stops offering it', async () => {
    const poolFor = async (): Promise<TherapistPool> =>
      dbProvider.eligibleTherapists({
        tradingDate: localDate(TRADING_DATE),
        requiredSkill: requiredSkillFor('asian'),
        therapistIds: [idOf('bavail04p-short')],
      })
    const appointmentsNow = async (): Promise<readonly ScheduledAppointment[]> =>
      (await readCommittedAppointments(sql, {
        tradingDate: TRADING_DATE,
      })) as readonly ScheduledAppointment[]

    const offered = solveAvailability(solverRequest(await poolFor(), await appointmentsNow(), 10))
    const target = offered.slots.find((slot) => wall(slot.startsAt) === '19:00')
    expect(target).toBeDefined()

    const [customer] = await sql<{ id: string }[]>`
      insert into customer (phone_e164, created_via) values (${PROBE_PHONE}, 'guest_booking')
      on conflict (phone_e164) do update set created_via = excluded.created_via
      returning id
    `
    const [booking] = await sql<{ id: string }[]>`
      insert into booking (customer_id, source, notes)
      values (${(customer as { id: string }).id}, 'online', ${MARKER})
      returning id
    `
    const bookingId = (booking as { id: string }).id
    // Written as the treatment, not the padded interval: `appointment.period` stores the treatment and
    // 0024's constraints compare that column. Writing the buffered interval would double-pad it.
    const treatment = target as { treatment: { startsAt: Instant; endsAt: Instant } }
    await sql`
      insert into appointment
        (booking_id, trading_date, service_variant_id, shape, therapist_id, room_id, period, status,
         gross_price_fils)
      values (
        ${bookingId}, ${TRADING_DATE}, ${variantId}, 'solo', ${idOf('bavail04p-short')}, ${roomId},
        ${`[${new Date(treatment.treatment.startsAt).toISOString()},${new Date(treatment.treatment.endsAt).toISOString()})`}::tstzrange,
        'confirmed', 30000
      )
    `
    // It committed, which is the first half of the claim: `appointment_therapist_no_overlap` and the
    // deferred capacity trigger both accepted the tuple the read model offered.
    const [written] = await sql<{ n: string }[]>`
      select count(*)::text as n from appointment where booking_id = ${bookingId}
    `
    expect(Number(written?.n)).toBe(1)

    // The second half: the same query no longer offers it, so a second customer cannot be told yes for
    // a slot the exclusion constraint would refuse with SQLSTATE 23P01.
    const after = solveAvailability(solverRequest(await poolFor(), await appointmentsNow(), 10))
    const startsAfter = after.slots.map((slot) => wall(slot.startsAt))
    expect(startsAfter).not.toContain('19:00')
    // The buffered interval is what is held, not the treatment: 19:00–20:30 plus ten minutes either
    // side is 18:50–20:40, so 18:40 is gone too — its own buffered interval is 18:30–20:20. And the
    // ROOM is held for the turnaround as well, 19:00–20:50, which is why the only start that survives
    // is 17:10: its room interval ends at 19:00 exactly, and the periods are half-open.
    expect(startsAfter).not.toContain('18:40')
    expect(startsAfter).toEqual(['17:10'])
    // And the control: cancelling releases it, so "no longer offered" is the appointment rather than a
    // therapist this fixture quietly lost.
    await sql`update appointment set status = 'cancelled_by_salon' where booking_id = ${bookingId}`
    const released = solveAvailability(solverRequest(await poolFor(), await appointmentsNow(), 10))
    expect(released.slots.map((slot) => wall(slot.startsAt))).toContain('19:00')

    await sql`delete from appointment where booking_id = ${bookingId}`
    await sql`delete from booking where id = ${bookingId}`
  })
})

/**
 * B-AVAIL-05 — same-gender matching, in both implementations and against an unconfigured database.
 *
 * The pair is the point again: `resolveTherapistPool` applies `genderVerdict` as its seventh check and
 * `readEligibleTherapists` applies the same rule as the last arm of its `case`. Two implementations of
 * one compliance constraint is one constraint plus a future disagreement unless something compares them
 * over rows that produce it, and "the SQL forgot the gender arm" is invisible from either side alone: the
 * pool simply reads as a wider roster.
 *
 * The probe roster is B-AVAIL-04's: `bavail04p-short` is female, `bavail04p-ok` is male, and everyone
 * else has no gender on record at all — which is the real handover position (Y8-staff) and the case that
 * matters most, because an unrecorded gender must be a MISMATCH rather than a wildcard.
 */
describe('acceptance — same-gender matching is the seventh reason, in both implementations', () => {
  const genderQuery = (
    clientGender: TherapistGender | undefined,
    genderMatching?: 'strict' | 'advisory',
  ): EligibilityQuery => ({
    tradingDate: localDate(TRADING_DATE),
    requiredSkill: requiredSkillFor('asian'),
    therapistIds: allIds(),
    ...(clientGender === undefined ? {} : { clientGender }),
    ...(genderMatching === undefined ? {} : { genderMatching }),
  })

  const reasonOf = (pool: TherapistPool, reference: string): string | undefined =>
    pool.excluded.find((therapist) => therapist.therapistId === idOf(reference))?.reason

  it('lists the seven reasons in one order, and neither list has a member the other lacks', () => {
    // The runtime half of the drift guard: the compile-time half is `REASON_UNIONS_AGREE` above, which
    // catches a missing MEMBER, and this catches a different ORDER — a therapist failing two checks is
    // then reported differently by the two implementations while both lists still hold the same seven.
    expect([...EXCLUSION_REASONS]).toEqual([...ELIGIBILITY_EXCLUSION_REASONS])
    expect(EXCLUSION_REASONS.at(-1)).toBe('gender_mismatch')
    expect(REASON_UNIONS_AGREE).toEqual([true, true])
  })

  it('answers a gendered query identically, field for field', async () => {
    const { pure, database } = await bothPools(genderQuery('female'))
    expect(comparable(database)).toEqual(comparable(pure))
    // Not trivially empty on either side, and not trivially full: the female therapist survives and the
    // male one is excluded by name, so the equality is between two answers rather than two blanks.
    expect(pure.therapists.map((therapist) => therapist.therapistId)).toEqual([
      idOf('bavail04p-short'),
    ])
    expect(reasonOf(database, 'bavail04p-ok')).toBe('gender_mismatch')
    expect(reasonOf(pure, 'bavail04p-ok')).toBe('gender_mismatch')
    assertPoolIsTotal(database, allIds())
    assertPoolIsTotal(pure, allIds())

    // The other direction, so the rule is the pair and not a filter that happens to keep one person.
    const male = await bothPools(genderQuery('male'))
    expect(comparable(male.database)).toEqual(comparable(male.pure))
    expect(male.pure.therapists.map((therapist) => therapist.therapistId)).toEqual([
      idOf('bavail04p-ok'),
    ])
    expect(reasonOf(male.database, 'bavail04p-short')).toBe('gender_mismatch')
  })

  it('treats a gender nobody has recorded as a mismatch, on both sides', async () => {
    // `bavail04p-halfday` is eligible on every other count and has no gender: nineteen therapists have
    // photographs and no staff list (Y8-staff), so this is the ordinary row rather than the odd one.
    // A wildcard here would make strict matching offer a therapist whose pairing cannot be justified.
    for (const clientGender of ['female', 'male'] as const) {
      const { pure, database } = await bothPools(genderQuery(clientGender))
      expect(reasonOf(database, 'bavail04p-halfday'), clientGender).toBe('gender_mismatch')
      expect(reasonOf(pure, 'bavail04p-halfday'), clientGender).toBe('gender_mismatch')
    }
    // The control: with no client in the query the same therapist is in the pool, so "excluded" above is
    // the gender rule and not this fixture quietly losing somebody.
    const { database } = await bothPools(genderQuery(undefined))
    expect(reasonOf(database, 'bavail04p-halfday')).toBeUndefined()
  })

  it('reports an earlier reason in preference to gender, identically on both sides', async () => {
    const { pure, database } = await bothPools(genderQuery('female'))
    // Every one of these has no gender on record, so a rule applied anywhere but last would report
    // `gender_mismatch` for all of them and the six conversations the front desk can act on would be
    // replaced by one it cannot.
    const earlier = [
      ['bavail04p-ended', 'not_employed'],
      ['bavail04p-noskill', 'missing_skill'],
      ['bavail04p-nolicence', 'credential_missing'],
      ['bavail04p-lapsed', 'credential_expired'],
      ['bavail04p-unrostered', 'not_rostered'],
      ['bavail04p-onleave', 'on_approved_leave'],
    ] as const
    for (const [reference, reason] of earlier) {
      expect(reasonOf(database, reference), reference).toBe(reason)
      expect(reasonOf(pure, reference), reference).toBe(reason)
    }
    // All seven produced from real rows in one query, so none of them is dead in either implementation.
    const produced = new Set([
      ...earlier.map(([, reason]) => reason as string),
      reasonOf(database, 'bavail04p-ok') as string,
    ])
    expect([...produced].sort()).toEqual([...EXCLUSION_REASONS].sort())
  })

  it('narrows the pool only in strict mode — advisory leaves the labelling to the slot layer', async () => {
    const advisory = await bothPools(genderQuery('female', 'advisory'))
    const noClient = await bothPools(genderQuery(undefined))
    // An equality rather than an absence: a reader that narrowed under advisory as well would be
    // enforcing a mode the owner did not choose, which is the opposite failure to the one this unit is
    // mostly about and just as wrong.
    expect(comparable(advisory.database)).toEqual(comparable(advisory.pure))
    expect(comparable(advisory.database)).toEqual(comparable(noClient.database))
    expect(advisory.database.excluded.map((each) => each.reason)).not.toContain('gender_mismatch')
  })
})

describe('acceptance — with NO app_setting row, the database still enforces strict matching', () => {
  it('reads strict from an empty settings table and offers no cross-gender slot', async () => {
    // The whole of the unit's fail-safe, end to end and in one transaction: empty `app_setting`, read the
    // mode from the database rather than assuming it, feed THAT value to both implementations, and solve.
    // A test that passed `'strict'` as a literal would prove the strict path and nothing about the
    // default — and the default is what a fresh deployment actually runs on.
    //
    // The count BEFORE the probe, because the assertion after the rollback is that the table came back as it
    // was — not that it is non-empty. It asserted non-empty until M-VAT-03 ran the suite against a database
    // created that morning and found zero: nothing in a migration seeds `app_setting`, so the rows this file
    // was relying on had been written by whichever suite happened to run before it. A total that depends on a
    // foreign row is the failure docs/CONTRIBUTING-AGENT-BRIEF.md rule 12 catalogues, and it passed for weeks
    // on databases the suite had already been run against.
    const [seeded] = await sql<{ n: string }[]>`select count(*)::text as n from app_setting`
    await expect(
      sql.begin(async (tx) => {
        const scoped = tx as unknown as Sql
        await scoped`delete from app_setting`
        const [count] = await scoped<{ n: string }[]>`select count(*)::text as n from app_setting`
        expect(Number(count?.n)).toBe(0)

        const mode = await readGenderMatching(scoped)
        expect(mode).toBe('strict')

        const query: EligibilityQuery = {
          tradingDate: localDate(TRADING_DATE),
          requiredSkill: requiredSkillFor('asian'),
          therapistIds: allIds(),
          clientGender: 'female',
          genderMatching: mode,
        }
        const pool = asPool(
          await readEligibleTherapists(scoped, {
            tradingDate: TRADING_DATE,
            requiredSkill: requiredSkillFor('asian'),
            employeeIds: allIds(),
            clientGender: 'female',
            genderMatching: mode,
          }),
        )
        const facts = await readFacts()
        expect(comparable(pool)).toEqual(comparable(resolveTherapistPool(facts, query)))
        // Only the female therapist is in the pool, and she is the only one offered any slot.
        expect(pool.therapists.map((each) => each.therapistId)).toEqual([idOf('bavail04p-short')])

        const solution = solveGenderMatchedAvailability({
          ...solverRequest(pool, [], 10),
          pool,
          clientGender: 'female',
          genderMatching: mode,
        })
        expect(solution.refusal).toBeNull()
        expect(solution.slots.length).toBeGreaterThan(0)
        const offered = new Set(
          solution.slots.flatMap((slot: GenderMatchedSlot) => slot.availableTherapistIds),
        )
        expect([...offered]).toEqual([idOf('bavail04p-short')])
        expect(solution.slots.every((slot: GenderMatchedSlot) => !slot.genderMismatch)).toBe(true)

        // And a booking taken over the telephone, where nobody asked: zero slots and a reason code, not
        // an unexplained empty day.
        const noGender = solveGenderMatchedAvailability({
          ...solverRequest(pool, [], 10),
          pool,
          clientGender: undefined,
          genderMatching: mode,
        })
        expect(noGender.slots).toEqual([])
        expect(noGender.refusal).toBe('requires_client_gender')

        // Rolled back: `app_setting` is the settings suite's table too, and this file borrows it.
        throw new Error('rollback: the empty-settings probe is read-only')
      }),
    ).rejects.toThrow(/rollback: the empty-settings probe/)

    // The rollback happened, so nothing after this file sees a settings table this probe emptied. An
    // equality with what was there rather than "more than none": where the table is already empty there is
    // nothing to restore and nothing to protect, and it is the `rejects.toThrow` above plus the in-transaction
    // count of zero that prove the probe was entered and abandoned.
    const [after] = await sql<{ n: string }[]>`select count(*)::text as n from app_setting`
    expect(Number(after?.n)).toBe(Number(seeded?.n))
  })
})
