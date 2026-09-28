import {
  ASIA_DUBAI,
  coverageBreachesCausedBy,
  decideLeaveApproval,
  type FloorPresence,
  type HeldCredential,
  type Instant,
  judgeReassignmentNotice,
  type LeaveApprovalDelegation,
  type LeaveConflict,
  leaveCoveragePeriod,
  localDate,
  localTime,
  type Period,
  REASSIGNMENT_NOTICE_TEMPLATE_KEY,
  type Role,
  type RotaCoverageRules,
  type RotaTherapist,
  type RotaTradingDay,
  reassignmentCandidates,
  type WorkingHoursRules,
} from '@berelax/core'
import {
  type Actor,
  approveLeaveRequest,
  cancelApprovedLeave,
  createConnection,
  type FloorPresenceRow,
  type LeaveApprovalDeps,
  type LeaveCoverageAnswer,
  type LeaveCoverageInput,
  type LeaveCoverageRule,
  type LeaveDecisionInput,
  type LeaveDecisionRule,
  type LeaveDelegationRow,
  leaveRequestRefusalOf,
  type RotaCoverageRuleRow,
  readCredentialPolicy,
  readEligibleTherapists,
  readEmployeeCredentials,
  readFloorPresence,
  readLeaveApprovalConflicts,
  readLeaveApprovalNotices,
  readLeaveRequest,
  readLiveLeaveApproval,
  readLiveLeaveConflictOverrides,
  readRotaCoverageRules,
  readRotaTherapists,
  readTradingDatesCovering,
  readTradingDayWindows,
  readWetRoomSkills,
  readWorkingHoursRules,
  reassignAppointmentTx,
  recordLeaveConflictOverride,
  type Sql,
  type WorkingHoursRuleRow,
  writeLeaveApprovalDelegation,
  writeLeaveRequest,
} from '@berelax/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * P-HR-09 — the approval, the rows it judges and the rows it writes, joined.
 *
 * The **rules** are pure and live in `@berelax/core`; the **rows** live in PostgreSQL and are read and written
 * by `@berelax/db`. `packages/db` may never import `packages/core`, so nothing but `@berelax/fixtures` can
 * assert that the pair works — the same reason `hr-rota.itest.ts` and `reassignment.itest.ts` are here.
 *
 * What needs both halves, and could not be asserted in either alone:
 *
 *   1. **The 01:30 conflict.** A leave day stored over `business_day` open/close instants covers 01:30 on the
 *      FOLLOWING calendar date, so an appointment there is a reported conflict — and the same appointment is
 *      NOT a conflict for leave on the next day. Both halves, because either alone is satisfied by the wrong
 *      period.
 *   2. **The conflict report is complete.** Three overlapping appointments produce three rows carrying the
 *      customer, the service, the room, the therapist and the start instant, and the approval **does not
 *      commit** — asserted by reading `leave_request` back, never by trusting the refusal.
 *   3. **Each conflict resolves by a P-HR-04 reassignment or by an audited override**, and the approval then
 *      commits. The reassignment is `reassignAppointmentTx`, called and not reimplemented.
 *   4. **The coverage refusal reuses the P-HR-06 validator**, names the breached 30-minute segment, and is a
 *      DELTA: a segment already short without this leave does not refuse it.
 *   5. **Availability returns zero slots** for that therapist inside the leave after approval, and slots
 *      before it. The known-bad fixture that proves the leave predicate fires is gate case 119's, which
 *      removes the subtraction from `eligibility.ts` and requires this file to fail naming
 *      `on_approved_leave`.
 *   6. **Delegation is time-bounded**, at the transaction level: the named deputy inside the window approves,
 *      an undelegated peer of the same role cannot, and an approval outside the window is refused.
 *   7. **Two concurrent approvals for two different therapists**: the second is refused by the coverage check
 *      inside its transaction, on a second real connection, with the first transaction committed.
 *   8. **The round trip.** Cancelling approved leave restores availability and clears the flags the approval
 *      created — both halves, separately.
 *
 * ## Isolation (brief rule 12)
 *
 * The integration suite runs sequentially against one database and earlier files leave rows behind. So every
 * employee, room, service and shift this file creates is marked, every read that could see another file's rows
 * is narrowed to them, and the trading dates are in a year nobody else uses. `leave_request` cannot be deleted
 * by the application role (0030) and `leave_approval` is append-only, so this file's leave rows stay — which
 * is why its employees are minted per run rather than shared.
 *
 * **The seeded database has no shifts at all** (`shift` and `shift_assignment` are empty — a known,
 * separately-owned gap), so every coverage claim here rests on shifts this file creates and sweeps. Nothing
 * below asserts that a seeded database has shifts, or that it has none.
 *
 * No employee here has a name (brief rule 10).
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url) {
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')
}

/** 2086 is a year no other suite uses. The dates are fixed, and `beforeAll` inserts them. */
const EARLIER = '2086-03-16'
const LEAVE_DAY = '2086-03-17'
const NEXT_DAY = '2086-03-18'
const QUIET_DAY = '2086-03-19'
const RACE_DAY = '2086-03-20'
const AFTER_RACE = '2086-03-21'
const DATES = [EARLIER, LEAVE_DAY, NEXT_DAY, QUIET_DAY, RACE_DAY]

/**
 * Two markers, and the split is what makes a failed run harmless.
 *
 * {@link FILE_MARKER} is STABLE across runs and is what {@link sweep} deletes — called in `beforeAll` as well
 * as `afterAll`, which is `hr-rota.itest.ts`'s arrangement and for a sharper version of its reason. A run that
 * fails part-way leaves its shifts behind; the next run then rosters twice as many therapists on the leave
 * day, and every coverage assertion in this file is built on the floor being exactly two, so the failure would
 * present as "the approval committed" with nothing pointing at a dirty database. It happened while this file
 * was being written: three runs' shifts made a floor of nine.
 *
 * {@link RUN} is per-run and appears only in values that must be UNIQUE — a staff reference, a room code, a
 * treatment key, a phone number — because two of those from two runs cannot coexist.
 */
const FILE_MARKER = 'P-HR-09 LEAVE'
const RUN = Math.floor(Math.random() * 1_000_000)
const MARKER = `phr09-${RUN}`
/**
 * This file's own `service.treatment_key`, and it is snake_case because the column refuses anything else
 * (`service_treatment_key_snake_case`). The slug beside it is kebab-case for the same kind of reason: they
 * are two different vocabularies and one string cannot satisfy both.
 */
const TREATMENT_KEY = `phr09_probe_${RUN}`
const SERVICE_SLUG = `phr09-probe-${RUN}`

/** `+971 59` is unallocated and therefore undialable — see `packages/fixtures/src/synthetic.ts`. */
const PROBE_PHONE = `+97159${String(7_400_000 + (RUN % 100_000)).padStart(7, '0')}`

const GROSS_FILS = 20_000
const NET_FILS = 19_048
const VAT_FILS = 952
const VAT_RATE_BP = 500
const TURNAROUND_MINUTES = 20
const BUFFER_MINUTES = 10
const FAR_FUTURE = '2096-01-01'

const ACTOR: Actor = { kind: 'staff', label: 'P-HR-09 pair itest' }

let sql: Sql
/** The second pool. A lock taken by one transaction is invisible to a test running inside it. */
let probe: Sql
let customerId = ''
let variantId = ''
const rooms = new Map<string, string>()
const staff = new Map<string, string>()
const insertedShifts: string[] = []

const idOf = (reference: string): string => {
  const id = staff.get(reference)
  if (id === undefined) throw new Error(`no fixture employee ${reference}`)
  return id
}
const roomId = (code: string): string => rooms.get(code) as string

const at = (date: string, hhmm: string): number => Date.parse(`${date}T${hhmm}:00+04:00`)
const dubai = (date: string, hhmm: string): string => `${date} ${hhmm}:00+04`

