import {
  judgeReassignmentNotice,
  orderReassignmentQueue,
  REASSIGNMENT_NOTICE_TEMPLATE_KEY,
  REASSIGNMENT_REASONS,
  reassignmentCandidates,
} from '@berelax/core'
import {
  type Actor,
  clearReassignmentFlags,
  createConnection,
  flagAppointmentsForReassignment,
  listReassignmentCandidates,
  type ReassignInput,
  type ReassignmentCandidateRule,
  type ReassignmentDeps,
  type ReassignmentNoticeRule,
  readMandatoryDocumentTypes,
  readReassignmentQueue,
  reassignAppointment,
  reassignAppointmentTx,
  reassignmentRefusalOf,
  resolveReassignmentFlag,
  type Sql,
  withUnitOfWork,
} from '@berelax/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * P-HR-04 — the reassign transaction, against real PostgreSQL, with core's own rules injected.
 *
 * It lives in `packages/fixtures` because it needs both halves of a boundary. The candidate rule and the
 * notice rule are `@berelax/core`'s; the transaction that applies them is `@berelax/db`'s; and
 * `packages/db` may never import `packages/core`, so this is the only package that may see them at once —
 * the arrangement `booking-transaction.itest.ts` has for the slot re-check and
 * `therapist-eligibility.itest.ts` for the eligibility port.
 *
 * ## The race is the point, and it is driven as a race
 *
 * Two claims here cannot be made by a test that lists and commits in one quiet breath:
 *
 *   1. **A candidate eligible when listed and NOT eligible when committed is refused.** The list is a
 *      memo. Between rendering it and clicking, a licence lapses, leave is approved, another booking is
 *      taken — so the case below lists, then makes the offered therapist ineligible, then commits, and
 *      requires `therapist_not_eligible`. A transaction that trusted its input would commit happily and
 *      the appointment would be held by somebody the booking page had already stopped offering.
 *   2. **Two staff reassigning two appointments to one therapist over one period: exactly one commits.**
 *      Driven with one transaction held OPEN across the other's attempt, so the loser really does meet
 *      `appointment_therapist_no_overlap` rather than reading the winner's committed row and being turned
 *      away by the re-check. Both outcomes are correct in production and only one of them is the
 *      acceptance line, so both are asserted: the held-open case for the constraint, and a plain
 *      interleaved race for "exactly one winner, and the loser is never a 500".
 *
 * ## Isolation (brief rule 12)
 *
 * The integration suite runs sequentially against one database and earlier files leave rows behind.
 * `2095-03-17` and `2095-03-19` are used by no other suite and no gate; every room, service, variant and
 * employee here is this file's own and carries {@link MARKER}; and the reassignment reads the WHOLE
 * roster for a trading date, exactly as it does in production, so the isolation is that **nobody else is
 * rostered on those dates** rather than a filter. `audit_event`, `outbox_event` and
 * `appointment_status_history` are append-only (ADR 0008), so every assertion about them is a delta.
 *
 * The mandatory credential set is read from `regulatory_profile_current` and never named, and this file
 * does NOT supersede the profile — so there is nothing to restore and no pollution to propagate (the
 * defect P-HR-03 had to repair in two files). The therapist whose card lapses lapses `labour_card`,
 * which is in the set in force; a type that is merely on file would exclude nobody and the case would be
 * vacuous.
 *
 * Therapists are ids and `staff_reference` handles throughout. No employee here has a name (ADR 0020).
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

const MARKER = 'phr04 reassignment pair itest'
const PROBE = 'phr04_probe'
const PROBE_PHONE = '+971590000417'

/** The trading day every case but the zero-candidate one runs on. Closes at 02:00 the next day. */
const TRADING_DATE = '2095-03-17'
const NEXT_DAY = '2095-03-18'
/** A second trading day on which ONLY the incumbent is rostered, so "no candidate" is reachable. */
const LONELY_DATE = '2095-03-19'
const AFTER_LONELY = '2095-03-20'

/** Every mandatory credential expires here unless a case is about an expiry. */
const FAR_FUTURE = '2095-12-31'
/** Before both trading dates, so the holder is `credential_expired` on either. */
const LAPSED_ON = '2095-03-16'
/** The mandatory type this file lapses. It must be IN the set in force or nobody is excluded. */
const LAPSING_TYPE = 'labour_card'

const ROOM_A = 'phr04-room-a'
const ROOM_B = 'phr04-room-b'
const COUPLES_ROOM = 'phr04-couples'

const GROSS_FILS = 33_000
const NET_FILS = 31_429
const VAT_FILS = 1_571
const VAT_RATE_BP = 500
const TURNAROUND_MINUTES = 20
const BUFFER_MINUTES = 10

const CALLER: Actor = { kind: 'staff', label: 'P-HR-04 pair itest' }
const ACTOR = { kind: 'staff' as const, role: 'manager', label: 'P-HR-04 pair itest' }

/**
 * Core's two rules, as the transaction's injected dependencies.
 *
 * `satisfies` and not casts. Each pair — `ReassignmentRuleInput`/`ReassignmentRuleAnswer` in `@berelax/db`
 * against `ReassignmentQuery`/`ReassignmentCandidates` in `@berelax/core`, and `NoticeTemplateRow`
 * against `ResolvedNoticeTemplate` — is two declarations of one shape, because neither package may import
 * the other. These two lines are what make a field added to one and not the other a `pnpm typecheck`
 * failure rather than a reassignment that re-checked nothing.
 */
const DEPS: ReassignmentDeps = {
  candidates: reassignmentCandidates satisfies ReassignmentCandidateRule,
  notice: judgeReassignmentNotice satisfies ReassignmentNoticeRule,
}

let sql: Sql
let probe: Sql
let customerId: string
let variantId: string
const rooms = new Map<string, string>()
const staff = new Map<string, string>()
/** This file's own appointments, by handle, so every assertion narrows to them. */
const appointments = new Map<string, string>()

const roomId = (code: string): string => rooms.get(code) as string
const idOf = (reference: string): string => {
  const id = staff.get(reference)
  if (id === undefined) throw new Error(`no fixture employee ${reference}`)
  return id
}
const appointmentOf = (handle: string): string => {
  const id = appointments.get(handle)
  if (id === undefined) throw new Error(`no fixture appointment ${handle}`)
  return id
}
const ourAppointmentIds = (): string[] => [...appointments.values()]

const dubai = (day: string, hhmm: string): string => `${day} ${hhmm}:00+04`
const at = (day: string, hhmm: string): number => Date.parse(`${day}T${hhmm}:00+04:00`)

