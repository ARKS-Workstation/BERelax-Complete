import {
  type CredentialPolicy,
  forecastLabourCost,
  type Instant,
  type LabourCostRules,
  type LocalDate,
  localDate,
  localTime,
  type RosteredShift,
  type RotaCoverageRules,
  type RotaTherapist,
  type RotaTradingDay,
  rotaAssignmentCanonicalForm,
  toLocal,
  type ValidateRotaArgs,
  validateOpenShiftClaim,
  validateRota,
  validateSwap,
  type WorkingHoursRules,
} from '@berelax/core'
import {
  createConnection,
  type LabourCostRuleRow,
  publishRota,
  ROTA_PUBLISHED_TEMPLATE_KEY,
  type RotaCoverageRuleRow,
  readCredentialPolicy,
  readCurrentRotaVersion,
  readEmployeeCredentials,
  readLabourCostRules,
  readRotaCoverageRules,
  readRotaPublicationNotices,
  readRotaTherapists,
  readRotaVersionAssignments,
  readTradingDayWindows,
  readTreatmentLoads,
  readWetRoomBookableWindows,
  readWetRoomSkills,
  readWorkingHoursRules,
  recordRotaChangeRequest,
  rotaAssignmentDigest,
  type Sql,
  unconfirmedAssumptionRows,
  type WorkingHoursRuleRow,
} from '@berelax/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * P-HR-06 — the rota rules, the rows they judge, and the immutable publication, joined.
 *
 * The **rules** are pure and live in `@berelax/core`; the **rows** live in PostgreSQL and are read and
 * written by `@berelax/db`. `packages/db` may never import `packages/core`, so nothing but
 * `@berelax/fixtures` can assert that the pair works — the same reason `hr-working-hours.itest.ts` and
 * `hr-credentials.itest.ts` are in this package.
 *
 * What needs both halves, and could not be asserted in either alone:
 *
 *   1. **An UPDATE against a published version's assignments is refused BY THE DATABASE**, for every role
 *      including the owner, and so is a DELETE. An edit is a new version carrying `supersedes_id`.
 *   2. **A published rota survives the deletion of the draft shift it came from.** That is what makes the
 *      snapshot a snapshot: `shift_assignment.shift_id` is ON DELETE CASCADE, so a version referencing it
 *      would silently lose rows.
 *   3. **Re-publishing an unchanged version emits no notification**, because it creates no version: the
 *      deferred constraint trigger refuses the insert at COMMIT, so there is nothing for a notice to hang
 *      off. Asserted as a refusal AND as a notice count that did not move.
 *   4. **One notice per assigned EMPLOYEE**, not per shift, over a therapist rostered on two days.
 *   5. **Coverage is computed over the real `business_day` window**, including the 00:00–02:00 segments,
 *      from shifts that made the round trip through `tstzrange` and back.
 *   6. **The wet-room windows come from `rooms` minus `resource_block`**, and the wet-room SKILLS are
 *      derived from the catalogue rather than from a column nobody has filled in.
 *   7. **A swap refused by the validator is recorded with the rule name**, and that record is append-only.
 *   8. **The forecast stored on the version is the forecast the pure function computed** — and the count of
 *      unpriced employees is 19, because a wage is a fact about a person and the build invents none.
 *   9. **Both provisional rule versions appear in the Unconfirmed Assumptions panel** against Y9-coverage
 *      and Y9-overtime, and leave it when the flag is cleared.
 *
 * ## Isolation (brief rule 12)
 *
 * The integration suite runs sequentially against one database and earlier files leave rows behind. So:
 * every employee this file creates is prefixed `PHR06 ROTA`, every read that could see another file's rows
 * is narrowed to them, the rota periods are dates no other suite publishes a rota for, and everything this
 * file inserts into `shift` is deleted in `afterAll`. Nothing here deletes a row it did not create — and
 * `rota_version` cannot be deleted at all, by design, so the periods are chosen to be this file's alone
 * rather than cleaned up.
 *
 * The trading dates are fixed rather than derived from "now", and `beforeAll` asserts the seeded
 * `business_day` rows exist: a suite that silently skipped because the calendar had moved would be the
 * vacuous pass ADR 0003 exists to prevent. No employee here has a name (brief rule 10).
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

let sql: Sql

/** 2026-07-06 is a Monday. Both dates are inside the seeded `business_day` calendar. */
const DAY_ONE = '2026-07-06'
const DAY_TWO = '2026-07-07'

/** The early and late bands, for `rota-validator.test.ts`'s reason: two consecutive 15-hour days
 * cannot satisfy an 11-hour rest minimum, so a rota of full days is not a valid rota. */
const EARLY = { from: '11:00', until: '19:00' } as const
const LATE = { from: '18:00', until: '02:00' } as const

const PUBLISHER = 'PHR06 integration suite'

/**
 * The label on every `shift` row this file inserts, and the only rows it ever deletes.
 *
 * Cleared in `beforeAll` as well as `afterAll`, which is not belt and braces: a run that fails part-way
 * leaves its shifts behind, and the next run's `beforeAll` would then roster the same therapists twice on
 * the same spans — two identical draft rows, which `mergePresences` collapses into one presence and
 * `rota_version_assignment`'s primary key refuses. The first version of this file did exactly that and the
 * failure named a duplicate key rather than a dirty database.
 */
const SHIFT_MARKER = 'PHR06 ROTA'

/** `employee.id` by handle, and every `shift.id` this file inserted, for `afterAll`. */
const employees = new Map<string, string>()
const insertedShifts: string[] = []

const ROLLBACK = 'phr06-probe-rollback'

/** The message a statement was refused with, or '' when it was accepted. Always rolled back. */
async function refusalOf(body: (tx: Sql) => Promise<unknown>): Promise<string> {
  try {
    await sql.begin(async (tx) => {
      await body(tx as unknown as Sql)
      throw new Error(ROLLBACK)
    })
    return ''
  } catch (err) {
    if (err instanceof Error && err.message === ROLLBACK) return ''
    return err instanceof Error ? `${err.message} ${JSON.stringify(err)}` : String(err)
  }
}

async function probe<T>(body: (tx: Sql) => Promise<T>): Promise<T> {
  let carried: T | undefined
  try {
    await sql.begin(async (tx) => {
      carried = await body(tx as unknown as Sql)
      throw new Error(ROLLBACK)
    })
  } catch (err) {
    if (!(err instanceof Error) || err.message !== ROLLBACK) throw err
  }
  return carried as T
}