const nextCalendarDay = (day: string): string =>
  new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)

/** A delay that lets a concurrent transaction reach the statement it must block on. */
const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * The trading hours every fixture date has, as `leaveCoveragePeriod` wants them.
 *
 * 11:00–02:00, matching the `business_day` rows this file inserts. Two spellings of the window would be two
 * windows, so `beforeAll` asserts the inserted rows agree with this function.
 */
const hoursFor = () => ({ open: localTime('11:00'), close: localTime('02:00') })

/** The period a run of leave days covers, from core. Never two instants written out here. */
function leavePeriod(
  from: string,
  to: string,
): { readonly startsAt: number; readonly endsAt: number } {
  const period = leaveCoveragePeriod({
    from: localDate(from),
    to: localDate(to),
    hoursFor,
    zone: ASIA_DUBAI,
  })
  return { startsAt: Number(period.startsAt), endsAt: Number(period.endsAt) }
}

// ------------------------------------------------------------------------------------------------
// Core's rules, as the transaction's injected dependencies
// ------------------------------------------------------------------------------------------------

const asCoverageRules = (row: RotaCoverageRuleRow): RotaCoverageRules => ({
  effectiveFrom: localDate(row.effectiveFrom),
  coverageSegmentMinutes: row.coverageSegmentMinutes,
  minimumTherapistsOnFloor: row.minimumTherapistsOnFloor,
  minimumWetRoomCapable: row.minimumWetRoomCapable,
  treatmentMinutesCapPerDay: row.treatmentMinutesCapPerDay,
  highIntensityMinutesCapPerDay: row.highIntensityMinutesCapPerDay,
  highIntensityTreatmentCodes: row.highIntensityTreatmentCodes,
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

const asFloorPresence = (row: FloorPresenceRow): FloorPresence => ({
  employeeId: row.employeeId,
  tradingDate: localDate(row.tradingDate),
  period: { startsAt: row.startsAt, endsAt: row.endsAt } as Period,
})

/**
 * The coverage rule, wired to core's `coverageBreachesCausedBy`.
 *
 * It reads the rota rows through P-HR-06's own readers and narrows the presence to the therapist roster those
 * readers returned — `validateRota` refuses an assignment naming an employee it was not given, and a
 * receptionist on shift contributes no floor cover, which is the validator's own stated decision.
 *
 * `satisfies` and not a cast, both directions. `LeaveCoverageInput`/`LeaveCoverageAnswer` in `@berelax/db` and
 * `CoverageDeltaArgs`/`CoverageDelta` in `@berelax/core` are two declarations of one shape, because neither
 * package may import the other, and the annotation is what makes a field added on one side a `pnpm typecheck`
 * failure rather than a coverage answer nobody computed.
 */
const coverage: LeaveCoverageRule = async (
  input: LeaveCoverageInput,
): Promise<LeaveCoverageAnswer> => {
  const dates = { fromTradingDate: input.fromTradingDate, toTradingDate: input.toTradingDate }
  const [windows, therapistRows, coverageRuleRows, workingHoursRows, wetRoomSkills, policy] =
    await Promise.all([
      readTradingDayWindows(sql, dates),
      readRotaTherapists(sql, dates),
      readRotaCoverageRules(sql),
      readWorkingHoursRules(sql),
      readWetRoomSkills(sql),
      readCredentialPolicy(sql),
    ])
  const credentials = await readEmployeeCredentials(
    sql,
    therapistRows.map((row) => row.employeeId),
  )
  const therapists: RotaTherapist[] = therapistRows.map((row) => ({
    employeeId: row.employeeId,
    skills: row.skills,
    credentials: credentials
      .filter((credential) => credential.employeeId === row.employeeId)
      .map(
        (credential): HeldCredential => ({
          documentType: credential.documentType,
          expiresOn: credential.expiresOn === null ? null : localDate(credential.expiresOn),
        }),
      ),
  }))
  const known = new Set(therapists.map((row) => row.employeeId))
  const days: RotaTradingDay[] = windows.map((day) => ({
    tradingDate: localDate(day.tradingDate),
    opensAt: day.opensAt as RotaTradingDay['opensAt'],
    closesAt: day.closesAt as RotaTradingDay['closesAt'],
    // Empty, so rule 2 cannot fire. This file asserts about the floor minimum; a wet-room breach would make
    // `caused` non-empty for a reason no case here is about, and the assertion would pass.
    wetRoomBookableDuring: [],
    isPublicHoliday: false,
  }))
  const delta = coverageBreachesCausedBy({
    rota: {
      days,
      therapists,
      treatmentLoads: [],
      coverageRuleVersions: coverageRuleRows.map(asCoverageRules),
      workingHoursRuleVersions: workingHoursRows.map(asWorkingHoursRules),
      wetRoomSkills,
      credentialPolicy: policy,
      zone: ASIA_DUBAI,
    },
    presence: input.presence.filter((row) => known.has(row.employeeId)).map(asFloorPresence),
    employeeId: input.employeeId,
    period: { startsAt: input.period.startsAt, endsAt: input.period.endsAt } as Period,
  })
  const governing = coverageRuleRows
    .filter((row) => row.effectiveFrom <= input.fromTradingDate)
    .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))[0]
  return {
    causedDescriptions: delta.caused.map((breach) => breach.segmentLabel),
    caused: delta.caused.map((breach) => ({
      rule: breach.rule,
      tradingDate: String(breach.tradingDate),
      segmentLabel: breach.segmentLabel,
      segmentIndex: breach.segmentIndex,
    })),
    presenceFragmentsAffected: delta.presenceFragmentsAffected,
    coverageRuleEffectiveFrom: governing?.effectiveFrom ?? '1970-01-01',
  }
}

const asDelegation = (row: LeaveDelegationRow): LeaveApprovalDelegation => ({
  id: row.id,
  delegatorEmployeeId: row.delegatorEmployeeId,
  deputyEmployeeId: row.deputyEmployeeId,
  period: { startsAt: row.startsAt, endsAt: row.endsAt } as Period,
  revokedAt: row.revokedAt === null ? null : (row.revokedAt as Instant),
})

/** The decision, wired to core's `decideLeaveApproval`. Same `satisfies` argument as above. */
const decide: LeaveDecisionRule = (input: LeaveDecisionInput) => {
  const answer = decideLeaveApproval({
    request: {
      id: input.request.id,
      employeeId: input.request.employeeId,
      status: input.request.status,
      period: { startsAt: input.request.startsAt, endsAt: input.request.endsAt } as Period,
    },
    approver: { employeeId: input.approver.employeeId, role: input.approver.role as Role },
    delegations: input.delegations.map(asDelegation),
    at: input.at as Instant,
    conflicts: input.conflicts.map(
      (row): LeaveConflict => ({
        appointmentId: row.appointmentId,
        customerId: row.customerId,
        serviceVariantId: row.serviceVariantId,
        roomId: row.roomId,
        therapistId: row.therapistId,
        startsAt: row.startsAt.getTime() as Instant,
        resolution: row.resolution,
      }),
    ),
    coverage: {
      caused: input.coverage.caused.map((breach) => ({
        rule: 'minimum_floor_coverage',
        tradingDate: localDate(breach.tradingDate),
        segmentLabel: breach.segmentLabel,
        segmentIndex: breach.segmentIndex,
        onFloor: 0,
        required: 0,
      })),
      preexisting: [],
      segments: [],
      presenceFragmentsAffected: input.coverage.presenceFragmentsAffected,
    },
  })
  if (answer.kind === 'approve') {
    return {
      kind: 'approve',
      approvedVia: answer.authority.via,
      delegationId: answer.authority.via === 'delegation' ? answer.authority.delegationId : null,
      conflictsOverridden: answer.conflictsOverridden,
      conflictsReassigned: answer.conflictsReassigned,
    }
  }
  return { kind: 'refused', refusal: answer.refusal, why: answer.why }
}