/** A delay that lets a concurrent transaction reach the statement it must block on. */
const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** The constraint a refused statement names, or a marker that it was not refused at all. */
async function stateOf(
  statement: PromiseLike<unknown>,
): Promise<{ readonly constraint: string; readonly message: string }> {
  try {
    await statement
    return { constraint: 'none: the statement succeeded', message: '' }
  } catch (error) {
    const err = error as { constraint_name?: unknown; constraint?: unknown }
    const named = typeof err.constraint_name === 'string' ? err.constraint_name : err.constraint
    return {
      constraint: typeof named === 'string' ? named : 'none named',
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * The mandatory set IN FORCE, with an override per type.
 *
 * Read from `regulatory_profile_current` and never hard-coded: 0058 reconciled the row in force with
 * decision 20's six, and a fixture naming two of them would stop meaning "holds every mandatory
 * document" the next time that answer moves.
 */
async function mandatoryDocuments(
  lapsed: Readonly<Record<string, string>> = {},
): Promise<readonly { readonly type: string; readonly expiresOn: string }[]> {
  const types = await readMandatoryDocumentTypes(sql)
  return types.map((type) => ({ type, expiresOn: lapsed[type] ?? FAR_FUTURE }))
}

async function addEmployee(args: {
  readonly reference: string
  readonly gender: 'female' | 'male'
  readonly skills?: readonly string[]
  readonly documents?: readonly { readonly type: string; readonly expiresOn: string }[]
}): Promise<string> {
  // Upserted: `employee_staff_reference_key` is unique, and a run that failed part-way leaves the roster
  // behind — a fixture that cannot be re-run turns one red test into a suite that never starts again.
  const [row] = await sql<{ id: string }[]>`
    insert into employee (staff_reference, gender, employed_from, notes)
    values (${args.reference}, ${args.gender}, '2090-01-01', ${MARKER})
    on conflict (staff_reference)
      do update set gender = excluded.gender, notes = excluded.notes
    returning id
  `
  const id = (row as { id: string }).id
  staff.set(args.reference, id)
  for (const skill of args.skills ?? ['asian_style']) {
    await sql`
      insert into employee_skill (employee_id, skill) values (${id}, ${skill}::therapist_skill)
      on conflict do nothing
    `
  }
  for (const document of args.documents ?? (await mandatoryDocuments())) {
    await sql`
      insert into employee_document (employee_id, document_type, expires_on)
      values (${id}, ${document.type}::employee_document_type, ${document.expiresOn})
      on conflict do nothing
    `
  }
  return id
}

/** One committed appointment, stated in full: 0038 made four of these columns NOT NULL with no default. */
async function commitAppointment(args: {
  readonly handle: string
  readonly tradingDate: string
  readonly therapist: string
  readonly room: string
  readonly from: string
  readonly to: string
  readonly shape?: 'solo' | 'four_hands' | 'couple'
  readonly deliveryId?: string
  readonly roomPlaces?: number
}): Promise<string> {
  const day = args.tradingDate
  const endsDay = args.to < args.from ? nextCalendarDay(day) : day
  const [row] = await sql<{ id: string; delivery_id: string }[]>`
    insert into appointment
      (booking_id, trading_date, service_variant_id, shape, therapist_id, room_id, period, status,
       delivery_id, room_places, turnaround_minutes, therapist_buffer_minutes,
       gross_price_fils, net_fils, vat_fils, vat_rate_bp)
    values (${await bookingFor(args.handle)}, ${day}, ${variantId},
            ${args.shape ?? 'solo'}::service_shape, ${args.therapist}, ${args.room},
            ${`[${new Date(at(day, args.from)).toISOString()},${new Date(at(endsDay, args.to)).toISOString()})`}::tstzrange,
            'confirmed', coalesce(${args.deliveryId ?? null}::uuid, uuid_generate_v7()),
            ${args.roomPlaces ?? 1},
            ${TURNAROUND_MINUTES}, ${BUFFER_MINUTES},
            ${GROSS_FILS}, ${NET_FILS}, ${VAT_FILS}, ${VAT_RATE_BP})
    returning id::text as id, delivery_id::text as delivery_id
  `
  const id = (row as { id: string }).id
  appointments.set(args.handle, id)
  return id
}

const nextCalendarDay = (day: string): string =>
  new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)

/** One booking per handle, so a case can delete its own without touching another's. */
const bookings = new Map<string, string>()
async function bookingFor(handle: string): Promise<string> {
  const held = bookings.get(handle)
  if (held !== undefined) return held
  const [row] = await sql<{ id: string }[]>`
    insert into booking (customer_id, source, notes)
    values (${customerId}, 'front_desk', ${MARKER})
    returning id::text as id
  `
  const id = (row as { id: string }).id
  bookings.set(handle, id)
  return id
}

/**
 * Raises the flag the sweep would raise, through the sweep's own writer (P-HR-03).
 *
 * The therapist is read from the appointment rather than named here: the sweep flags the row it found and
 * the therapist ON it, and a helper that wrote a different id would produce a queue entry naming somebody
 * who does not hold the appointment — which `readReassignmentQueue` joins on and a screen would print.
 */
async function flag(handle: string, tradingDate = TRADING_DATE): Promise<string> {
  const raised = await flagAppointmentsForReassignment(sql, [
    {
      appointmentId: appointmentOf(handle),
      therapistId: await therapistOf(appointmentOf(handle)),
      appointmentTradingDate: tradingDate,
      reason: 'credential_expired',
      documentType: LAPSING_TYPE,
      documentExpiresOn: LAPSED_ON,
      regulatoryProfileVersion: 1,
      detectedOn: tradingDate,
    },
  ])
  const [row] = raised
  if (row === undefined) throw new Error(`appointment ${handle} already carries a live flag`)
  return row.flagId
}

/** The columns a reassignment promises not to touch. Everything but `therapist_id` and `updated_at`. */
async function snapshotOf(appointmentId: string): Promise<Record<string, unknown>> {
  const [row] = await sql<Record<string, unknown>[]>`
    select booking_id::text, trading_date::text, service_variant_id::text, shape::text,
           room_id::text, lower(period)::text as starts_at, upper(period)::text as ends_at,
           status::text, holds_resources, delivery_id::text, room_places,
           turnaround_minutes, therapist_buffer_minutes,
           gross_price_fils::text, net_fils::text, vat_fils::text, vat_rate_bp,
           price_list_id::text, promotion_id::text, created_at::text
      from appointment where id = ${appointmentId}
  `
  return row as Record<string, unknown>
}

const therapistOf = async (appointmentId: string): Promise<string> => {
  const [row] = await sql<{ therapist_id: string }[]>`
    select therapist_id::text as therapist_id from appointment where id = ${appointmentId}
  `
  return (row as { therapist_id: string }).therapist_id
}

const liveFlagIds = async (): Promise<readonly string[]> => {
  const rows = await readReassignmentQueue(sql, { appointmentIds: ourAppointmentIds() })
  return rows.map((row) => row.appointmentId)
}

const reassignInput = (
  overrides: Partial<ReassignInput> & { appointmentId: string },
): ReassignInput => ({
  toTherapistId: idOf('phr04-free'),
  reason: 'credential_expiry',
  actor: ACTOR,
  decidedOn: TRADING_DATE,
  noticeTemplateKey: REASSIGNMENT_NOTICE_TEMPLATE_KEY,
  clientGender: 'female',
  ...overrides,
})

beforeAll(async () => {
  // Two pools. The second is what every concurrency assertion needs: a lock taken by one transaction is
  // invisible to a test running inside it. Both are small, because the suite may be running in another
  // worktree at the same time (brief rule 1).
  sql = createConnection({ url, max: 6 })
  probe = createConnection({ url, max: 3 })

  const [customer] = await sql<{ id: string }[]>`
    insert into customer (phone_e164, created_via, locale) values (${PROBE_PHONE}, 'guest_booking', 'en')
    on conflict (phone_e164) do update set created_via = excluded.created_via
    returning id
  `
  customerId = (customer as { id: string }).id

  // The trading calendar is a TABLE (0011) and `appointment.trading_date` is a foreign key into it, so a
  // fixture cannot invent a date the premises does not trade on. 11:00–02:00 Asia/Dubai.
  for (const [day, close] of [
    [TRADING_DATE, NEXT_DAY],
    [NEXT_DAY, LONELY_DATE],
    [LONELY_DATE, AFTER_LONELY],
  ] as const) {
    await sql`
      insert into business_day (trading_date, opens_at, closes_at, source)
      values (${day}, ${dubai(day, '11')}::timestamptz, ${dubai(close, '02')}::timestamptz, 'weekly')
      on conflict (trading_date) do nothing
    `
  }

  for (const [code, roomType, capacity] of [
    [ROOM_A, 'standard', 1],
    [ROOM_B, 'standard', 1],
    [COUPLES_ROOM, 'couples', 2],
  ] as const) {
    const [room] = await sql<{ id: string }[]>`
      insert into rooms (code, name, room_type, capacity, display_order, notes)
      values (${code}, ${`Probe ${code}`}, ${roomType}::room_type, ${capacity}, 94, ${MARKER})
      on conflict (code) do update set capacity = excluded.capacity
      returning id
    `
    rooms.set(code, (room as { id: string }).id)
  }

  // This file's own service, so nothing here depends on the catalogue another suite is mutating.
  const [service] = await sql<{ id: string }[]>`
    insert into service
      (style, treatment_key, slug, internal_name, public_display_name, turnaround_minutes, display_order)
    values ('asian', ${PROBE}, 'phr04-probe', 'Probe massage', 'Normal Massage (Asian)',
            ${TURNAROUND_MINUTES}, 94)
    on conflict (style, treatment_key) do update set turnaround_minutes = excluded.turnaround_minutes
    returning id
  `
  const serviceId = (service as { id: string }).id
  for (const roomType of ['standard', 'couples'] as const) {
    await sql`
      insert into service_room_type_compat (service_style, service_treatment_key, room_type)
      values ('asian', ${PROBE}, ${roomType}::room_type)
      on conflict do nothing
    `
  }
  for (const [shape, therapists, minCapacity, requiredRoomType] of [
    ['solo', 1, 1, null],
    ['four_hands', 2, 1, 'standard'],
    ['couple', 2, 2, null],
  ] as const) {
    await sql`
      insert into service_resource_shape
        (service_style, service_treatment_key, shape, therapists_required, rooms_required,
         min_room_capacity, required_room_type, therapist_buffer_minutes)
      values ('asian', ${PROBE}, ${shape}::service_shape, ${therapists}, 1, ${minCapacity},
              ${requiredRoomType}::room_type, ${BUFFER_MINUTES})
      on conflict do nothing
    `
  }
  const [variant] = await sql<{ id: string }[]>`
    insert into service_variant (service_id, duration_minutes, gross_price_fils, provisional_note)
    values (${serviceId}, 60, ${GROSS_FILS}, ${MARKER})
    on conflict (service_id, duration_minutes) do update set gross_price_fils = excluded.gross_price_fils
    returning id
  `
  variantId = (variant as { id: string }).id

  // The roster. Every one of them is female, because the client this file books for is female and
  // same-gender matching is strict: a male therapist is the gender case and nothing else.
  await addEmployee({ reference: 'phr04-incumbent', gender: 'female' })
  await addEmployee({ reference: 'phr04-free', gender: 'female' })
  await addEmployee({ reference: 'phr04-second', gender: 'female' })
  await addEmployee({ reference: 'phr04-third', gender: 'female' })
  // Two spares, held back for the Four Hands and Couple cases — and for the queue cases, which need one
  // therapist whose diary no earlier case can have touched. By the time those run, the therapists above
  // are committed across most of the evening by the cases before them, one of them by a race whose winner
  // is deliberately undecided — and a case that failed because the roster was full, or because the toss
  // went the other way, would be reporting on the fixture rather than on the thing it names.
  await addEmployee({ reference: 'phr04-spare-hands', gender: 'female' })
  await addEmployee({ reference: 'phr04-spare-couple', gender: 'female' })
  await addEmployee({ reference: 'phr04-male', gender: 'male' })
  await addEmployee({ reference: 'phr04-wrong-skill', gender: 'female', skills: ['arabic_style'] })
  await addEmployee({
    reference: 'phr04-lapsed',
    gender: 'female',
    documents: await mandatoryDocuments({ [LAPSING_TYPE]: LAPSED_ON }),
  })
  // No shift on either date, so the pool reports `not_rostered` — the day-level answer, which must stay
  // distinguishable from this unit's `not_rostered_for_the_period`.
  await addEmployee({ reference: 'phr04-unrostered', gender: 'female' })

  const rosteredOnTheMainDay = [
    'phr04-incumbent',
    'phr04-free',
    'phr04-second',
    'phr04-third',
    'phr04-spare-hands',
    'phr04-spare-couple',
    'phr04-male',
    'phr04-wrong-skill',
    'phr04-lapsed',
  ]
  const [shift] = await sql<{ id: string }[]>`
    insert into shift (trading_date, period, label)
    values (${TRADING_DATE},
            ${`[${dubai(TRADING_DATE, '11')},${dubai(NEXT_DAY, '02')})`}::tstzrange, ${MARKER})
    returning id::text as id
  `
  for (const reference of rosteredOnTheMainDay) {
    await sql`
      insert into shift_assignment (shift_id, employee_id)
      values (${(shift as { id: string }).id}, ${idOf(reference)})
      on conflict do nothing
    `
  }
  // A SHORT shift for `phr04-third`: on the rota all evening and gone before the 22:00 appointment's
  // trailing buffer, which is the difference between "a shift overlaps it" and "a shift covers it".
  const [shortShift] = await sql<{ id: string }[]>`
    insert into shift (trading_date, period, label)
    values (${LONELY_DATE},
            ${`[${dubai(LONELY_DATE, '11')},${dubai(AFTER_LONELY, '02')})`}::tstzrange, ${MARKER})
    returning id::text as id
  `
  // Only the incumbent works the lonely day, which is what makes "no eligible candidate" reachable
  // without deleting anybody: everybody else is `not_rostered` for that date.
  await sql`
    insert into shift_assignment (shift_id, employee_id)
    values (${(shortShift as { id: string }).id}, ${idOf('phr04-incumbent')})
    on conflict do nothing
  `
})

afterAll(async () => {
  const ids = [...staff.values()]
  // Flags FIRST: there is deliberately no foreign key to `appointment` (0058), so nothing cascades and a
  // row left here would be a live queue entry for an appointment that no longer exists.
  if (ourAppointmentIds().length > 0) {
    await sql`
      delete from appointment_reassignment_flag
       where appointment_id = any(${ourAppointmentIds()}::uuid[])
    `
  }
  await sql`delete from booking where notes = ${MARKER}`
  if (ids.length > 0) {
    await sql`delete from shift_assignment where employee_id = any(${ids}::uuid[])`
    await sql`delete from employee_document where employee_id = any(${ids}::uuid[])`
    await sql`delete from employee_skill where employee_id = any(${ids}::uuid[])`
  }
  await sql`delete from shift where label = ${MARKER}`
  // Deleted, not just unmarked: `employee_staff_reference_key` is unique, so a roster left behind stops
  // the next run of this file before its first assertion.
  await sql`delete from employee where notes = ${MARKER}`
  await sql`delete from service where treatment_key = ${PROBE}`
  await sql`delete from rooms where notes = ${MARKER}`
  await sql`delete from customer where phone_e164 = ${PROBE_PHONE}`
  // `business_day` is left alone: other suites own rows in this table and three here are harmless.
  // `audit_event`, `outbox_event` and `appointment_status_history` are append-only (ADR 0008).
  await probe?.end({ timeout: 5 })
  await sql?.end({ timeout: 5 })
})

describe('the candidate finder gives the same answer the booking path would', () => {
  it('offers only therapists who satisfy every constraint, and names why the others do not', async () => {
    await commitAppointment({
      handle: 'candidates',
      tradingDate: TRADING_DATE,
      therapist: idOf('phr04-incumbent'),
      room: roomId(ROOM_A),
      from: '19:00',
      to: '20:00',
    })
    // `phr04-second` is busy at the same hour in the other room, so they are the `therapist_busy` case
    // rather than a second free candidate.
    await commitAppointment({
      handle: 'blocker',
      tradingDate: TRADING_DATE,
      therapist: idOf('phr04-second'),
      room: roomId(ROOM_B),
      from: '19:00',
      to: '20:00',
    })

    const listed = await listReassignmentCandidates(
      sql,
      { appointmentId: appointmentOf('candidates'), clientGender: 'female' },
      DEPS,
    )
    const reason = (reference: string): string | undefined =>
      listed.rejected.find((row) => row.therapistId === idOf(reference))?.reason

    // Both free therapists, and nobody else. Two rather than one on purpose: a finder that returned the
    // first eligible id it found would satisfy a one-candidate expectation and would be wrong.
    expect(listed.candidates).toEqual(
      [
        idOf('phr04-free'),
        idOf('phr04-third'),
        idOf('phr04-spare-hands'),
        idOf('phr04-spare-couple'),
      ].sort(),
    )
    expect(reason('phr04-incumbent')).toBe('already_assigned')
    expect(reason('phr04-second')).toBe('therapist_busy')
    expect(reason('phr04-male')).toBe('gender_mismatch')
    expect(reason('phr04-wrong-skill')).toBe('missing_skill')
    expect(reason('phr04-lapsed')).toBe('credential_expired')
    // The day-level answer, which must stay distinguishable from this unit's period-level one.
    expect(reason('phr04-unrostered')).toBe('not_rostered')
    // The interval every candidate was judged over: the treatment plus the appointment's OWN buffer.
    expect(listed.buffered).toEqual({
      startsAt: at(TRADING_DATE, '19:00') - BUFFER_MINUTES * 60_000,
      endsAt: at(TRADING_DATE, '20:00') + BUFFER_MINUTES * 60_000,
    })
    expect(listed.genderApplied).toBe(true)
  })

  it('refuses to answer without a rule, rather than defaulting to "probably fine"', async () => {
    await expect(
      listReassignmentCandidates(
        sql,
        { appointmentId: appointmentOf('candidates'), clientGender: 'female' },
        { candidates: undefined as unknown as ReassignmentCandidateRule },
      ),
    ).rejects.toThrow(/candidates_not_revalidated/)
  })
})

describe('the reassign transaction keeps the booking and changes only the therapist', () => {
  it('leaves every other column byte-identical and records the change with an actor and a reason', async () => {
    await commitAppointment({
      handle: 'reassigned',
      tradingDate: TRADING_DATE,
      therapist: idOf('phr04-incumbent'),
      room: roomId(ROOM_A),
      from: '13:00',
      to: '14:00',
    })
    const flagId = await flag('reassigned')
    const appointmentId = appointmentOf('reassigned')
    const before = await snapshotOf(appointmentId)

    const result = await reassignAppointmentTx(sql, reassignInput({ appointmentId }), DEPS)

    // Column equality, before and after, over every column but the one that moved. The acceptance line
    // names booking_id and the snapshotted money; this is the whole row, which is stronger and no harder.
    expect(await snapshotOf(appointmentId)).toEqual(before)
    expect(await therapistOf(appointmentId)).toBe(idOf('phr04-free'))
    expect(result.fromTherapistId).toBe(idOf('phr04-incumbent'))
    expect(result.clearedFlagId).toBe(flagId)

    // The history row: the status on BOTH sides, the therapist pair, the actor, and one of the four
    // reasons. Written by the 0065 trigger and read back by the transaction, not by this test.
    const [history] = await sql<
      {
        from_status: string
        to_status: string
        from_therapist_id: string | null
        to_therapist_id: string | null
        actor_kind: string | null
        actor_role: string | null
        reason: string | null
      }[]
    >`
      select from_status::text as from_status, to_status::text as to_status,
             from_therapist_id::text as from_therapist_id, to_therapist_id::text as to_therapist_id,
             actor_kind, actor_role, reason
        from appointment_status_history
       where id = ${result.history.id}::bigint
    `
    expect(history).toEqual({
      from_status: 'confirmed',
      to_status: 'confirmed',
      from_therapist_id: idOf('phr04-incumbent'),
      to_therapist_id: idOf('phr04-free'),
      actor_kind: 'staff',
      actor_role: 'manager',
      reason: 'credential_expiry',
    })
    expect(REASSIGNMENT_REASONS).toContain(history?.reason)

    // The customer notification, against a TRANSACTIONAL template version — the class the notice was
    // judged under, carried on the event so a consumer cannot restate it (C-AUTO-01).
    expect(result.notice.templateKey).toBe(REASSIGNMENT_NOTICE_TEMPLATE_KEY)
    expect(result.notice.messageClass).toBe('transactional')
    const [notice] = await sql<{ payload: { messageClass: string; templateId: string } }[]>`
      select payload from outbox_event where id = ${result.notice.eventId}
    `
    expect(notice?.payload.messageClass).toBe('transactional')
    expect(notice?.payload.templateId).toBe(result.notice.templateId)

    // And the audit row, whose before/after pair IS the unit's claim: one column moved, the status did not.
    const [audit] = await sql<{ before_state: unknown; after_state: Record<string, unknown> }[]>`
      select before_state, after_state from audit_event
       where action = 'appointment.therapist_reassigned' and entity_id = ${appointmentId}
       order by id desc limit 1
    `
    expect(audit?.before_state).toEqual({
      therapist_id: idOf('phr04-incumbent'),
      status: 'confirmed',
    })
    expect(audit?.after_state['status']).toBe('confirmed')
    expect(audit?.after_state['therapist_id']).toBe(idOf('phr04-free'))

    // The queue entry is gone, and the row says HOW it went.
    const [cleared] = await sql<
      { cleared_reason: string; reassigned_to: string; note: string | null }[]
    >`
      select cleared_reason::text as cleared_reason,
             reassigned_to_therapist_id::text as reassigned_to,
             resolution_note as note
        from appointment_reassignment_flag where id = ${flagId}
    `
    expect(cleared).toEqual({
      cleared_reason: 'reassigned',
      reassigned_to: idOf('phr04-free'),
      note: null,
    })
    expect(await liveFlagIds()).not.toContain(appointmentId)
  })

  it('refuses a reason the database would refuse, before writing anything', async () => {
    await commitAppointment({
      handle: 'bad-reason',
      tradingDate: TRADING_DATE,
      therapist: idOf('phr04-incumbent'),
      room: roomId(ROOM_A),
      from: '15:00',
      to: '16:00',
    })
    const appointmentId = appointmentOf('bad-reason')
    const error = await reassignAppointmentTx(
      sql,
      reassignInput({ appointmentId, reason: 'the manager asked me to' }),
      DEPS,
    ).catch((err: unknown) => err)
    expect(reassignmentRefusalOf(error)).toBe('reason_not_known')
    // All-or-none: the therapist did not move, so the CHECK that fired took the whole transaction with it.
    expect(await therapistOf(appointmentId)).toBe(idOf('phr04-incumbent'))
  })

  it('refuses a therapist who is not eligible, naming the rejection', async () => {
    const appointmentId = appointmentOf('bad-reason')
    const error = await reassignAppointmentTx(
      sql,
      reassignInput({ appointmentId, toTherapistId: idOf('phr04-lapsed') }),
      DEPS,
    ).catch((err: unknown) => err)
    expect(reassignmentRefusalOf(error)).toBe('therapist_not_eligible')
    expect(String(error)).toContain('credential_expired')
    expect(await therapistOf(appointmentId)).toBe(idOf('phr04-incumbent'))
  })

  it('refuses a reassignment to the therapist who already holds it', async () => {
    const error = await reassignAppointmentTx(
      sql,
      reassignInput({
        appointmentId: appointmentOf('bad-reason'),
        toTherapistId: idOf('phr04-incumbent'),
      }),
      DEPS,
    ).catch((err: unknown) => err)
    expect(reassignmentRefusalOf(error)).toBe('therapist_unchanged')
  })

  it('refuses when the client gender nobody collected would relax the gender rule', async () => {
    // The same refusal `createBooking` makes. Spelled with the key ABSENT rather than undefined, because
    // `exactOptionalPropertyTypes` makes those different types and absent is the state being tested.
    const input = reassignInput({ appointmentId: appointmentOf('bad-reason') })
    const { clientGender: _dropped, ...withoutGender } = input
    const error = await reassignAppointmentTx(sql, withoutGender as ReassignInput, DEPS).catch(
      (err: unknown) => err,
    )
    expect(reassignmentRefusalOf(error)).toBe('therapist_not_eligible')
    expect(String(error)).toContain('gender')
  })

  it('refuses when the customer notice cannot be sent, rather than swapping in silence', async () => {
    const error = await reassignAppointmentTx(
      sql,
      reassignInput({
        appointmentId: appointmentOf('bad-reason'),
        // A real shipped template, and the WRONG one: `review.request` is promotional and in draft, so
        // both halves of the notice rule have something to say about it.
        noticeTemplateKey: 'review.request',
      }),
      DEPS,
    ).catch((err: unknown) => err)
    expect(reassignmentRefusalOf(error)).toBe('notice_not_sendable')
    expect(await therapistOf(appointmentOf('bad-reason'))).toBe(idOf('phr04-incumbent'))
  })
})

describe('the race: a candidate eligible when listed and not when committed', () => {
  it('refuses the commit, because the list was a memo', async () => {
    await commitAppointment({
      handle: 'raced',
      tradingDate: TRADING_DATE,
      therapist: idOf('phr04-incumbent'),
      room: roomId(ROOM_A),
      from: '17:00',
      to: '18:00',
    })
    const appointmentId = appointmentOf('raced')
    await flag('raced')

    // 1. The list, as a page would render it.
    const listed = await listReassignmentCandidates(
      sql,
      { appointmentId, clientGender: 'female' },
      DEPS,
    )
    expect(listed.candidates).toContain(idOf('phr04-free'))

    // 2. The world changes. A committed appointment for that therapist over the same hour is the version
    //    of this race that a human causes: somebody else books them while the queue screen is open. It is
    //    committed on the OTHER connection, so nothing about this test's session is what makes it visible.
    await commitAppointment({
      handle: 'stolen',
      tradingDate: TRADING_DATE,
      therapist: idOf('phr04-free'),
      room: roomId(ROOM_B),
      from: '17:00',
      to: '18:00',
    })

    // 3. The commit, with the tuple the page offered. Refused by NAME, and the appointment is untouched.
    const error = await reassignAppointmentTx(sql, reassignInput({ appointmentId }), DEPS).catch(
      (err: unknown) => err,
    )
    expect(reassignmentRefusalOf(error)).toBe('therapist_not_eligible')
    expect(String(error)).toContain('therapist_busy')
    expect(await therapistOf(appointmentId)).toBe(idOf('phr04-incumbent'))
    // And the queue entry is still there, which is the whole point of refusing: the work is not done.
    expect(await liveFlagIds()).toContain(appointmentId)
  })

  it('and the control: the same tuple commits when the world does NOT change under it', async () => {
    // Without this the case above passes for a transaction that refuses everything. Same appointment,
    // same therapist, the competing booking removed.
    await sql`delete from appointment where id = ${appointmentOf('stolen')}`
    appointments.delete('stolen')
    const appointmentId = appointmentOf('raced')
    const result = await reassignAppointmentTx(sql, reassignInput({ appointmentId }), DEPS)
    expect(result.toTherapistId).toBe(idOf('phr04-free'))
    expect(await liveFlagIds()).not.toContain(appointmentId)
  })
})

describe('two staff, one therapist, one period', () => {
  it('lets exactly one commit and refuses the other by the exclusion constraint', async () => {
    // Two appointments at the same hour in two different rooms, each held by a different therapist, both
    // to be reassigned to `phr04-second`. Different rooms on purpose: the room capacity must not be what
    // decides this, or the case would pass with no exclusion constraint at all.
    await commitAppointment({
      handle: 'race-a',
      tradingDate: TRADING_DATE,
      therapist: idOf('phr04-incumbent'),
      room: roomId(ROOM_A),
      from: '21:00',
      to: '22:00',
    })
    await commitAppointment({
      handle: 'race-b',
      tradingDate: TRADING_DATE,
      therapist: idOf('phr04-third'),
      room: roomId(ROOM_B),
      from: '21:00',
      to: '22:00',
    })

    // The winner's transaction is held OPEN after its update, so the loser really meets
    // `appointment_therapist_no_overlap` instead of reading a committed row and being turned away by the
    // re-check. Both are correct in production; only one of them is the acceptance line.
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const winner = withUnitOfWork(sql, CALLER, async (uow) => {
      const committed = await reassignAppointment(
        uow,
        reassignInput({
          appointmentId: appointmentOf('race-a'),
          toTherapistId: idOf('phr04-second'),
        }),
        DEPS,
      )
      await held
      return committed
    })
    // Long enough for the winner to reach its UPDATE — it is several round trips in. The loser then
    // blocks on the constraint's index rather than failing, which is what makes this a race.
    await settle(400)
    const loser = reassignAppointmentTx(
      probe,
      reassignInput({
        appointmentId: appointmentOf('race-b'),
        toTherapistId: idOf('phr04-second'),
      }),
      DEPS,
    ).catch((err: unknown) => err)
    await settle(400)
    release()

    const committed = await winner
    const refused = await loser
    expect(committed.toTherapistId).toBe(idOf('phr04-second'))
    // Refused BY NAME and as a conflict, not a 500 — and the SQLSTATE says which rule decided it.
    expect(reassignmentRefusalOf(refused)).toBe('slot_taken')
    expect((refused as { details?: Record<string, unknown> }).details?.['sqlState']).toBe('23P01')
    expect((refused as { kind?: string }).kind).toBe('conflict')
    // All-or-none for the loser: its appointment is exactly as it was.
    expect(await therapistOf(appointmentOf('race-b'))).toBe(idOf('phr04-third'))
    expect(await therapistOf(appointmentOf('race-a'))).toBe(idOf('phr04-second'))
  })

  it('and under a plain interleaved race, exactly one wins and the loser is never unnamed', async () => {
    // The ordinary version, with no orchestration: whichever way the two interleave, one commits and the
    // other is refused by a name this build declares. An untranslated driver error reaching a caller is
    // the failure this asserts against — the front desk cannot act on a 500.
    await commitAppointment({
      handle: 'race-c',
      tradingDate: TRADING_DATE,
      therapist: idOf('phr04-incumbent'),
      room: roomId(ROOM_A),
      from: '11:30',
      to: '12:30',
    })
    await commitAppointment({
      handle: 'race-d',
      tradingDate: TRADING_DATE,
      therapist: idOf('phr04-third'),
      room: roomId(ROOM_B),
      from: '11:30',
      to: '12:30',
    })
    const settled = await Promise.allSettled([
      reassignAppointmentTx(
        sql,
        reassignInput({
          appointmentId: appointmentOf('race-c'),
          toTherapistId: idOf('phr04-free'),
        }),
        DEPS,
      ),
      reassignAppointmentTx(
        probe,
        reassignInput({
          appointmentId: appointmentOf('race-d'),
          toTherapistId: idOf('phr04-free'),
        }),
        DEPS,
      ),
    ])
    const fulfilled = settled.filter((result) => result.status === 'fulfilled')
    const rejected = settled.filter((result) => result.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    // Either refusal is correct — the constraint if the loser got as far as its UPDATE, the re-check if
    // it read the pool after the winner committed. Both are named; neither is a 500.
    expect(['slot_taken', 'therapist_not_eligible']).toContain(
      reassignmentRefusalOf((rejected[0] as PromiseRejectedResult).reason),
    )
  })
})

describe('with no eligible candidate the appointment stays exactly where it is', () => {
  it('is never cancelled, never unassigned, and stays on the queue', async () => {
    // The lonely trading day: only the incumbent is rostered, so every other therapist is `not_rostered`
    // and the incumbent is `already_assigned`. Nobody is deleted to arrange it.
    await commitAppointment({
      handle: 'stranded',
      tradingDate: LONELY_DATE,
      therapist: idOf('phr04-incumbent'),
      room: roomId(ROOM_A),
      from: '19:00',
      to: '20:00',
    })
    const appointmentId = appointmentOf('stranded')
    await flag('stranded', LONELY_DATE)
    const before = await snapshotOf(appointmentId)

    const listed = await listReassignmentCandidates(
      sql,
      { appointmentId, clientGender: 'female' },
      DEPS,
    )
    expect(listed.candidates).toEqual([])
    // A rejection for everybody, so "no candidates" is an answer rather than an empty read.
    expect(listed.rejected.length).toBeGreaterThan(0)

    // Nothing has changed about the appointment, and it is still on the queue with its reason.
    expect(await snapshotOf(appointmentId)).toEqual(before)
    const [entry] = await readReassignmentQueue(sql, { appointmentIds: [appointmentId] })
    expect(entry?.reason).toBe('credential_expired')
    expect(entry?.documentType).toBe(LAPSING_TYPE)
    expect(entry?.appointmentStatus).toBe('confirmed')
    expect(entry?.therapistReference).toBe('phr04-incumbent')

    // The three things the flag must never have caused, asserted of the row rather than of the code.
    const [row] = await sql<{ status: string; therapist_id: string; holds: boolean }[]>`
      select status::text as status, therapist_id::text as therapist_id, holds_resources as holds
        from appointment where id = ${appointmentId}
    `
    expect(row?.status).toBe('confirmed')
    expect(row?.therapist_id).toBe(idOf('phr04-incumbent'))
    expect(row?.holds).toBe(true)
  })
})

describe('the queue, and the three ways out of it', () => {
  it('is ordered by the appointment start, and by the same rule the pure comparator applies', async () => {
    // Flagged in the opposite order to the one they start in, so "ordered by start" is not satisfied by
    // insertion order. `stranded` is already flagged and starts on the lonely day, which is last.
    await commitAppointment({
      handle: 'queue-late',
      tradingDate: TRADING_DATE,
      therapist: idOf('phr04-incumbent'),
      room: roomId(ROOM_A),
      from: '23:00',
      to: '23:59',
    })
    await commitAppointment({
      // The couples room, because both standard rooms already hold an 11:30 appointment from the race
      // cases above and 0024's capacity trigger is right to refuse a second client place in a
      // capacity-1 room. Nothing about this case is about the room.
      //
      // And a SPARE therapist, not the incumbent, because this hour is the one the interleaved race ran
      // in: whichever of those two reassignments won, the loser's row keeps the therapist it started
      // with, so 11:30–12:30 is held by the incumbent in one outcome and by `phr04-third` in the other.
      // Booking the incumbent across it would have made this case pass or fail on the toss —
      // `appointment_therapist_no_overlap` is right to refuse it — and the three cases in this block
      // would then report on the race rather than on the queue. `phr04-spare-hands` is not in that race
      // and is not booked until 16:00, which the Four Hands case below needs it free for.
      handle: 'queue-early',
      tradingDate: TRADING_DATE,
      therapist: idOf('phr04-spare-hands'),
      room: roomId(COUPLES_ROOM),
      from: '12:00',
      to: '13:00',
    })
    await flag('queue-late')
    await flag('queue-early')

    const queue = await readReassignmentQueue(sql, { appointmentIds: ourAppointmentIds() })
    const order = queue.map((row) => row.appointmentId)
    expect(order.indexOf(appointmentOf('queue-early'))).toBeLessThan(
      order.indexOf(appointmentOf('queue-late')),
    )
    expect(order.indexOf(appointmentOf('queue-late'))).toBeLessThan(
      order.indexOf(appointmentOf('stranded')),
    )
    // And the SQL agrees with the pure comparator, which is what stops a screen that re-sorts showing a
    // different queue from the one the reader was given.
    expect(
      orderReassignmentQueue(
        queue.map((row) => ({
          appointmentId: row.appointmentId,
          startsAt: row.startsAt.getTime(),
          reason: row.reason,
          documentType: row.documentType,
        })),
      ).map((row) => row.appointmentId),
    ).toEqual(order)
    // Every entry carries the reason and the document type, which is what the acceptance asks the queue
    // to show: "a credential lapsed" is the message nobody can act on.
    for (const row of queue) {
      expect(row.reason).toBe('credential_expired')
      expect(row.documentType).toBe(LAPSING_TYPE)
    }
  })

  it('lets a human close an entry, audited, with a note the database insists on', async () => {
    const appointmentId = appointmentOf('queue-late')
    // No note is no resolution: the other two exits have an external fact behind them and this one has
    // only what somebody wrote down.
    await expect(
      resolveReassignmentFlag(sql, {
        appointmentId,
        note: '   ',
        actor: ACTOR,
        decidedOn: TRADING_DATE,
      }),
    ).rejects.toThrow(/nothing_to_resolve/)

    const resolved = await resolveReassignmentFlag(sql, {
      appointmentId,
      note: 'The customer moved this booking by phone; the incumbent keeps it.',
      actor: ACTOR,
      decidedOn: TRADING_DATE,
    })
    const [row] = await sql<
      { cleared_reason: string; note: string; cleared_on: string; successor: string | null }[]
    >`
      select cleared_reason::text as cleared_reason, resolution_note as note,
             cleared_on::text as cleared_on, reassigned_to_therapist_id::text as successor
        from appointment_reassignment_flag where id = ${resolved.flagId}
    `
    expect(row?.cleared_reason).toBe('resolved_by_hand')
    expect(row?.note).toContain('by phone')
    expect(row?.cleared_on).toBe(TRADING_DATE)
    expect(row?.successor).toBeNull()
    // Audited, in the same transaction as the clearance.
    const [audit] = await sql<{ after_state: Record<string, unknown> }[]>`
      select after_state from audit_event
       where action = 'appointment.reassignment_resolved' and entity_id = ${appointmentId}
       order by id desc limit 1
    `
    expect(audit?.after_state['resolution_note']).toContain('by phone')
    expect(audit?.after_state['actor_role']).toBe('manager')
    // And the appointment itself is untouched: what was withdrawn is the claim that somebody else must
    // take it, not the therapist.
    expect(await therapistOf(appointmentId)).toBe(idOf('phr04-incumbent'))
    expect(await liveFlagIds()).not.toContain(appointmentId)
    // A second resolution has nothing to resolve, so a double-click cannot record two decisions.
    await expect(
      resolveReassignmentFlag(sql, {
        appointmentId,
        note: 'again',
        actor: ACTOR,
        decidedOn: TRADING_DATE,
      }),
    ).rejects.toThrow(/nothing_to_resolve/)
  })

  it('has exactly three exits, and none of them is a bare UPDATE or a DELETE', async () => {
    // The three labels, from the database rather than from a constant here.
    const labels = await sql<{ label: string }[]>`
      select e.enumlabel as label
        from pg_enum e join pg_type t on t.oid = e.enumtypid
       where t.typname = 'appointment_reassignment_clearance'
       order by e.enumsortorder
    `
    expect(labels.map((row) => row.label)).toEqual([
      'credential_restored',
      'reassigned',
      'resolved_by_hand',
    ])

    // The sweep's own exit, through P-HR-03's writer, names the first of them.
    const appointmentId = appointmentOf('queue-early')
    const [cleared] = await clearReassignmentFlags(sql, {
      appointmentIds: [appointmentId],
      clearedOn: TRADING_DATE,
    })
    expect(cleared).toBeDefined()
    const sweptFlagId = (cleared as { flagId: string }).flagId
    const [row] = await sql<{ cleared_reason: string }[]>`
      select cleared_reason::text as cleared_reason
        from appointment_reassignment_flag where id = ${sweptFlagId}
    `
    expect(row?.cleared_reason).toBe('credential_restored')

    // And there is no fourth way out. Stamping `cleared_at` without naming which exit it was is refused
    // by the database, which is what makes the acceptance line a constraint rather than a convention.
    const [live] = await sql<{ id: string }[]>`
      select id::text as id from appointment_reassignment_flag
       where appointment_id = ${appointmentOf('stranded')}::uuid and cleared_at is null
    `
    const liveFlagId = (live as { id: string }).id
    const refused = await stateOf(sql`
      update appointment_reassignment_flag
         set cleared_at = now(), cleared_on = ${TRADING_DATE}::date
       where id = ${liveFlagId}
    `)
    expect(refused.constraint).toBe('appointment_reassignment_flag_clearance_is_whole')
    // DELETE is revoked for the application role, so a queue entry cannot be made to disappear either.
    const [privilege] = await sql<{ has: boolean }[]>`
      select has_table_privilege('berelax_app', 'appointment_reassignment_flag', 'DELETE') as has
    `
    expect(privilege?.has).toBe(false)
  })
})

describe('a Four Hands and a Couple keep their shape when one row is reassigned', () => {
  it('moves one therapist and leaves the delivery, the room and the places alone', async () => {
    // Four Hands: two rows, one delivery, one standard room, one client place.
    const [fresh] = await sql<{ id: string }[]>`select uuid_generate_v7() as id`
    const deliveryId = (fresh as { id: string }).id
    await commitAppointment({
      handle: 'four-hands-a',
      tradingDate: TRADING_DATE,
      therapist: idOf('phr04-incumbent'),
      room: roomId(ROOM_A),
      from: '16:00',
      to: '17:00',
      shape: 'four_hands',
      deliveryId,
      roomPlaces: 1,
    })
    await commitAppointment({
      handle: 'four-hands-b',
      tradingDate: TRADING_DATE,
      therapist: idOf('phr04-second'),
      room: roomId(ROOM_A),
      from: '16:00',
      to: '17:00',
      shape: 'four_hands',
      deliveryId,
      roomPlaces: 1,
    })
    await flag('four-hands-a')

    const sibling = await snapshotOf(appointmentOf('four-hands-b'))
    const listed = await listReassignmentCandidates(
      sql,
      { appointmentId: appointmentOf('four-hands-a'), clientGender: 'female' },
      DEPS,
    )
    // The sibling therapist is NOT a candidate: they are already working this hour, in this room, on the
    // other half of the same delivery. One person cannot deliver both halves of a Four Hands.
    expect(listed.candidates).not.toContain(idOf('phr04-second'))
    expect(listed.rejected.find((row) => row.therapistId === idOf('phr04-second'))?.reason).toBe(
      'therapist_busy',
    )
    expect(listed.candidates).toContain(idOf('phr04-spare-hands'))

    await reassignAppointmentTx(
      sql,
      reassignInput({
        appointmentId: appointmentOf('four-hands-a'),
        toTherapistId: idOf('phr04-spare-hands'),
      }),
      DEPS,
    )

    // The sibling row is untouched, and the delivery is still one delivery: same room, same period, same
    // places, same trading date and same shape. `appointment_delivery_is_coherent` (ZB004) would have
    // refused the transaction otherwise, which is why `set constraints all immediate` runs inside it.
    expect(await snapshotOf(appointmentOf('four-hands-b'))).toEqual(sibling)
    const rows = await sql<{ therapist_id: string; delivery_id: string; room_places: number }[]>`
      select therapist_id::text as therapist_id, delivery_id::text as delivery_id, room_places
        from appointment where delivery_id = ${deliveryId}::uuid order by therapist_id
    `
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((row) => row.therapist_id))).toEqual(
      new Set([idOf('phr04-spare-hands'), idOf('phr04-second')]),
    )
    expect(new Set(rows.map((row) => row.room_places))).toEqual(new Set([1]))
    // And the room still holds ONE client place at that instant, which is what a Four Hands is.
    const [peak] = await sql<{ concurrent: number }[]>`
      select concurrent from room_peak_concurrency(${roomId(ROOM_A)}::uuid,
        tstzrange(${new Date(at(TRADING_DATE, '16:00')).toISOString()}::timestamptz,
                  ${new Date(at(TRADING_DATE, '17:00')).toISOString()}::timestamptz, '[)'))
    `
    expect(peak?.concurrent).toBe(1)
  })

  it('does the same for a Couple in a capacity-2 room', async () => {
    const [fresh] = await sql<{ id: string }[]>`select uuid_generate_v7() as id`
    const deliveryId = (fresh as { id: string }).id
    await commitAppointment({
      handle: 'couple-a',
      tradingDate: TRADING_DATE,
      therapist: idOf('phr04-incumbent'),
      room: roomId(COUPLES_ROOM),
      from: '18:00',
      to: '19:00',
      shape: 'couple',
      deliveryId,
      roomPlaces: 2,
    })
    await commitAppointment({
      handle: 'couple-b',
      tradingDate: TRADING_DATE,
      therapist: idOf('phr04-second'),
      room: roomId(COUPLES_ROOM),
      from: '18:00',
      to: '19:00',
      shape: 'couple',
      deliveryId,
      roomPlaces: 2,
    })
    await flag('couple-a')
    const sibling = await snapshotOf(appointmentOf('couple-b'))

    const result = await reassignAppointmentTx(
      sql,
      reassignInput({
        appointmentId: appointmentOf('couple-a'),
        toTherapistId: idOf('phr04-spare-couple'),
      }),
      DEPS,
    )
    expect(result.toTherapistId).toBe(idOf('phr04-spare-couple'))
    expect(await snapshotOf(appointmentOf('couple-b'))).toEqual(sibling)
    const [peak] = await sql<{ concurrent: number }[]>`
      select concurrent from room_peak_concurrency(${roomId(COUPLES_ROOM)}::uuid,
        tstzrange(${new Date(at(TRADING_DATE, '18:00')).toISOString()}::timestamptz,
                  ${new Date(at(TRADING_DATE, '19:00')).toISOString()}::timestamptz, '[)'))
    `
    // Two client places, unchanged by the reassignment: the couples room is full and still legal.
    expect(peak?.concurrent).toBe(2)
  })
})

describe('the four reasons are one list, in two places', () => {
  it('pins REASSIGNMENT_REASONS to the CHECK constraint 0065 writes, in both directions', async () => {
    // Parsed out of `pg_constraint`, the arrangement 0046 made for `actor_role`: a fifth reason added to
    // core and not to the migration is a reassignment the database refuses at the last statement of a
    // transaction that has already done everything else, and one added to the migration and not to core
    // is a reason nothing can ever write.
    const [row] = await sql<{ definition: string }[]>`
      select pg_get_constraintdef(oid) as definition
        from pg_constraint
       where conname = 'appointment_status_history_reassignment_reason_known'
    `
    const definition = (row as { definition: string }).definition
    const accepted = [...definition.matchAll(/'([a-z_]+)'::text/g)].map((match) => match[1]).sort()
    expect(accepted).toEqual([...REASSIGNMENT_REASONS].sort())
  })
})