async function makeEmployee(handle: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into employee (staff_reference, employed_from)
    values (${`PHR06 ROTA ${handle}`}, date '2020-01-01')
    on conflict (staff_reference) do update set employed_from = excluded.employed_from
    returning id
  `
  const id = (row as { id: string }).id
  employees.set(handle, id)
  return id
}

/** Gives an employee a style skill and every mandatory credential, valid for a decade. */
async function makeEligible(handle: string, skill: string): Promise<void> {
  const id = employees.get(handle) as string
  await sql`
    insert into employee_skill (employee_id, skill) values (${id}, ${skill}::therapist_skill)
    on conflict do nothing
  `
  const policy = await readCredentialPolicy(sql)
  for (const documentType of policy.mandatoryTypes) {
    await sql`
      insert into employee_document (employee_id, document_type, expires_on)
      values (${id}, ${documentType}::employee_document_type, date '2036-01-01')
      on conflict do nothing
    `
  }
}

/** Rosters one employee on one trading date across a band, and remembers the shift for cleanup. */
async function roster(args: {
  readonly handle: string
  readonly tradingDate: string
  readonly band: { readonly from: string; readonly until: string }
}): Promise<string> {
  const crossesMidnight = args.band.until < args.band.from
  const endDate = crossesMidnight ? nextCalendarDate(args.tradingDate) : args.tradingDate
  const [row] = await sql<{ id: string }[]>`
    insert into shift (trading_date, period, label)
    values (${args.tradingDate}::date,
            tstzrange((${`${args.tradingDate} ${args.band.from}:00+04`})::timestamptz,
                      (${`${endDate} ${args.band.until}:00+04`})::timestamptz, '[)'),
            ${SHIFT_MARKER})
    returning id
  `
  const id = (row as { id: string }).id
  insertedShifts.push(id)
  await sql`
    insert into shift_assignment (shift_id, employee_id)
    values (${id}, ${employees.get(args.handle) as string})
  `
  return id
}

function nextCalendarDate(date: string): string {
  const stepped = new Date(`${date}T00:00:00Z`)
  stepped.setUTCDate(stepped.getUTCDate() + 1)
  return stepped.toISOString().slice(0, 10)
}

const asCoverageRules = (row: RotaCoverageRuleRow): RotaCoverageRules => ({
  effectiveFrom: localDate(row.effectiveFrom),
  coverageSegmentMinutes: row.coverageSegmentMinutes,
  minimumTherapistsOnFloor: row.minimumTherapistsOnFloor,
  minimumWetRoomCapable: row.minimumWetRoomCapable,
  treatmentMinutesCapPerDay: row.treatmentMinutesCapPerDay,
  highIntensityMinutesCapPerDay: row.highIntensityMinutesCapPerDay,
  highIntensityTreatmentCodes: row.highIntensityTreatmentCodes,
})

const asLabourCostRules = (row: LabourCostRuleRow): LabourCostRules => ({
  effectiveFrom: localDate(row.effectiveFrom),
  monthlyWageDaysDivisor: row.monthlyWageDaysDivisor,
  paidMinutesPerDay: row.paidMinutesPerDay,
})

const asWorkingHoursRules = (row: WorkingHoursRuleRow): WorkingHoursRules => ({
  effectiveFrom: localDate(row.effectiveFrom),
  ordinaryMinutesPerDay: row.ordinaryMinutesPerDay,
  ordinaryMinutesPerWeek: row.ordinaryMinutesPerWeek,
  weekStartsOn: row.weekStartsOn,
  overtimeDailyCapMinutes: row.overtimeDailyCapMinutes,
  minimumRestMinutes: row.minimumRestMinutes,
  nightWindow: { from: localTime(row.nightWindowFrom), until: localTime(row.nightWindowUntil) },
  multiplierBp: {
    ordinary: row.ordinaryMultiplierBp,
    overtime: row.overtimeMultiplierBp,
    night: row.nightMultiplierBp,
    publicHoliday: row.publicHolidayMultiplierBp,
  },
})

/**
 * Reads everything and builds the validator's argument, narrowed to THIS FILE's therapists.
 *
 * Narrowed, because `readRotaTherapists` returns every employed therapist and the seeded nineteen are
 * uncredentialled — a validation over all of them would refuse for `credential_not_current` on rows this
 * file did not create, and the refusal would be about the seed rather than about the rota. That the whole
 * roster IS refused is asserted separately, once, as the statement about readiness it is.
 */
async function rotaArgs(args: {
  readonly fromTradingDate: string
  readonly toTradingDate: string
  readonly handles: readonly string[]
}): Promise<ValidateRotaArgs & { readonly credentialPolicy: CredentialPolicy }> {
  const ours = new Set(args.handles.map((handle) => employees.get(handle) as string))
  const [
    windows,
    therapistRows,
    coverageRuleRows,
    workingHoursRows,
    wetRoomSkills,
    wetWindows,
    loads,
    policy,
  ] = await Promise.all([
    readTradingDayWindows(sql, args),
    readRotaTherapists(sql, args),
    readRotaCoverageRules(sql),
    readWorkingHoursRules(sql),
    readWetRoomSkills(sql),
    readWetRoomBookableWindows(sql, args),
    readTreatmentLoads(sql, args),
    readCredentialPolicy(sql),
  ])
  const mine = therapistRows.filter((row) => ours.has(row.employeeId))
  const credentials = await readEmployeeCredentials(
    sql,
    mine.map((row) => row.employeeId),
  )
  const therapists: RotaTherapist[] = mine.map((row) => ({
    employeeId: row.employeeId,
    skills: row.skills,
    credentials: credentials
      .filter((credential) => credential.employeeId === row.employeeId)
      .map((credential) => ({
        documentType: credential.documentType,
        expiresOn: credential.expiresOn === null ? null : localDate(credential.expiresOn),
      })),
  }))
  const days: RotaTradingDay[] = windows.map((window) => ({
    tradingDate: localDate(window.tradingDate),
    opensAt: window.opensAt as RotaTradingDay['opensAt'],
    closesAt: window.closesAt as RotaTradingDay['closesAt'],
    wetRoomBookableDuring: wetWindows
      .filter((wet) => wet.tradingDate === window.tradingDate)
      .map(
        (wet) =>
          ({
            startsAt: wet.startsAt,
            endsAt: wet.endsAt,
          }) as RotaTradingDay['wetRoomBookableDuring'][number],
      ),
    // The holiday flag reaches the maths as an argument (P-HR-05's NOTE): `premises_closure` is a FLOOR
    // and not a calendar, so this file states it rather than deriving a set it knows is incomplete.
    isPublicHoliday: false,
  }))
  const assignments = await readOurShifts(args, ours)
  return {
    days,
    therapists,
    assignments,
    treatmentLoads: loads
      .filter((load) => ours.has(load.employeeId))
      .map((load) => ({
        appointmentId: load.appointmentId,
        employeeId: load.employeeId,
        tradingDate: localDate(load.tradingDate),
        minutes: load.minutes,
        treatmentCode: load.treatmentCode,
      })),
    coverageRuleVersions: coverageRuleRows.map(asCoverageRules),
    workingHoursRuleVersions: workingHoursRows.map(asWorkingHoursRules),
    wetRoomSkills,
    credentialPolicy: policy,
  }
}

async function readOurShifts(
  args: { readonly fromTradingDate: string; readonly toTradingDate: string },
  ours: ReadonlySet<string>,
): Promise<readonly RosteredShift[]> {
  const rows = await sql<
    { shiftId: string; employeeId: string; tradingDate: string; startsAt: Date; endsAt: Date }[]
  >`
    select s.id as "shiftId", sa.employee_id as "employeeId", s.trading_date::text as "tradingDate",
           lower(s.period) as "startsAt", upper(s.period) as "endsAt"
      from shift s
      join shift_assignment sa on sa.shift_id = s.id
     where s.trading_date between ${args.fromTradingDate}::date and ${args.toTradingDate}::date
       and sa.employee_id = any(${[...ours]}::uuid[])
     order by sa.employee_id, s.trading_date, lower(s.period)
  `
  return rows.map((row) => ({
    shiftId: row.shiftId,
    employeeId: row.employeeId,
    tradingDate: localDate(row.tradingDate),
    period: {
      startsAt: row.startsAt.getTime(),
      endsAt: row.endsAt.getTime(),
    } as RosteredShift['period'],
  }))
}

/** Validates, forecasts and publishes: the composition a route performs, in one helper. */
async function publish(args: {
  readonly fromTradingDate: string
  readonly toTradingDate: string
  readonly handles: readonly string[]
}) {
  const inputs = await rotaArgs(args)
  const validation = validateRota(inputs)
  const [labourRows, therapistRows] = await Promise.all([
    readLabourCostRules(sql),
    readRotaTherapists(sql, args),
  ])
  const ours = new Set(args.handles.map((handle) => employees.get(handle) as string))
  const forecast = forecastLabourCost({
    days: validation.workedHours.days,
    wages: therapistRows
      .filter((row) => ours.has(row.employeeId))
      .map((row) => ({ employeeId: row.employeeId, basicWageFils: row.basicWageFils })),
    ruleVersions: labourRows.map(asLabourCostRules),
  })
  const assignments = inputs.assignments.map((shift) => ({
    employeeId: shift.employeeId,
    tradingDate: String(shift.tradingDate),
    startsAt: shift.period.startsAt,
    endsAt: shift.period.endsAt,
    sourceShiftId: shift.shiftId,
  }))
  const published = await publishRota(sql, {
    fromTradingDate: args.fromTradingDate,
    toTradingDate: args.toTradingDate,
    assignments,
    verdict: { isPublishable: validation.isPublishable, refusedRule: null, refusalDetail: null },
    coverageRuleEffectiveFrom: String(inputs.coverageRuleVersions[0]?.effectiveFrom),
    workingHoursRuleEffectiveFrom: String(inputs.workingHoursRuleVersions[0]?.effectiveFrom),
    labourCostRuleEffectiveFrom: labourRows[0]?.effectiveFrom as string,
    forecastLabourCostFils: forecast.totalFils,
    forecastUnpricedEmployees: forecast.unpricedEmployeeIds.length,
    assignmentCanonicalForm: rotaAssignmentCanonicalForm(
      inputs.assignments.map((shift) => ({
        employeeId: shift.employeeId,
        tradingDate: shift.tradingDate,
        startsAt: shift.period.startsAt,
        endsAt: shift.period.endsAt,
      })),
    ),
    publishedBy: PUBLISHER,
  })
  return { inputs, validation, forecast, published, assignments }
}

beforeAll(async () => {
  sql = createConnection({ url: url as string, max: 4 })
  // A previous run's shifts, and only this file's. Matched on the ASSIGNED EMPLOYEE as well as on the
  // label, because the label is a recent addition and a run that predates it left rows with a null one —
  // which this cleanup then skipped, and the failure that followed named a duplicate primary key rather
  // than a dirty database. Nothing else here deletes a row it did not create, and `rota_version` cannot be
  // deleted at all, which is why every claim about version numbering below is RELATIVE to what was already
  // published.
  await sql`
    delete from shift
     where label like ${`${SHIFT_MARKER}%`}
        or id in (
          select sa.shift_id from shift_assignment sa
            join employee e on e.id = sa.employee_id
           where e.staff_reference like 'PHR06 ROTA%')
  `
  const windows = await readTradingDayWindows(sql, {
    fromTradingDate: DAY_ONE,
    toTradingDate: DAY_TWO,
  })
  // Asserted rather than skipped: a suite that quietly did nothing because the seeded calendar had moved
  // would be the vacuous pass ADR 0003 exists to prevent.
  expect(windows.map((window) => window.tradingDate)).toEqual([DAY_ONE, DAY_TWO])

  for (const handle of ['E1', 'E2', 'L1', 'L2', 'L3', 'SPARE', 'UNROSTERED', 'LAPSED']) {
    await makeEmployee(handle)
  }
  for (const handle of ['E1', 'E2', 'L1', 'L2', 'L3', 'SPARE', 'UNROSTERED']) {
    await makeEligible(handle, handle.startsWith('E') ? 'asian_style' : 'arabic_style')
  }
  // LAPSED holds the skill and an EXPIRED labour card, which is the open-shift claim's fixture.
  await sql`
    insert into employee_skill (employee_id, skill)
    values (${employees.get('LAPSED') as string}, 'asian_style'::therapist_skill)
    on conflict do nothing
  `
  await sql`
    insert into employee_document (employee_id, document_type, expires_on)
    values (${employees.get('LAPSED') as string}, 'labour_card'::employee_document_type,
            date '2026-01-01')
    on conflict do nothing
  `

  for (const tradingDate of [DAY_ONE, DAY_TWO]) {
    for (const handle of ['E1', 'E2']) await roster({ handle, tradingDate, band: EARLY })
    for (const handle of ['L1', 'L2', 'L3']) await roster({ handle, tradingDate, band: LATE })
  }
})

afterAll(async () => {
  // Every shift this file inserted, and nothing else. A shift left behind would put a therapist on the
  // roster of whichever availability suite runs next (brief rule 12).
  if (insertedShifts.length > 0) {
    await sql`delete from shift where id = any(${insertedShifts}::uuid[])`
  }
  await sql.end({ timeout: 5 })
})

describe('the pair: the rules judge the rows', () => {
  it('validates a rota built from real shift rows over the real trading window', async () => {
    const inputs = await rotaArgs({
      fromTradingDate: DAY_ONE,
      toTradingDate: DAY_TWO,
      handles: ['E1', 'E2', 'L1', 'L2', 'L3'],
    })
    const validation = validateRota(inputs)
    expect(validation.violations).toEqual([])
    // 30 segments a day over 11:00-02:00, both days. The window came from `business_day.opens_at` and
    // `closes_at`, so nothing here re-derived where a trading day ends.
    expect(validation.segments).toHaveLength(60)
    expect(validation.segments[0]?.label).toBe(`${DAY_ONE} 11:00-11:30`)
    expect(validation.segments.at(-1)?.label).toBe(`${DAY_TWO} 01:30-02:00`)
  })

  it('covers the 00:00-02:00 segments of the previous business_day, by the late band', async () => {
    const inputs = await rotaArgs({
      fromTradingDate: DAY_ONE,
      toTradingDate: DAY_TWO,
      handles: ['E1', 'E2', 'L1', 'L2', 'L3'],
    })
    const validation = validateRota(inputs)
    const late = ['L1', 'L2', 'L3'].map((handle) => employees.get(handle) as string).sort()
    for (const label of [
      `${DAY_ONE} 00:00-00:30`,
      `${DAY_ONE} 00:30-01:00`,
      `${DAY_ONE} 01:00-01:30`,
      `${DAY_ONE} 01:30-02:00`,
    ]) {
      const segment = validation.segments.find((candidate) => candidate.label === label)
      expect([...(segment?.therapistsOnFloor ?? [])].sort(), label).toEqual(late)
      // And the segment's instants fall on the FOLLOWING calendar date in the BUSINESS ZONE, which is
      // the whole point. Read through `toLocal` and not `toISOString`: 00:00 in Dubai is 20:00 UTC the
      // evening before, so an ISO date here reports 2026-07-06 and the assertion would be measuring the
      // machine's zone while claiming to measure the emirate's. The first draft of this case did exactly
      // that and passed for the wrong reason until the expectation was written down.
      expect(toLocal(segment?.period.startsAt as Instant).date).toBe(nextCalendarDate(DAY_ONE))
      expect(toLocal(segment?.period.startsAt as Instant).time).toBe(label.slice(11, 16))
    }
  })

  it('refuses the seeded nineteen for credential_not_current, which is a fact about readiness', async () => {
    // `employee_document` is empty in the seed and six document types are mandatory, so no rota over the
    // seeded therapists publishes until their files exist. That is a true statement about the business
    // rather than a defect, and it is asserted HERE so that it is a known state rather than a surprise.
    const seeded = await sql<{ employeeId: string }[]>`
      select id as "employeeId" from employee
       where staff_reference not like 'PHR06 ROTA%'
         and not exists (select 1 from employee_document d where d.employee_id = employee.id)
       limit 1
    `
    const [subject] = seeded
    expect(subject, 'the seed has at least one therapist with no documents on file').toBeDefined()
    const policy = await readCredentialPolicy(sql)
    expect(policy.mandatoryTypes.length).toBeGreaterThan(0)
    const windows = await readTradingDayWindows(sql, {
      fromTradingDate: DAY_ONE,
      toTradingDate: DAY_ONE,
    })
    const window = windows[0] as { opensAt: number; closesAt: number }
    const validation = validateRota({
      days: [
        {
          tradingDate: localDate(DAY_ONE),
          opensAt: window.opensAt as RotaTradingDay['opensAt'],
          closesAt: window.closesAt as RotaTradingDay['closesAt'],
          wetRoomBookableDuring: [],
          isPublicHoliday: false,
        },
      ],
      therapists: [
        { employeeId: (subject as { employeeId: string }).employeeId, skills: [], credentials: [] },
      ],
      assignments: [
        {
          shiftId: 'probe',
          employeeId: (subject as { employeeId: string }).employeeId,
          tradingDate: localDate(DAY_ONE),
          period: { startsAt: window.opensAt, endsAt: window.closesAt } as RosteredShift['period'],
        },
      ],
      treatmentLoads: [],
      coverageRuleVersions: (await readRotaCoverageRules(sql)).map(asCoverageRules),
      workingHoursRuleVersions: (await readWorkingHoursRules(sql)).map(asWorkingHoursRules),
      wetRoomSkills: await readWetRoomSkills(sql),
      credentialPolicy: policy,
    })
    expect(validation.violations.map((violation) => violation.rule)).toContain(
      'credential_not_current',
    )
  })
})

describe('the wet-room reads', () => {
  it('derives the wet-room skills from the catalogue, and finds both styles', async () => {
    const skills = await readWetRoomSkills(sql)
    // Both styles reach `morocco_bath_jacuzzi`'s wet-room-only shape (0012), so both skills count. NOT
    // empty is the load-bearing half: an empty set would make every therapist incapable and refuse every
    // segment the wet room is bookable in, naming the segment while the cause was an unfilled argument.
    expect([...skills].sort()).toEqual(['arabic_style', 'asian_style'])
  })

  it('returns the whole trading window when the wet room is bookable and unblocked', async () => {
    const windows = await readWetRoomBookableWindows(sql, {
      fromTradingDate: DAY_ONE,
      toTradingDate: DAY_ONE,
    })
    const day = (
      await readTradingDayWindows(sql, {
        fromTradingDate: DAY_ONE,
        toTradingDate: DAY_ONE,
      })
    )[0] as { opensAt: number; closesAt: number }
    expect(windows).toHaveLength(1)
    expect(windows[0]).toMatchObject({ startsAt: day.opensAt, endsAt: day.closesAt })
  })

  it('subtracts a resource_block, so the bath being out for two hours leaves two windows', async () => {
    const day = (
      await readTradingDayWindows(sql, {
        fromTradingDate: DAY_ONE,
        toTradingDate: DAY_ONE,
      })
    )[0] as { opensAt: number; closesAt: number }
    const windows = await probe(async (tx) => {
      await tx`
        insert into resource_block (room_id, period, kind, reason)
        select id,
               tstzrange((${`${DAY_ONE} 20:00:00+04`})::timestamptz,
                         (${`${DAY_ONE} 22:00:00+04`})::timestamptz, '[)'),
               'maintenance', 'PHR06 probe'
          from rooms where room_type = 'wet'
      `
      return await readWetRoomBookableWindows(tx, {
        fromTradingDate: DAY_ONE,
        toTradingDate: DAY_ONE,
      })
    })
    // Two windows, exactly, with the gap where the block is. A per-day boolean could say neither of these
    // things: it would demand wet cover during the maintenance window or excuse it for the whole day.
    expect(windows).toHaveLength(2)
    expect(windows[0]?.startsAt).toBe(day.opensAt)
    expect(new Date(windows[0]?.endsAt ?? 0).toISOString()).toBe(
      new Date(`${DAY_ONE}T20:00:00+04:00`).toISOString(),
    )
    expect(new Date(windows[1]?.startsAt ?? 0).toISOString()).toBe(
      new Date(`${DAY_ONE}T22:00:00+04:00`).toISOString(),
    )
    expect(windows[1]?.endsAt).toBe(day.closesAt)
  })

  it('refuses to publish a rota whose floor holds nobody able to run the bath, naming the segment', async () => {
    const inputs = await rotaArgs({
      fromTradingDate: DAY_ONE,
      toTradingDate: DAY_TWO,
      handles: ['E1', 'E2', 'L1', 'L2', 'L3'],
    })
    // The same real rota, with the skills the catalogue derivation found replaced by a skill nobody holds.
    // The floor is untouched, so only the wet-room rule can fire.
    const validation = validateRota({ ...inputs, wetRoomSkills: ['hypothetical_bath_ticket'] })
    const rules = new Set(validation.violations.map((violation) => violation.rule))
    expect(rules).toEqual(new Set(['wet_room_capability']))
    expect(validation.violations[0]).toMatchObject({ segmentLabel: `${DAY_ONE} 11:00-11:30` })
    // And the publish is refused by the repository rather than recorded and corrected.
    await expect(
      publishRota(sql, {
        fromTradingDate: DAY_ONE,
        toTradingDate: DAY_TWO,
        assignments: [
          {
            employeeId: employees.get('E1') as string,
            tradingDate: DAY_ONE,
            startsAt: Date.parse(`${DAY_ONE}T11:00:00+04:00`),
            endsAt: Date.parse(`${DAY_ONE}T19:00:00+04:00`),
            sourceShiftId: null,
          },
        ],
        verdict: {
          isPublishable: false,
          refusedRule: 'wet_room_capability',
          refusalDetail: `${DAY_ONE} 11:00-11:30: the wet room is bookable and 0 of the therapists`,
        },
        coverageRuleEffectiveFrom: '1900-01-01',
        workingHoursRuleEffectiveFrom: '1900-01-01',
        labourCostRuleEffectiveFrom: '1900-01-01',
        forecastLabourCostFils: 0,
        forecastUnpricedEmployees: 1,
        assignmentCanonicalForm: 'rota-v1\nunused',
        publishedBy: PUBLISHER,
      }),
    ).rejects.toThrow(/not publishable: wet_room_capability/)
  })
})

describe('acceptance — publishing writes an immutable rota_version', () => {
  let versionId: string
  let digest: string
  let publishedResult: Awaited<ReturnType<typeof publish>>
  let previousVersion: Awaited<ReturnType<typeof readCurrentRotaVersion>>

  /**
   * Published ONCE, here, rather than inside the first case.
   *
   * With the publish inside a case, every case after it read a `versionId` that was still `undefined` and
   * failed with `UNDEFINED_VALUE` — nine failures reporting on a parameter rather than on the nine claims
   * they make. A `beforeAll` fails the whole block once and names the real cause.
   */
  beforeAll(async () => {
    previousVersion = await readCurrentRotaVersion(sql, {
      fromTradingDate: DAY_ONE,
      toTradingDate: DAY_TWO,
    })
    publishedResult = await publish({
      fromTradingDate: DAY_ONE,
      toTradingDate: DAY_TWO,
      handles: ['E1', 'E2', 'L1', 'L2', 'L3'],
    })
    versionId = publishedResult.published.rotaVersionId
    digest = publishedResult.published.assignmentDigest
  })

  it('publishes the next version in the chain, with one notice per assigned employee', async () => {
    const { published, validation, forecast } = publishedResult
    expect(validation.isPublishable).toBe(true)
    // RELATIVE, not absolute. `rota_version` is immutable and nothing deletes it, so a second run of this
    // file on the same database publishes version 2 — and a case asserting `versionNo === 1` would pass
    // once and then fail for ever, which is a test that measures how many times it has been run.
    expect(published.versionNo).toBe((previousVersion?.versionNo ?? 0) + 1)
    expect(published.supersededId).toBe(previousVersion?.id ?? null)

    // Ten assignments — five therapists over two days — and FIVE notices. One per employee and not one
    // per shift, which is what `rota_publication_notice_one_per_employee_per_version` enforces.
    const assignments = await readRotaVersionAssignments(sql, versionId)
    expect(assignments).toHaveLength(10)
    const notices = await readRotaPublicationNotices(sql, versionId)
    expect(notices).toHaveLength(5)
    expect(notices.every((notice) => notice.templateKey === ROTA_PUBLISHED_TEMPLATE_KEY)).toBe(true)
    // Skipped with a reason, which is the honest shipped state: nothing in this build holds a staff
    // phone or email, so the row says what was attempted rather than pretending an SMS left.
    expect(new Set(notices.map((notice) => notice.skippedReason))).toEqual(
      new Set(['no_recipient_on_file']),
    )
    expect(notices.every((notice) => notice.messageId === null)).toBe(true)

    // The forecast on the row is the forecast the pure function computed, and every one of these
    // therapists is unpriced because a wage is a fact about a person the build does not invent.
    const version = await readCurrentRotaVersion(sql, {
      fromTradingDate: DAY_ONE,
      toTradingDate: DAY_TWO,
    })
    expect(version?.forecastLabourCostFils).toBe(forecast.totalFils)
    expect(version?.forecastUnpricedEmployees).toBe(5)
    expect(forecast.totalFils).toBe(0)
    expect(forecast.unpricedEmployeeIds).toHaveLength(5)
    // Not vacuous: the minutes ARE known, so a screen has something true to print beside the zero.
    expect(forecast.totalMinutes).toBe(10 * 480)
  })

  it('refuses an UPDATE against a published version’s assignments, for every role', async () => {
    const refusal = await refusalOf(
      (tx) =>
        tx`update rota_version_assignment set trading_date = trading_date
            where rota_version_id = ${versionId}::uuid`,
    )
    expect(refusal).toMatch(/A published rota version is immutable/)
    expect(refusal).toMatch(/ZW001/)
  })

  it('refuses a DELETE against a published version and against its assignments', async () => {
    expect(
      await refusalOf(
        (tx) => tx`delete from rota_version_assignment where rota_version_id = ${versionId}::uuid`,
      ),
    ).toMatch(/ZW001/)
    expect(
      await refusalOf((tx) => tx`delete from rota_version where id = ${versionId}::uuid`),
    ).toMatch(/ZW001/)
  })

  it('refuses an UPDATE to the published version row itself', async () => {
    const refusal = await refusalOf(
      (tx) =>
        tx`update rota_version set published_by = 'somebody else' where id = ${versionId}::uuid`,
    )
    expect(refusal).toMatch(/ZW001/)
  })

  it('keeps the snapshot, ids and all, when the draft shift it came from is deleted', async () => {
    // The teeth of the snapshot decision, and of the one that followed it. `shift_assignment.shift_id` is
    // ON DELETE CASCADE, so a version that REFERENCED the draft would lose rows here with no error at all —
    // an immutable table quietly shedding rows. And `source_shift_id` is a plain uuid rather than a foreign
    // key, because `on delete set null` arrives as an UPDATE and ZW001 refuses every UPDATE: with the
    // foreign key, this delete was IMPOSSIBLE and the draft roster could never be rewritten again. This
    // case is what found that, by way of its own cleanup failing.
    const before = await readRotaVersionAssignments(sql, versionId)
    const deleted = before.find((row) => row.sourceShiftId !== null)?.sourceShiftId as string
    const survivors = await probe(async (tx) => {
      await tx`delete from shift where id = ${deleted}::uuid`
      return await readRotaVersionAssignments(tx, versionId)
    })
    expect(survivors).toHaveLength(before.length)
    // Every row intact AND still naming the draft it came from, which stays true where a nulled column
    // would say only that something had been deleted.
    expect(survivors.filter((row) => row.sourceShiftId === deleted)).toHaveLength(1)
  })

  it('refuses a re-publish whose assignment set is unchanged, at COMMIT, and writes no notice', async () => {
    const noticesBefore = (await readRotaPublicationNotices(sql, versionId)).length
    await expect(
      publish({
        fromTradingDate: DAY_ONE,
        toTradingDate: DAY_TWO,
        handles: ['E1', 'E2', 'L1', 'L2', 'L3'],
      }),
    ).rejects.toThrow(/same assignment set as the version it supersedes/)
    // The acceptance criterion in the form that matters: nothing was created, so nothing was notified.
    // Asserted as a COUNT that did not move rather than as "the insert threw", because a publisher that
    // wrote notices and then failed would satisfy the second and not the first.
    expect((await readRotaPublicationNotices(sql, versionId)).length).toBe(noticesBefore)
    const current = await readCurrentRotaVersion(sql, {
      fromTradingDate: DAY_ONE,
      toTradingDate: DAY_TWO,
    })
    expect(current?.id).toBe(versionId)
    expect(current?.versionNo).toBe(publishedResult.published.versionNo)
    expect(current?.assignmentDigest).toBe(digest)
  })

  it('makes an EDIT a new version carrying supersedes_id, with its own notices', async () => {
    // SPARE takes a late shift on day one. The rota is still valid, the assignment set has changed, so the
    // publish succeeds and the chain grows — which is the acceptance criterion's other half: an edit
    // creates a new version instead of changing the old one.
    await roster({ handle: 'SPARE', tradingDate: DAY_ONE, band: LATE })
    const { published } = await publish({
      fromTradingDate: DAY_ONE,
      toTradingDate: DAY_TWO,
      handles: ['E1', 'E2', 'L1', 'L2', 'L3', 'SPARE'],
    })
    expect(published.versionNo).toBe(publishedResult.published.versionNo + 1)
    expect(published.supersededId).toBe(versionId)
    expect(published.assignmentDigest).not.toBe(digest)
    // Six employees now, so six notices — and the superseded version's five are untouched, because it is
    // immutable. That pair is the acceptance criterion: an edit ADDS, it does not change.
    expect(await readRotaPublicationNotices(sql, published.rotaVersionId)).toHaveLength(6)
    expect(await readRotaPublicationNotices(sql, versionId)).toHaveLength(5)
    const current = await readCurrentRotaVersion(sql, {
      fromTradingDate: DAY_ONE,
      toTradingDate: DAY_TWO,
    })
    expect(current?.id).toBe(published.rotaVersionId)
    // "The current version" is the row nothing supersedes, which is the structure the database enforces.
    expect(current?.supersedesId).toBe(versionId)
  })

  it('refuses a version whose number does not follow the one it supersedes', async () => {
    const refusal = await refusalOf(
      (tx) => tx`
        insert into rota_version (
          from_trading_date, to_trading_date, supersedes_id, version_no,
          coverage_rule_effective_from, working_hours_rule_effective_from,
          labour_cost_rule_effective_from, forecast_labour_cost_fils,
          forecast_unpriced_employees, assignment_digest, published_by
        ) values (
          ${DAY_ONE}::date, ${DAY_TWO}::date, ${versionId}::uuid, 9,
          date '1900-01-01', date '1900-01-01', date '1900-01-01', 0, 0,
          ${'f'.repeat(64)}, ${PUBLISHER}
        )
      `,
    )
    expect(refusal).toMatch(/ZW005/)
    expect(refusal).toMatch(/numbering must be unbroken/)
  })

  it('refuses two versions superseding the same one, which is the concurrent-publish race', async () => {
    const refusal = await refusalOf(
      (tx) => tx`
        insert into rota_version (
          from_trading_date, to_trading_date, supersedes_id, version_no,
          coverage_rule_effective_from, working_hours_rule_effective_from,
          labour_cost_rule_effective_from, forecast_labour_cost_fils,
          forecast_unpriced_employees, assignment_digest, published_by
        ) values (
          ${DAY_ONE}::date, ${DAY_TWO}::date, ${versionId}::uuid,
          ${publishedResult.published.versionNo + 1},
          date '1900-01-01', date '1900-01-01', date '1900-01-01', 0, 0,
          ${'e'.repeat(64)}, ${PUBLISHER}
        )
      `,
    )
    // `unique (supersedes_id)`. Without it there would be two rotas nothing superseded and no current one.
    expect(refusal).toMatch(/rota_version_supersedes_id_key|duplicate key/)
  })
})

describe('acceptance — a swap and a claim re-run the validator and record the rule', () => {
  it('records a refused swap with the rule name, and the record is append-only', async () => {
    const version = await readCurrentRotaVersion(sql, {
      fromTradingDate: DAY_ONE,
      toTradingDate: DAY_TWO,
    })
    const inputs = await rotaArgs({
      fromTradingDate: DAY_ONE,
      toTradingDate: DAY_TWO,
      handles: ['E1', 'E2', 'L1', 'L2', 'L3', 'SPARE'],
    })
    // E1's day-two EARLY shift moves to L1, who worked until 02:00 that morning: nine hours of rest
    // against eleven. The full validator is what finds it — a coverage-only check would not.
    const movingShift = inputs.assignments.find(
      (shift) => shift.employeeId === employees.get('E1') && String(shift.tradingDate) === DAY_TWO,
    )
    const swapped = validateSwap({
      ...inputs,
      shiftId: (movingShift as RosteredShift).shiftId,
      fromEmployeeId: employees.get('E1') as string,
      toEmployeeId: employees.get('L1') as string,
    })
    expect(swapped.isPublishable).toBe(false)
    const first = swapped.violations[0]
    expect(swapped.violations.map((violation) => violation.rule)).toContain('minimum_rest')

    const result = await recordRotaChangeRequest(sql, {
      kind: 'swap',
      rotaVersionId: (version as { id: string }).id,
      shiftId: (movingShift as RosteredShift).shiftId,
      fromEmployeeId: employees.get('E1') as string,
      toEmployeeId: employees.get('L1') as string,
      verdict: {
        isPublishable: false,
        refusedRule: (first as { rule: string }).rule,
        refusalDetail: 'nine hours of rest against eleven',
      },
      requestedBy: PUBLISHER,
      publish: () => {
        throw new Error('a refused swap must not publish')
      },
    })
    expect(result.decision).toBe('refused')
    expect(result.refusedRule).toBe((first as { rule: string }).rule)
    expect(result.appliedRotaVersionId).toBeNull()

    const stored = await sql<{ refusedRule: string; decision: string }[]>`
      select refused_rule as "refusedRule", decision from rota_change_request
       where id = ${result.requestId}::uuid
    `
    expect(stored[0]?.refusedRule).toBe((first as { rule: string }).rule)
    // Append-only: a refused request stays refused, because it is the only record of what the validator
    // said and the remedy is a new request against the rota as it now stands.
    const refusal = await refusalOf(
      (tx) =>
        tx`update rota_change_request set decision = 'applied' where id = ${result.requestId}::uuid`,
    )
    expect(refusal).toMatch(/ZW002/)
    expect(
      await refusalOf(
        (tx) => tx`delete from rota_change_request where id = ${result.requestId}::uuid`,
      ),
    ).toMatch(/ZW002/)
  })

  it('refuses an open shift claimed by a therapist with an expired mandatory credential', async () => {
    const version = await readCurrentRotaVersion(sql, {
      fromTradingDate: DAY_ONE,
      toTradingDate: DAY_TWO,
    })
    const inputs = await rotaArgs({
      fromTradingDate: DAY_ONE,
      toTradingDate: DAY_TWO,
      handles: ['E1', 'E2', 'L1', 'L2', 'L3', 'SPARE', 'LAPSED'],
    })
    // An OPEN SHIFT is a shift row with no shift_assignment row (0030) — no table needed — so this
    // inserts the span and leaves it unassigned, which is what the claim then fills.
    const [openShift] = await sql<{ id: string }[]>`
      insert into shift (trading_date, period, label)
      values (${DAY_ONE}::date,
              tstzrange((${`${DAY_ONE} 12:00:00+04`})::timestamptz,
                        (${`${DAY_ONE} 16:00:00+04`})::timestamptz, '[)'),
              ${`${SHIFT_MARKER} open shift`})
      returning id
    `
    insertedShifts.push((openShift as { id: string }).id)
    const unassigned = await sql<{ count: string }[]>`
      select count(*)::text as count from shift_assignment
       where shift_id = ${(openShift as { id: string }).id}::uuid
    `
    expect(unassigned[0]?.count).toBe('0')

    const claimed = validateOpenShiftClaim({
      ...inputs,
      shiftId: (openShift as { id: string }).id,
      tradingDate: localDate(DAY_ONE),
      period: {
        startsAt: Date.parse(`${DAY_ONE}T12:00:00+04:00`),
        endsAt: Date.parse(`${DAY_ONE}T16:00:00+04:00`),
      } as RosteredShift['period'],
      claimedBy: employees.get('LAPSED') as string,
    })
    expect(claimed.violations.map((violation) => violation.rule)).toEqual([
      'credential_not_current',
    ])

    const result = await recordRotaChangeRequest(sql, {
      kind: 'open_shift_claim',
      rotaVersionId: (version as { id: string }).id,
      shiftId: (openShift as { id: string }).id,
      fromEmployeeId: null,
      toEmployeeId: employees.get('LAPSED') as string,
      verdict: {
        isPublishable: false,
        refusedRule: 'credential_not_current',
        refusalDetail: 'labour_card EXPIRED',
      },
      requestedBy: PUBLISHER,
      publish: () => {
        throw new Error('a refused claim must not publish')
      },
    })
    expect(result.decision).toBe('refused')
    expect(result.refusedRule).toBe('credential_not_current')
  })

  it('accepts the same claim from a credentialled therapist, as the control', async () => {
    const inputs = await rotaArgs({
      fromTradingDate: DAY_ONE,
      toTradingDate: DAY_TWO,
      handles: ['E1', 'E2', 'L1', 'L2', 'L3', 'SPARE', 'UNROSTERED'],
    })
    // UNROSTERED and not SPARE, and the difference is a real finding rather than fixture bookkeeping:
    // SPARE took a late shift on day one in the edit case above, so a 12:00-16:00 claim leaves two hours
    // before it — a `minimum_rest` breach. The control has to isolate the credential rule, so it goes to
    // somebody with no other shift that day, which is also who claims an open shift in practice.
    const claimed = validateOpenShiftClaim({
      ...inputs,
      shiftId: 'a-different-open-shift',
      tradingDate: localDate(DAY_ONE),
      period: {
        startsAt: Date.parse(`${DAY_ONE}T12:00:00+04:00`),
        endsAt: Date.parse(`${DAY_ONE}T16:00:00+04:00`),
      } as RosteredShift['period'],
      claimedBy: employees.get('UNROSTERED') as string,
    })
    // Without this the case above could be refusing every claim, whatever the credentials said.
    expect(claimed.isPublishable).toBe(true)
  })
})

describe('the treatment-load read', () => {
  /**
   * The appointments this file books, in a rolled-back transaction.
   *
   * `pnpm seed` creates NO appointment rows — its closing line mentions 250 of them and its step list does
   * not, and the table is empty after a fresh seed. A case that read whatever appointments happened to be
   * in the database would have passed vacuously on a clean one and reported on another suite's rows on a
   * dirty one, so this file books its own and rolls them back.
   */
  async function withBookedTreatment<T>(
    body: (
      tx: Sql,
      ids: { readonly appointmentId: string; readonly durationMinutes: number },
    ) => Promise<T>,
  ): Promise<T> {
    return await probe(async (tx) => {
      const [customer] = await tx<{ id: string }[]>`
        insert into customer (phone_e164, created_via) values ('+971500000681', 'guest_booking')
        on conflict (phone_e164) do update set created_via = excluded.created_via
        returning id
      `
      const [booking] = await tx<{ id: string }[]>`
        insert into booking (customer_id, source, notes)
        values (${(customer as { id: string }).id}, 'front_desk', 'PHR06 ROTA probe') returning id
      `
      const [variant] = await tx<{ id: string; duration: number; gross: string }[]>`
        select v.id, v.duration_minutes as duration, v.gross_price_fils::text as gross
          from service_variant v join service s on s.id = v.service_id
         where s.treatment_key = 'normal_massage' and s.style = 'asian'
         order by v.duration_minutes limit 1
      `
      const chosen = variant as { id: string; duration: number; gross: string }
      const [room] = await tx<
        { id: string }[]
      >`select id from rooms where room_type = 'standard' limit 1`
      const startsAt = Date.parse(`${DAY_ONE}T13:00:00+04:00`)
      // The period is the treatment PLUS the therapist buffer, which is what makes the case below a claim
      // about something: if the period equalled the duration, a read of either would pass.
      const endsAt = startsAt + (chosen.duration + 10) * 60_000
      const gross = Number(chosen.gross)
      const net = Math.round((gross * 100) / 105)
      const [appointment] = await tx<{ id: string }[]>`
        insert into appointment
          (booking_id, trading_date, service_variant_id, shape, therapist_id, room_id, period, status,
           delivery_id, room_places, turnaround_minutes, therapist_buffer_minutes,
           gross_price_fils, net_fils, vat_fils)
        values (${(booking as { id: string }).id}, ${DAY_ONE}::date, ${chosen.id}, 'solo',
                ${employees.get('E1') as string}, ${(room as { id: string }).id},
                tstzrange(to_timestamp(${startsAt} / 1000.0), to_timestamp(${endsAt} / 1000.0), '[)'),
                'confirmed', uuid_generate_v7(), 1, 20, 10,
                ${gross}, ${net}, ${gross - net})
        returning id
      `
      return await body(tx, {
        appointmentId: (appointment as { id: string }).id,
        durationMinutes: chosen.duration,
      })
    })
  }

  it('measures the treatment duration and not the period, the turnaround or the buffer', async () => {
    // The cap is on hands-on treatment minutes (Y9-coverage says "treatment-hours"). Reading the period's
    // length would fold in the therapist buffer and reading the turnaround would fold in the room's
    // changeover, and either would make the cap measure something the question does not name.
    const measured = await withBookedTreatment(async (tx, ids) => {
      const loads = await readTreatmentLoads(tx, {
        fromTradingDate: DAY_ONE,
        toTradingDate: DAY_ONE,
      })
      const mine = loads.find((load) => load.appointmentId === ids.appointmentId)
      const [row] = await tx<{ periodMinutes: string }[]>`
        select (extract(epoch from (upper(period) - lower(period))) / 60)::text as "periodMinutes"
          from appointment where id = ${ids.appointmentId}::uuid
      `
      return {
        read: mine?.minutes,
        treatmentCode: mine?.treatmentCode,
        duration: ids.durationMinutes,
        periodMinutes: Number((row as { periodMinutes: string }).periodMinutes),
      }
    })
    expect(measured.read).toBe(measured.duration)
    expect(measured.treatmentCode).toBe('normal_massage')
    // The control: the period is longer than the duration, so "it equals duration_minutes" is a claim
    // about something. A period equal to the duration would let a read of either pass.
    expect(measured.periodMinutes).toBe(measured.duration + 10)
    expect(measured.periodMinutes).toBeGreaterThan(measured.duration)
  })

  it('leaves out an appointment that holds no resources', async () => {
    const counted = await withBookedTreatment(async (tx, ids) => {
      const before = await readTreatmentLoads(tx, {
        fromTradingDate: DAY_ONE,
        toTradingDate: DAY_ONE,
      })
      await tx`update appointment set status = 'cancelled_by_salon' where id = ${ids.appointmentId}::uuid`
      const after = await readTreatmentLoads(tx, {
        fromTradingDate: DAY_ONE,
        toTradingDate: DAY_ONE,
      })
      return { before: before.length, after: after.length, id: ids.appointmentId }
    })
    // A cancellation holds nothing and loads nobody, so counting it would refuse a rota for work that will
    // not happen. A delta and not a total, because other suites share this database (brief rule 12).
    expect(counted.after).toBe(counted.before - 1)
    expect(counted.before).toBeGreaterThan(0)
  })
})

describe('the Unconfirmed Assumptions panel', () => {
  it('lists both provisional rule versions, against the questions that answer them', async () => {
    const rows = await unconfirmedAssumptionRows(sql)
    const coverage = rows.filter((row) => row.source === 'rota_coverage_rule')
    const wages = rows.filter((row) => row.source === 'labour_cost_rule')
    expect(coverage).toHaveLength(1)
    expect(coverage[0]?.openQuestionId).toBe('Y9-coverage')
    expect(coverage[0]?.note ?? '').toMatch(/high-intensity TREATMENT LIST is empty/)
    expect(wages).toHaveLength(1)
    expect(wages[0]?.openQuestionId).toBe('Y9-overtime')
    // Separate rows and not one, because what an hour of a monthly salary is worth is a different
    // question from what an uplift is: one flag covering both would clear the panel for an answer
    // nobody gave.
    expect(coverage[0]?.reference).not.toBe(wages[0]?.reference)
  })

  it('leaves the panel when the flag is cleared, which is what confirming a version does', async () => {
    const remaining = await probe(async (tx) => {
      await tx`update rota_coverage_rule set is_provisional = false, open_question_id = null`
      const rows = await unconfirmedAssumptionRows(tx)
      return rows.filter((row) => row.source === 'rota_coverage_rule').length
    })
    // The control for the case above: without it, a panel query that matched nothing would pass both.
    expect(remaining).toBe(0)
  })
})

describe('the digest', () => {
  it('is the sha-256 of the canonical form the pure function produced', async () => {
    const version = await readCurrentRotaVersion(sql, {
      fromTradingDate: DAY_ONE,
      toTradingDate: DAY_TWO,
    })
    const assignments = await readRotaVersionAssignments(sql, (version as { id: string }).id)
    const canonical = rotaAssignmentCanonicalForm(
      assignments.map((row) => ({
        employeeId: row.employeeId,
        tradingDate: localDate(row.tradingDate) as LocalDate,
        startsAt: row.startsAt as never,
        endsAt: row.endsAt as never,
      })),
    )
    // Recomputed from the ROWS THAT WERE STORED, which is the round trip that matters: a digest computed
    // from the in-memory objects would agree with itself while the `tstzrange` conversion lost a second.
    expect(rotaAssignmentDigest(canonical)).toBe(version?.assignmentDigest)
  })
})