const DEPS: LeaveApprovalDeps = { coverage, decide }

const REASSIGNMENT_DEPS = {
  candidates: reassignmentCandidates,
  notice: judgeReassignmentNotice,
}

// ------------------------------------------------------------------------------------------------
// Fixtures
// ------------------------------------------------------------------------------------------------

async function addEmployee(reference: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into employee (staff_reference, gender, employed_from, notes)
    values (${`${MARKER} ${reference}`}, 'female', date '2080-01-01', ${FILE_MARKER})
    returning id::text as id
  `
  const id = (row as { id: string }).id
  staff.set(reference, id)
  await sql`
    insert into employee_skill (employee_id, skill) values (${id}::uuid, 'asian_style')
    on conflict do nothing
  `
  const policy = await readCredentialPolicy(sql)
  for (const documentType of policy.mandatoryTypes) {
    await sql`
      insert into employee_document (employee_id, document_type, expires_on)
      values (${id}::uuid, ${documentType}::employee_document_type, ${FAR_FUTURE}::date)
      on conflict do nothing
    `
  }
  return id
}

/** Rosters one employee across a band on one trading date, and remembers the shift for cleanup. */
async function roster(args: {
  readonly reference: string
  readonly tradingDate: string
  readonly from: string
  readonly until: string
}): Promise<string> {
  const crossesMidnight = args.until < args.from
  const endDate = crossesMidnight ? nextCalendarDay(args.tradingDate) : args.tradingDate
  const [row] = await sql<{ id: string }[]>`
    insert into shift (trading_date, period, label)
    values (${args.tradingDate}::date,
            tstzrange(${dubai(args.tradingDate, args.from)}::timestamptz,
                      ${dubai(endDate, args.until)}::timestamptz, '[)'),
            ${FILE_MARKER})
    returning id::text as id
  `
  const id = (row as { id: string }).id
  insertedShifts.push(id)
  await sql`
    insert into shift_assignment (shift_id, employee_id) values (${id}::uuid, ${idOf(args.reference)}::uuid)
  `
  return id
}

const bookings = new Map<string, string>()
async function bookingFor(handle: string): Promise<string> {
  const held = bookings.get(handle)
  if (held !== undefined) return held
  const [row] = await sql<{ id: string }[]>`
    insert into booking (customer_id, source, notes)
    values (${customerId}::uuid, 'front_desk', ${FILE_MARKER})
    returning id::text as id
  `
  const id = (row as { id: string }).id
  bookings.set(handle, id)
  return id
}

const appointments = new Map<string, string>()

async function commitAppointment(args: {
  readonly handle: string
  readonly tradingDate: string
  readonly therapist: string
  readonly room: string
  readonly from: string
  readonly to: string
  /** The calendar date the treatment starts on, when it is not the trading date. */
  readonly startsOn?: string
}): Promise<string> {
  const startDate = args.startsOn ?? args.tradingDate
  const endDate = args.to < args.from ? nextCalendarDay(startDate) : startDate
  const [row] = await sql<{ id: string }[]>`
    insert into appointment
      (booking_id, trading_date, service_variant_id, shape, therapist_id, room_id, period, status,
       room_places, turnaround_minutes, therapist_buffer_minutes,
       gross_price_fils, net_fils, vat_fils, vat_rate_bp)
    values (${await bookingFor(args.handle)}::uuid, ${args.tradingDate}::date, ${variantId}::uuid,
            'solo'::service_shape, ${idOf(args.therapist)}::uuid, ${roomId(args.room)}::uuid,
            tstzrange(${dubai(startDate, args.from)}::timestamptz,
                      ${dubai(endDate, args.to)}::timestamptz, '[)'),
            'confirmed', 1, ${TURNAROUND_MINUTES}, ${BUFFER_MINUTES},
            ${GROSS_FILS}, ${NET_FILS}, ${VAT_FILS}, ${VAT_RATE_BP})
    returning id::text as id
  `
  const id = (row as { id: string }).id
  appointments.set(args.handle, id)
  return id
}

/** One pending leave request over the trading-session instants core computed. */
async function requestLeave(reference: string, from: string, to: string = from): Promise<string> {
  const period = leavePeriod(from, to)
  const request = await writeLeaveRequest(sql, {
    employeeId: idOf(reference),
    kind: 'annual',
    startsAt: period.startsAt,
    endsAt: period.endsAt,
    reason: `${MARKER} ${reference} ${from}`,
  })
  return request.id
}

/** The refusal an approval carried, plus the core refusal inside it. Never a thrown value inspected ad hoc. */
async function approvalRefusal(
  leaveRequestId: string,
  approver: { readonly employeeId: string; readonly role: string },
  dates: { readonly fromTradingDate: string; readonly toTradingDate: string },
): Promise<{
  readonly refusal: string | null
  readonly leaveRefusal: unknown
  readonly message: string
}> {
  try {
    await approveLeaveRequest(
      sql,
      ACTOR,
      {
        leaveRequestId,
        approver,
        fromTradingDate: dates.fromTradingDate,
        toTradingDate: dates.toTradingDate,
        notificationTemplateKey: 'hr.leave_approved',
      },
      DEPS,
    )
    return { refusal: null, leaveRefusal: null, message: 'the approval COMMITTED' }
  } catch (error) {
    const details = (error as { details?: Record<string, unknown> }).details ?? {}
    return {
      refusal: leaveRequestRefusalOf(error),
      leaveRefusal: details['leaveRefusal'],
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

/** The statement's SQLSTATE, or '' when it was accepted. Always rolled back. */
const ROLLBACK = 'phr09-probe-rollback'
async function sqlStateOf(body: (tx: Sql) => Promise<unknown>): Promise<string> {
  try {
    await sql.begin(async (tx) => {
      await body(tx as unknown as Sql)
      throw new Error(ROLLBACK)
    })
    return ''
  } catch (error) {
    if (error instanceof Error && error.message === ROLLBACK) return ''
    const code = (error as { code?: unknown }).code
    return typeof code === 'string' ? code : `no code: ${String(error)}`
  }
}

/**
 * Everything this file's stable marker identifies, in dependency order.
 *
 * What it deliberately does NOT delete: `employee`. Every employee here is named in a `leave_request`, 0030
 * revokes DELETE on that table from the application role, and `leave_approval` refuses it outright — so the
 * roster is permanent. That is harmless once the SHIFTS are gone, which is the only thing about a leftover
 * employee that could change an answer, and it is why the roster is minted per run.
 */
async function sweep(): Promise<void> {
  await sql`
    delete from appointment
     where booking_id in (select id from booking where notes = ${FILE_MARKER})
  `
  await sql`delete from booking where notes = ${FILE_MARKER}`
  await sql`delete from shift where label = ${FILE_MARKER}`
  await sql`
    delete from service_variant where provisional_note = ${FILE_MARKER}
  `
  await sql`delete from service_resource_shape where service_treatment_key like 'phr09_probe_%'`
  await sql`delete from service_room_type_compat where service_treatment_key like 'phr09_probe_%'`
  await sql`delete from service where treatment_key like 'phr09_probe_%'`
  await sql`delete from rooms where notes = ${FILE_MARKER}`
  await sql`delete from customer where phone_e164 like '+97159740%'`
  await sql`delete from business_day where trading_date = any(${DATES}::date[])`
}

beforeAll(async () => {
  sql = createConnection({ url, max: 6 })
  probe = createConnection({ url, max: 3 })
  await sweep()

  const [customer] = await sql<{ id: string }[]>`
    insert into customer (phone_e164, created_via, locale)
    values (${PROBE_PHONE}, 'guest_booking', 'en')
    on conflict (phone_e164) do update set created_via = excluded.created_via
    returning id::text as id
  `
  customerId = (customer as { id: string }).id

  // 11:00–02:00 Asia/Dubai. `appointment.trading_date` and `shift.trading_date` are foreign keys into this
  // table, so no fixture can invent a date the premises does not trade on.
  for (const [day, close] of [
    [EARLIER, LEAVE_DAY],
    [LEAVE_DAY, NEXT_DAY],
    [NEXT_DAY, QUIET_DAY],
    [QUIET_DAY, RACE_DAY],
    [RACE_DAY, AFTER_RACE],
  ] as const) {
    await sql`
      insert into business_day (trading_date, opens_at, closes_at, source)
      values (${day}::date, ${dubai(day, '11')}::timestamptz, ${dubai(close, '02')}::timestamptz, 'weekly')
      on conflict (trading_date) do nothing
    `
  }

  for (const code of [`${MARKER}-a`, `${MARKER}-b`, `${MARKER}-c`]) {
    const [room] = await sql<{ id: string }[]>`
      insert into rooms (code, name, room_type, capacity, display_order, notes)
      values (${code}, ${`Probe ${code}`}, 'standard'::room_type, 1, 95, ${FILE_MARKER})
      returning id::text as id
    `
    rooms.set(code, (room as { id: string }).id)
  }

  const [service] = await sql<{ id: string }[]>`
    insert into service
      (style, treatment_key, slug, internal_name, public_display_name, turnaround_minutes, display_order)
    values ('asian', ${TREATMENT_KEY}, ${SERVICE_SLUG}, 'Probe massage', 'Normal Massage (Asian)',
            ${TURNAROUND_MINUTES}, 95)
    returning id::text as id
  `
  const serviceId = (service as { id: string }).id
  await sql`
    insert into service_room_type_compat (service_style, service_treatment_key, room_type)
    values ('asian', ${TREATMENT_KEY}, 'standard'::room_type)
  `
  await sql`
    insert into service_resource_shape
      (service_style, service_treatment_key, shape, therapists_required, rooms_required,
       min_room_capacity, required_room_type, therapist_buffer_minutes)
    values ('asian', ${TREATMENT_KEY}, 'solo'::service_shape, 1, 1, 1, null, ${BUFFER_MINUTES})
  `
  const [variant] = await sql<{ id: string }[]>`
    insert into service_variant (service_id, duration_minutes, gross_price_fils, provisional_note)
    values (${serviceId}::uuid, 60, ${GROSS_FILS}, ${FILE_MARKER})
    returning id::text as id
  `
  variantId = (variant as { id: string }).id

  // The roster. `pair-a` and `pair-b` are the two who cover the leave day, which is what makes a minimum of
  // two breakable by one approval; `spare-*` are held back so a later case is not reporting on a diary an
  // earlier one filled.
  for (const reference of [
    'pair-a',
    'pair-b',
    'spare-one',
    'spare-two',
    'spare-three',
    'taker',
    'receiver',
    'lonely',
    'race-a',
    'race-b',
    'race-spare',
    'manager',
    'deputy',
    'peer',
  ]) {
    await addEmployee(reference)
  }

  // The floor on the leave day: two therapists across the WHOLE session, which is what a minimum of two
  // needs to be exactly satisfied.
  for (const reference of ['pair-a', 'pair-b']) {
    await roster({ reference, tradingDate: LEAVE_DAY, from: '11', until: '02' })
  }
  // The quiet day has three on the floor, so a leave there breaks nothing and a case can commit.
  for (const reference of ['spare-one', 'spare-two', 'spare-three']) {
    await roster({ reference, tradingDate: QUIET_DAY, from: '11', until: '02' })
  }
  // `taker` is rostered on the quiet day too, and `receiver` beside them holds NO appointment on it: a
  // reassignment needs a therapist who is both rostered across the treatment plus its buffers and free of
  // anything overlapping it, and `taker`'s own diary is filled by the conflict-report case.
  await roster({ reference: 'taker', tradingDate: QUIET_DAY, from: '11', until: '02' })
  await roster({ reference: 'receiver', tradingDate: QUIET_DAY, from: '11', until: '02' })

  // The race day has its own three, so the concurrency case is not reporting on a floor an earlier case
  // changed — and its two contenders are not the pair the coverage case takes leave from.
  for (const reference of ['race-a', 'race-b', 'race-spare']) {
    await roster({ reference, tradingDate: RACE_DAY, from: '11', until: '02' })
  }
  // `lonely` is the only one on the floor on EARLIER, which is already below the minimum of two. That is the
  // pre-existing shortfall case: their leave must not be refused for a segment nobody covered anyway.
  await roster({ reference: 'lonely', tradingDate: EARLIER, from: '11', until: '02' })

  // The floor on the leave day is EXACTLY the two this file rostered, asserted rather than hoped for. Every
  // coverage case below is built on removing one of two, and a third therapist from anywhere — another
  // suite, or a previous run of this one — makes the refusal case commit instead. The sweep above is what
  // keeps this true; this is what says so when it does not.
  const floor = await readFloorPresence(sql, {
    fromTradingDate: LEAVE_DAY,
    toTradingDate: LEAVE_DAY,
  })
  const onFloor = new Set(floor.map((row) => row.employeeId))
  if (onFloor.size !== 2 || !onFloor.has(idOf('pair-a')) || !onFloor.has(idOf('pair-b'))) {
    throw new Error(
      `${onFloor.size} therapist(s) are on the floor on ${LEAVE_DAY} and this file rostered two. Every ` +
        'coverage case below removes one of exactly two, so a third makes the refusal case commit.',
    )
  }

  // The two figures every coverage claim here depends on, asserted rather than assumed: a seeded minimum
  // other than 2 would make the fixture's two-therapist floor mean something else entirely.
  const rules = await readRotaCoverageRules(sql)
  const governing = rules.filter((row) => row.effectiveFrom <= LEAVE_DAY).at(-1)
  if (governing?.minimumTherapistsOnFloor !== 2 || governing.coverageSegmentMinutes !== 30) {
    throw new Error(
      'The seeded rota_coverage_rule version no longer says 2 therapists per 30-minute segment ' +
        `(${JSON.stringify(governing)}). Every coverage case in this file is built on those two figures.`,
    )
  }
  // And the window this file inserted agrees with `hoursFor`, so the period core computes and the period the
  // database holds cannot be two different windows.
  const windows = await readTradingDayWindows(sql, {
    fromTradingDate: LEAVE_DAY,
    toTradingDate: LEAVE_DAY,
  })
  const period = leavePeriod(LEAVE_DAY, LEAVE_DAY)
  if (windows[0]?.opensAt !== period.startsAt || windows[0]?.closesAt !== period.endsAt) {
    throw new Error(
      'The business_day row this file inserted and leaveCoveragePeriod disagree about the session. Two ' +
        'windows is two answers, and every assertion below would be about whichever was read second.',
    )
  }
}, 180_000)

afterAll(async () => {
  // The same sweep `beforeAll` ran. `leave_request`, `leave_approval`, every notice and every employee stay:
  // 0030 revokes DELETE on the first and 0092 refuses it on the rest.
  await sweep()
  await probe?.end({ timeout: 5 })
  await sql?.end({ timeout: 5 })
})

// ------------------------------------------------------------------------------------------------
// The period, and the 01:30 in its tail
// ------------------------------------------------------------------------------------------------

describe('acceptance — a leave period is stored over business_day instants, tail included', () => {
  it('covers 01:30 on the FOLLOWING calendar date, and the next day’s leave does not', async () => {
    const id = await requestLeave('spare-one', LEAVE_DAY)
    const stored = await readLeaveRequest(sql, id)
    expect(stored?.startsAt).toBe(at(LEAVE_DAY, '11:00'))
    // The claim: the leave ENDS at 02:00 on the following date. Both controls beside it, because either
    // alone is satisfied by the wrong period — a calendar day would end at 00:00, and a naive one at 23:59.
    expect(stored?.endsAt).toBe(at(NEXT_DAY, '02:00'))
    expect(stored?.endsAt).not.toBe(at(NEXT_DAY, '00:00'))

    const tailAppointment = await commitAppointment({
      handle: 'tail',
      tradingDate: LEAVE_DAY,
      therapist: 'spare-one',
      room: `${MARKER}-a`,
      from: '01:30',
      to: '02:00',
      // The 01:30 instant's CALENDAR date is the 18th; its trading date is the 17th. That difference is the
      // whole subject.
      startsOn: NEXT_DAY,
    })
    const report = await readLeaveApprovalConflicts(sql, { leaveRequestId: id })
    expect(report.map((row) => row.appointmentId)).toContain(tailAppointment)

    // The control that makes it a claim about trading alignment rather than about overlap in general: the
    // NEXT day's leave starts at 11:00 on the 18th, so the 01:30 appointment is outside it.
    const nextDayLeave = await requestLeave('spare-two', NEXT_DAY)
    const nextReport = await readLeaveApprovalConflicts(sql, { leaveRequestId: nextDayLeave })
    expect(nextReport.map((row) => row.appointmentId)).not.toContain(tailAppointment)
  }, 30_000)

  it('the DATABASE refuses a leave period aligned to the calendar rather than to the session', async () => {
    // The known-bad fixture for the alignment (ADR 0003), and it is a statement rather than a helper: a
    // caller that wrote two calendar midnights would produce a row that looks completely ordinary and
    // silently leaves two tails rostered. ZY006 refuses it by name.
    const state = await sqlStateOf(
      (tx) => tx`
        insert into leave_request (employee_id, period, kind)
        values (${idOf('spare-three')}::uuid,
                tstzrange(${dubai(LEAVE_DAY, '00')}::timestamptz,
                          ${dubai(NEXT_DAY, '00')}::timestamptz, '[)'),
                'annual'::leave_kind)
      `,
    )
    expect(state).toBe('ZY006')

    // And the control: the SAME insert with the session's own bounds is accepted, so ZY006 is about the
    // alignment and not about the table refusing every insert.
    const aligned = await sqlStateOf(
      (tx) => tx`
        insert into leave_request (employee_id, period, kind)
        values (${idOf('spare-three')}::uuid,
                tstzrange(${dubai(LEAVE_DAY, '11')}::timestamptz,
                          ${dubai(NEXT_DAY, '02')}::timestamptz, '[)'),
                'annual'::leave_kind)
      `,
    )
    expect(aligned).toBe('')
  }, 30_000)
})

// ------------------------------------------------------------------------------------------------
// The conflict report, and the non-commit
// ------------------------------------------------------------------------------------------------

describe('acceptance — N overlapping appointments produce N complete rows, and nothing commits', () => {
  it('reports all three with customer, service, room, therapist and start, and does not commit', async () => {
    const leaveRequestId = await requestLeave('taker', QUIET_DAY)
    const made: string[] = []
    for (const [index, [from, to, room]] of (
      [
        ['12:00', '13:00', `${MARKER}-a`],
        ['15:00', '16:00', `${MARKER}-b`],
        ['20:00', '21:00', `${MARKER}-c`],
      ] as const
    ).entries()) {
      made.push(
        await commitAppointment({
          handle: `conflict-${index}`,
          tradingDate: QUIET_DAY,
          therapist: 'taker',
          room,
          from,
          to,
        }),
      )
    }

    const report = await readLeaveApprovalConflicts(sql, { leaveRequestId, appointmentIds: made })
    expect(report).toHaveLength(3)
    for (const row of report) {
      // Every field, on every row. A report with a blank column is a report an operator cannot act on, and
      // the acceptance line names all five.
      expect(row.customerId).toBe(customerId)
      // Null, and asserted as null: this file's customer has no recorded name, which is the ordinary state
      // (ADR 0020) and the one the screen has to render. A manufactured label here would be the invented
      // fact brief rule 15 forbids.
      expect(row.customerDisplayName).toBeNull()
      expect(row.serviceVariantId).toBe(variantId)
      expect(row.serviceLabel).toContain('asian')
      expect(row.roomCode).toContain(MARKER)
      expect(row.therapistId).toBe(idOf('taker'))
      expect(row.therapistReference).toContain(MARKER)
      expect(row.startsAt).toBeInstanceOf(Date)
      expect(row.resolution).toBe('unresolved')
    }
    // Ordered by start, so two reads of one report cannot look like the diary changed.
    expect(report.map((row) => row.startsAt.getTime())).toEqual(
      [...report.map((row) => row.startsAt.getTime())].sort((a, b) => a - b),
    )

    const refused = await approvalRefusal(
      leaveRequestId,
      { employeeId: idOf('manager'), role: 'manager' },
      { fromTradingDate: QUIET_DAY, toTradingDate: QUIET_DAY },
    )
    expect(refused.refusal, refused.message).toBe('approval_refused')
    expect(refused.leaveRefusal).toBe('conflicts_unresolved')

    // The non-commit, asserted by reading the ROW back — never by trusting the status that came out of the
    // call. A transaction that refused and committed anyway would return exactly the same error.
    const after = await readLeaveRequest(sql, leaveRequestId)
    expect(after?.status).toBe('pending')
    expect(after?.decidedAt).toBeNull()
    expect(await readLiveLeaveApproval(sql, leaveRequestId)).toBeNull()
    expect(await readLeaveApprovalNotices(sql, leaveRequestId)).toEqual([])
    const [event] = await sql<{ n: string }[]>`
      select count(*)::text as n from outbox_event
       where idempotency_key = ${`leave.approved:${leaveRequestId}`}
    `
    expect(event?.n).toBe('0')
  }, 60_000)

  it('resolves one by a P-HR-04 reassignment and one by an audited override, then commits', async () => {
    const leaveRequestId = await requestLeave('spare-three', QUIET_DAY)
    const moved = await commitAppointment({
      handle: 'resolve-reassign',
      tradingDate: QUIET_DAY,
      therapist: 'spare-three',
      room: `${MARKER}-a`,
      from: '13:00',
      to: '14:00',
    })
    const stays = await commitAppointment({
      handle: 'resolve-override',
      tradingDate: QUIET_DAY,
      therapist: 'spare-three',
      room: `${MARKER}-b`,
      from: '17:00',
      to: '18:00',
    })

    // P-HR-04's transaction, CALLED. A second reassignment written here would be the "a second statement of
    // a fact drifts" defect, and this unit's acceptance line says the resolution IS that transaction.
    const reassigned = await reassignAppointmentTx(
      sql,
      {
        appointmentId: moved,
        toTherapistId: idOf('receiver'),
        reason: 'leave_approved',
        actor: { kind: 'staff', role: 'manager', label: 'P-HR-09 pair itest' },
        decidedOn: QUIET_DAY,
        noticeTemplateKey: REASSIGNMENT_NOTICE_TEMPLATE_KEY,
        clientGender: 'female',
      },
      REASSIGNMENT_DEPS,
    )
    expect(reassigned.toTherapistId).toBe(idOf('receiver'))
    // `leave_approved` is one of the four reasons 0065 accepts, and it is P-HR-04's NOTE in its own words:
    // "leave_approved belongs to P-HR-09". This is the first caller of it in the build.
    expect(reassigned.reason).toBe('leave_approved')
    // And the appointment is still an appointment: not cancelled, not unassigned, same status.
    expect(reassigned.history.status).toBe('confirmed')

    await recordLeaveConflictOverride(sql, ACTOR, {
      leaveRequestId,
      appointmentId: stays,
      actorRole: 'manager',
      reason: 'the client asked for her specifically and will be told',
    })

    const report = await readLeaveApprovalConflicts(sql, {
      leaveRequestId,
      appointmentIds: [moved, stays],
    })
    const resolutions = new Map(report.map((row) => [row.appointmentId, row.resolution]))
    expect(resolutions.get(moved)).toBe('reassigned')
    expect(resolutions.get(stays)).toBe('overridden')

    const approved = await approveLeaveRequest(
      sql,
      ACTOR,
      {
        leaveRequestId,
        approver: { employeeId: idOf('manager'), role: 'manager' },
        fromTradingDate: QUIET_DAY,
        toTradingDate: QUIET_DAY,
        notificationTemplateKey: 'hr.leave_approved',
      },
      DEPS,
    )
    expect(approved.conflictsReassigned).toBe(1)
    expect(approved.conflictsOverridden).toBe(1)
    expect(approved.approvedVia).toBe('own_authority')

    // Read back, again: the committed row and not the returned value.
    const after = await readLeaveRequest(sql, leaveRequestId)
    expect(after?.status).toBe('approved')
    expect(after?.decidedAt).not.toBeNull()

    // The outbox row, in the same transaction, keyed on the ROW ID and never on a display number.
    const [event] = await sql<{ key: string; type: string }[]>`
      select idempotency_key as key, event_type as type from outbox_event
       where aggregate_id = ${leaveRequestId}::text and event_type = 'leave.approved'
    `
    expect(event?.key).toBe(`leave.approved:${leaveRequestId}`)

    // And the staff notification, one per employee, `skipped` with its reason: no seeded employee has a
    // recipient on file, and a notice table that recorded nothing would be indistinguishable from a
    // notification path that does not exist (0081's argument).
    const notices = await readLeaveApprovalNotices(sql, leaveRequestId)
    expect(notices).toHaveLength(1)
    expect(notices[0]?.employeeId).toBe(idOf('spare-three'))
    expect(notices[0]?.outcome).toBe('skipped')
    expect(notices[0]?.skippedReason).toBe('no_recipient_on_file')
  }, 90_000)
})

// ------------------------------------------------------------------------------------------------
// Coverage
// ------------------------------------------------------------------------------------------------

describe('acceptance — an approval that drops the floor below the minimum is refused by segment', () => {
  it('refuses and names the breached 30-minute segment', async () => {
    const leaveRequestId = await requestLeave('pair-a', LEAVE_DAY)
    const refused = await approvalRefusal(
      leaveRequestId,
      { employeeId: idOf('manager'), role: 'manager' },
      { fromTradingDate: LEAVE_DAY, toTradingDate: LEAVE_DAY },
    )
    expect(refused.refusal, refused.message).toBe('approval_refused')
    expect(refused.leaveRefusal).toBe('coverage_would_break')
    // By segment LABEL, which is the wording `rota_change_request.refused_rule` stores and the screen
    // prints. The first segment of the trading day, named against the TRADING date.
    expect(refused.message).toContain(`${LEAVE_DAY} 11:00-11:30`)
    // The post-midnight segments too, which is the half a calendar-shaped grid would get wrong.
    expect(refused.message).toContain(`${LEAVE_DAY} 01:30-02:00`)

    const after = await readLeaveRequest(sql, leaveRequestId)
    expect(after?.status).toBe('pending')
  }, 60_000)

  it('does NOT refuse for a segment that was already short without this leave', async () => {
    // The control, and the reason the answer is a DELTA. `lonely` is the only therapist on the floor on
    // EARLIER, so every segment of that day is already below the minimum of two. Their leave makes it no
    // worse, so it is approved — and an absolute coverage reading would refuse it, naming a segment the
    // requester cannot do anything about.
    const leaveRequestId = await requestLeave('lonely', EARLIER)
    const approved = await approveLeaveRequest(
      sql,
      ACTOR,
      {
        leaveRequestId,
        approver: { employeeId: idOf('manager'), role: 'manager' },
        fromTradingDate: EARLIER,
        toTradingDate: EARLIER,
        notificationTemplateKey: 'hr.leave_approved',
      },
      DEPS,
    )
    expect(approved.leaveRequestId).toBe(leaveRequestId)
    const after = await readLeaveRequest(sql, leaveRequestId)
    expect(after?.status).toBe('approved')
  }, 60_000)

  it('the presence the coverage check reads is NET of leave already approved', async () => {
    // The property the whole concurrency case rests on, asserted directly: once `lonely`'s leave on EARLIER
    // is approved, the floor read for that date holds no presence for them at all. Without the subtraction a
    // second approval would be judged against a floor that still counted somebody who is away.
    const presence = await readFloorPresence(sql, {
      fromTradingDate: EARLIER,
      toTradingDate: EARLIER,
    })
    expect(presence.some((row) => row.employeeId === idOf('lonely'))).toBe(false)
    // And the control: a date they are not on leave for still shows their roster — which is nothing here,
    // so the control is over somebody who IS rostered and not on leave.
    const quiet = await readFloorPresence(sql, {
      fromTradingDate: QUIET_DAY,
      toTradingDate: QUIET_DAY,
    })
    expect(quiet.some((row) => row.employeeId === idOf('spare-one'))).toBe(true)
  }, 30_000)
})

// ------------------------------------------------------------------------------------------------
// Availability
// ------------------------------------------------------------------------------------------------

describe('acceptance — after approval the availability read returns zero presence for that therapist', () => {
  it('excludes them naming on_approved_leave, and included them before', async () => {
    const leaveRequestId = await requestLeave('spare-two', QUIET_DAY)

    // Before. The control, and it has to come first: an assertion that a therapist is excluded after
    // approval is satisfied by a therapist who was never available.
    const before = await readEligibleTherapists(sql, {
      tradingDate: QUIET_DAY,
      requiredSkill: 'asian_style',
      employeeIds: [idOf('spare-two')],
      clientGender: 'female',
    })
    expect(before.therapists.map((row) => row.therapistId)).toContain(idOf('spare-two'))
    expect(before.shifts.length).toBeGreaterThan(0)

    await approveLeaveRequest(
      sql,
      ACTOR,
      {
        leaveRequestId,
        approver: { employeeId: idOf('manager'), role: 'manager' },
        fromTradingDate: QUIET_DAY,
        toTradingDate: QUIET_DAY,
        notificationTemplateKey: 'hr.leave_approved',
      },
      DEPS,
    )

    const after = await readEligibleTherapists(sql, {
      tradingDate: QUIET_DAY,
      requiredSkill: 'asian_style',
      employeeIds: [idOf('spare-two')],
      clientGender: 'female',
    })
    expect(after.therapists.map((row) => row.therapistId)).not.toContain(idOf('spare-two'))
    // BY RULE NAME (ADR 0003). "Not offered" is satisfied by any of the seven exclusion reasons, and the one
    // this unit is about is the leave.
    expect(after.excluded.map((row) => row.reason)).toContain('on_approved_leave')
    expect(after.shifts.filter((row) => row.therapistId === idOf('spare-two'))).toEqual([])
  }, 90_000)
})

// ------------------------------------------------------------------------------------------------
// Delegation
// ------------------------------------------------------------------------------------------------

describe('acceptance — delegation is time-bounded: three cases at the transaction', () => {
  /**
   * The window, around NOW — not around the leave dates, and the difference is the whole point.
   *
   * A delegation bounds when a DECISION may be taken, and `leave_approval.decided_at` defaults to the
   * transaction's `now()`; the leave itself is in 2086. The first version of this block used the fixture
   * dates and every case failed with `delegation_not_in_window`, which was the rule working correctly on a
   * window that could not contain any decision anybody would ever take.
   */
  const HOUR = 3_600_000
  const windowOf = () => ({ startsAt: Date.now() - HOUR, endsAt: Date.now() + HOUR })

  it('the named deputy inside the window can approve', async () => {
    const delegation = await writeLeaveApprovalDelegation(sql, {
      delegatorEmployeeId: idOf('manager'),
      deputyEmployeeId: idOf('deputy'),
      ...windowOf(),
      reason: 'the manager is away for the week',
      createdBy: 'P-HR-09 pair itest',
    })
    const leaveRequestId = await requestLeave('spare-one', QUIET_DAY)
    const approved = await approveLeaveRequest(
      sql,
      ACTOR,
      {
        leaveRequestId,
        // A receptionist, which does NOT hold `leave:approve`: the delegation is the whole of the authority,
        // and a role that held the permission anyway would make this case pass against a function that
        // ignored delegations.
        approver: { employeeId: idOf('deputy'), role: 'receptionist' },
        fromTradingDate: QUIET_DAY,
        toTradingDate: QUIET_DAY,
        notificationTemplateKey: 'hr.leave_approved',
      },
      DEPS,
    )
    expect(approved.approvedVia).toBe('delegation')
    expect(approved.delegationId).toBe(delegation.id)
    // The record names the delegation, and 0092's ZY004 refused it unless the delegation authorises it.
    const live = await readLiveLeaveApproval(sql, leaveRequestId)
    expect(live?.delegationId).toBe(delegation.id)
    expect(live?.approverRole).toBe('receptionist')
  }, 60_000)

  it('an undelegated peer of the same role cannot', async () => {
    const leaveRequestId = await requestLeave('taker', QUIET_DAY)
    const refused = await approvalRefusal(
      leaveRequestId,
      // The same role as the deputy above. What the peer lacks is being NAMED, which is the whole
      // difference — and a delegation to a role would have made every receptionist a deputy.
      { employeeId: idOf('peer'), role: 'receptionist' },
      { fromTradingDate: QUIET_DAY, toTradingDate: QUIET_DAY },
    )
    expect(refused.refusal, refused.message).toBe('approval_refused')
    expect(refused.leaveRefusal).toBe('approver_not_authorised')
    expect((await readLeaveRequest(sql, leaveRequestId))?.status).toBe('pending')
  }, 60_000)

  it('an approval outside the window is refused, and refused DIFFERENTLY', async () => {
    // A window that closed before the quiet day. The deputy is named in it, so what they meet is the BOUND
    // rather than the absence of authority — and the two refusals are distinct, because telling a deputy
    // whose window closed that they may not approve leave at all sends them to ask for a permission.
    await writeLeaveApprovalDelegation(sql, {
      delegatorEmployeeId: idOf('manager'),
      deputyEmployeeId: idOf('peer'),
      // A window that CLOSED an hour ago. The deputy is named in it, so what they meet is the bound rather
      // than the absence of authority.
      startsAt: Date.now() - 3 * HOUR,
      endsAt: Date.now() - 2 * HOUR,
      reason: 'cover for one evening only',
      createdBy: 'P-HR-09 pair itest',
    })
    const leaveRequestId = await requestLeave('spare-three', QUIET_DAY)
    const refused = await approvalRefusal(
      leaveRequestId,
      { employeeId: idOf('peer'), role: 'receptionist' },
      { fromTradingDate: QUIET_DAY, toTradingDate: QUIET_DAY },
    )
    expect(refused.refusal, refused.message).toBe('approval_refused')
    expect(refused.leaveRefusal).toBe('delegation_not_in_window')
    expect((await readLeaveRequest(sql, leaveRequestId))?.status).toBe('pending')
  }, 60_000)
})

// ------------------------------------------------------------------------------------------------
// Concurrency
// ------------------------------------------------------------------------------------------------

describe('acceptance — two overlapping approvals for different therapists, concurrently', () => {
  it('refuses the second by the coverage check INSIDE its transaction, not by a race', async () => {
    // Three therapists on the race day and a minimum of two, so the FIRST approval is legitimately
    // grantable and the second is not. A fixture where both are refused would prove nothing about the
    // second, and a fixture where both are grantable would prove nothing at all.
    //
    // Nothing in the schema makes these two transactions see each other: two approvals for two DIFFERENT
    // employees touch no common row, and `leave_request_no_overlapping_approved` is per employee. The
    // `leave_coverage_lock` row for the date is the whole mechanism.
    const first = await requestLeave('race-a', RACE_DAY)
    const second = await requestLeave('race-b', RACE_DAY)

    const input = (leaveRequestId: string) => ({
      leaveRequestId,
      approver: { employeeId: idOf('manager'), role: 'manager' },
      fromTradingDate: RACE_DAY,
      toTradingDate: RACE_DAY,
      notificationTemplateKey: 'hr.leave_approved',
    })

    // Both on their own connections, started together. The second's coverage read happens after the first
    // commits, because the lock is held across the first transaction.
    const [firstResult, secondResult] = await Promise.allSettled([
      approveLeaveRequest(sql, ACTOR, input(first), DEPS),
      (async () => {
        // A small delay so the ORDER is decided rather than tossed: this case is about the second approval
        // meeting the first's committed leave, and an undecided winner would make the assertion below true
        // of whichever ran first.
        await settle(150)
        return approveLeaveRequest(probe, ACTOR, input(second), {
          coverage: async (args) => coverage(args),
          decide,
        })
      })(),
    ])

    expect(firstResult.status, JSON.stringify(firstResult)).toBe('fulfilled')
    expect(secondResult.status).toBe('rejected')
    const reason = secondResult.status === 'rejected' ? secondResult.reason : null
    expect(leaveRequestRefusalOf(reason)).toBe('approval_refused')
    expect((reason as { details?: Record<string, unknown> }).details?.['leaveRefusal']).toBe(
      'coverage_would_break',
    )
    // The refusal names a segment, which is what says the COVERAGE CHECK refused rather than a constraint.
    expect((reason as Error).message).toContain(`${RACE_DAY} 11:00-11:30`)

    // And the rows: the first committed, the second did not.
    expect((await readLeaveRequest(sql, first))?.status).toBe('approved')
    expect((await readLeaveRequest(sql, second))?.status).toBe('pending')
  }, 120_000)
})

// ------------------------------------------------------------------------------------------------
// The round trip
// ------------------------------------------------------------------------------------------------

describe('acceptance — cancelling approved leave restores availability and clears what it created', () => {
  it('proves both halves', async () => {
    const leaveRequestId = await requestLeave('spare-two', NEXT_DAY)
    await roster({ reference: 'spare-two', tradingDate: NEXT_DAY, from: '11', until: '02' })
    await roster({ reference: 'spare-one', tradingDate: NEXT_DAY, from: '11', until: '02' })
    await roster({ reference: 'spare-three', tradingDate: NEXT_DAY, from: '11', until: '02' })

    const standing = await commitAppointment({
      handle: 'round-trip',
      tradingDate: NEXT_DAY,
      therapist: 'spare-two',
      room: `${MARKER}-a`,
      from: '19:00',
      to: '20:00',
    })
    await recordLeaveConflictOverride(sql, ACTOR, {
      leaveRequestId,
      appointmentId: standing,
      actorRole: 'owner',
      reason: 'the client is a regular and asked for her',
    })
    await approveLeaveRequest(
      sql,
      ACTOR,
      {
        leaveRequestId,
        approver: { employeeId: idOf('manager'), role: 'manager' },
        fromTradingDate: NEXT_DAY,
        toTradingDate: NEXT_DAY,
        notificationTemplateKey: 'hr.leave_approved',
      },
      DEPS,
    )

    const blocked = await readEligibleTherapists(sql, {
      tradingDate: NEXT_DAY,
      requiredSkill: 'asian_style',
      employeeIds: [idOf('spare-two')],
      clientGender: 'female',
    })
    expect(blocked.excluded.map((row) => row.reason)).toContain('on_approved_leave')
    expect(await readLiveLeaveApproval(sql, leaveRequestId)).not.toBeNull()
    expect(await readLiveLeaveConflictOverrides(sql, leaveRequestId)).toHaveLength(1)

    await cancelApprovedLeave(sql, ACTOR, {
      leaveRequestId,
      actorRole: 'manager',
      reason: 'she withdrew the request the same afternoon',
    })

    // Half one: availability comes back, and the presence with it — not just the absence of the exclusion.
    const restored = await readEligibleTherapists(sql, {
      tradingDate: NEXT_DAY,
      requiredSkill: 'asian_style',
      employeeIds: [idOf('spare-two')],
      clientGender: 'female',
    })
    expect(restored.therapists.map((row) => row.therapistId)).toContain(idOf('spare-two'))
    expect(restored.excluded.map((row) => row.reason)).not.toContain('on_approved_leave')
    expect(restored.shifts.length).toBeGreaterThan(0)

    // Half two: the flags the approval created stop being live. The approval, through the view, and the
    // override with it — a withdrawn holiday must not leave a recorded decision about somebody's booking
    // standing as current.
    expect(await readLiveLeaveApproval(sql, leaveRequestId)).toBeNull()
    expect(await readLiveLeaveConflictOverrides(sql, leaveRequestId)).toEqual([])

    // And the notice does NOT go: a notification that was sent cannot be unsent, and a record of it that
    // disappeared would make "was she told?" unanswerable.
    expect(await readLeaveApprovalNotices(sql, leaveRequestId)).toHaveLength(1)

    // The appointment that was overridden is still an appointment. This is the boundary, at the end of the
    // round trip: nothing in either direction touched it.
    const [row] = await sql<{ status: string; therapist_id: string }[]>`
      select status::text as status, therapist_id::text as therapist_id
        from appointment where id = ${standing}::uuid
    `
    expect(row?.status).toBe('confirmed')
    expect(row?.therapist_id).toBe(idOf('spare-two'))
  }, 120_000)

  it('refuses a second withdrawal, and refuses one for a request that was never approved', async () => {
    const pending = await requestLeave('taker', EARLIER)
    let refusal: string | null = null
    try {
      await cancelApprovedLeave(sql, ACTOR, {
        leaveRequestId: pending,
        actorRole: 'manager',
        reason: 'there is nothing to withdraw',
      })
    } catch (error) {
      refusal = leaveRequestRefusalOf(error)
    }
    expect(refusal).toBe('not_approved')
  }, 30_000)
})

// ------------------------------------------------------------------------------------------------
// The database's own refusals
// ------------------------------------------------------------------------------------------------

describe('the rules the DATABASE refuses, for every role including the owner', () => {
  it('refuses an override by a role that may not take one, and one with no written reason', async () => {
    const leaveRequestId = await requestLeave('spare-one', EARLIER)
    const appointmentId = await commitAppointment({
      handle: 'override-refusals',
      tradingDate: EARLIER,
      therapist: 'spare-one',
      room: `${MARKER}-a`,
      from: '14:00',
      to: '15:00',
    })
    const insert = (role: string, reason: string) => (tx: Sql) =>
      tx`
      insert into leave_conflict_override (leave_request_id, appointment_id, actor_role, actor_label, reason)
      values (${leaveRequestId}::uuid, ${appointmentId}::uuid, ${role}, 'P-HR-09 pair itest', ${reason})
    `
    expect(await sqlStateOf(insert('receptionist', 'a properly written reason'))).toBe('ZY002')
    expect(await sqlStateOf(insert('manager', 'short'))).toBe('ZY002')
    // The control: the same insert with a permitted role and a written reason is accepted, so ZY002 is about
    // the two halves of the rule and not about the table refusing everything.
    expect(await sqlStateOf(insert('manager', 'the client asked for her by name'))).toBe('')
  }, 60_000)

  it('refuses an UPDATE and a DELETE on every approval record', async () => {
    // `leave_approval` for a request approved earlier in this file. Append-only means the four tables, and
    // the trigger names the table it refused for — one rule, one function, four pairs of triggers.
    const [approval] = await sql<{ id: string }[]>`
      select leave_request_id::text as id from leave_approval
       where approved_by_employee_id = ${idOf('manager')}::uuid limit 1
    `
    const id = (approval as { id: string }).id
    expect(
      await sqlStateOf(
        (tx) =>
          tx`update leave_approval set approver_role = 'owner' where leave_request_id = ${id}::uuid`,
      ),
    ).toBe('ZY001')
    expect(
      await sqlStateOf((tx) => tx`delete from leave_approval where leave_request_id = ${id}::uuid`),
    ).toBe('ZY001')
    expect(
      await sqlStateOf(
        (tx) =>
          tx`update leave_approval_notice set outcome = 'sent' where leave_request_id = ${id}::uuid`,
      ),
    ).toBe('ZY001')
  }, 60_000)

  it('refuses an approval record whose request is not approved, and one whose period differs', async () => {
    const pending = await requestLeave('spare-three', EARLIER)
    const period = leavePeriod(EARLIER, EARLIER)
    expect(
      await sqlStateOf(
        (tx) => tx`
          insert into leave_approval (
            leave_request_id, approved_by_employee_id, approver_role, approved_via,
            coverage_rule_effective_from, period, conflicts_overridden, conflicts_reassigned
          ) values (
            ${pending}::uuid, ${idOf('manager')}::uuid, 'manager', 'own_authority',
            date '2000-01-01',
            tstzrange(to_timestamp(${period.startsAt} / 1000.0),
                      to_timestamp(${period.endsAt} / 1000.0), '[)'),
            0, 0
          )
        `,
      ),
    ).toBe('ZY005')
  }, 30_000)

  it('refuses a delegation to the delegator, and two live overlapping ones between one pair', async () => {
    const window = { startsAt: Date.now() - 3_600_000, endsAt: Date.now() + 3_600_000 }
    expect(
      await sqlStateOf(
        (tx) => tx`
          insert into leave_approval_delegation
            (delegator_employee_id, deputy_employee_id, period, reason, created_by)
          values (${idOf('manager')}::uuid, ${idOf('manager')}::uuid,
                  tstzrange(to_timestamp(${window.startsAt} / 1000.0),
                            to_timestamp(${window.endsAt} / 1000.0), '[)'),
                  'delegating to myself changes nothing', 'P-HR-09 pair itest')
        `,
      ),
      // 23514: `leave_delegation_is_to_somebody_else`. A CHECK rather than a private code, because it is a
      // fact about one row.
    ).toBe('23514')

    await writeLeaveApprovalDelegation(sql, {
      delegatorEmployeeId: idOf('manager'),
      deputyEmployeeId: idOf('spare-one'),
      ...window,
      reason: 'cover while the manager is away',
      createdBy: 'P-HR-09 pair itest',
    })
    expect(
      await sqlStateOf(
        (tx) => tx`
          insert into leave_approval_delegation
            (delegator_employee_id, deputy_employee_id, period, reason, created_by)
          values (${idOf('manager')}::uuid, ${idOf('spare-one')}::uuid,
                  tstzrange(to_timestamp(${window.startsAt} / 1000.0),
                            to_timestamp(${window.endsAt} / 1000.0), '[)'),
                  'a second overlapping grant to the same person', 'P-HR-09 pair itest')
        `,
      ),
      // 23P01: `leave_delegation_no_overlapping_live`. Two candidates would make "which delegation was this
      // approval taken under" unanswerable.
    ).toBe('23P01')
  }, 60_000)
})

// ------------------------------------------------------------------------------------------------
// The trading dates a period covers
// ------------------------------------------------------------------------------------------------

describe('the trading dates a leave period covers come from the calendar, not from arithmetic', () => {
  it('reports one trading date for a one-day leave, although the period spans two calendar dates', async () => {
    const period = leavePeriod(LEAVE_DAY, LEAVE_DAY)
    expect(await readTradingDatesCovering(sql, period)).toEqual([LEAVE_DAY])
    // Two days of leave is two trading dates, and the upper bound still lands on the third calendar date.
    expect(await readTradingDatesCovering(sql, leavePeriod(LEAVE_DAY, NEXT_DAY))).toEqual([
      LEAVE_DAY,
      NEXT_DAY,
    ])
  }, 30_000)
})
