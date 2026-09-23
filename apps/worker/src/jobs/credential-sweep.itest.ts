import {
  ASIA_DUBAI,
  type HoursForDate,
  type Instant,
  instantFromIso,
  localDate,
  localTime,
  poolSolverInput,
  type SlotRequest,
  solveAvailability,
  type TherapistPool,
  type TradingHours,
  toLocal,
} from '@berelax/core'
import {
  createConnection,
  readEligibleTherapists,
  readLiveReassignmentFlags,
  readMandatoryDocumentTypes,
  readReassignmentCandidates,
  type Sql,
  type TherapistPoolRead,
} from '@berelax/db'
import { requiredSkillFor } from '@berelax/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { JOB_REGISTRY } from '../registry.ts'
import {
  CREDENTIAL_REASSIGNMENT_CLEARED_EVENT,
  CREDENTIAL_REASSIGNMENT_EVENT,
  CREDENTIAL_SWEEP_AGENT,
  runCredentialSweep,
} from './credential-sweep.ts'

/**
 * P-HR-03 — an expired credential removes a therapist from availability and flags their appointments.
 *
 * Two halves of one rule, against real PostgreSQL:
 *
 *   1. **Availability stops offering them.** The credential gate lives in `therapistPoolCtes`'s
 *      `tp_credential` CTE (B-AVAIL-04) and reports `credential_expired`; `poolSolverInput` then hands
 *      the solver a candidate list that no longer contains the therapist, so the slots are gone rather
 *      than filtered. The pool and the solver are used directly instead of `queryAvailability` because
 *      the claim is about the therapist half: a room, a price list and a resource shape would be three
 *      more ways for the fixture to fail without saying anything about a credential.
 *   2. **Their existing appointments are flagged**, by the nightly sweep, and nothing else about them
 *      changes. That is the half nothing before this unit could do: the query protects bookings not yet
 *      taken and says nothing about the three weeks already in the diary.
 *
 * ## The two dates that are not the same date
 *
 * Trading runs 11:00–02:00 (0011), so the 17th's session ends at 02:00 on the 18th, and both halves of
 * this file turn on it:
 *
 *   - a labour card expiring on the 17th **covers** the 17th's 01:30 appointment, whose CALENDAR date is
 *     the 18th, because the comparison is against the TRADING date;
 *   - the sweep's window is floored with the trading date read from `business_day`, so a pass at 00:30
 *     still sees that 01:30 appointment as future. A floor of `date(now)` would skip it — which is the
 *     two hours of every trading day in which a therapist whose card lapsed at local midnight keeps
 *     their bookings.
 *
 * Both are asserted with the deliberately wrong version beside them, because "the 01:30 appointment was
 * swept" is also what a sweep with no window at all would report.
 *
 * ## Isolation (brief rule 12)
 *
 * The integration suite runs sequentially against one database and earlier files leave rows behind. The
 * sweep reads the WHOLE future diary, exactly as it does in production, so nothing here asserts a total:
 * every assertion is narrowed to this file's own appointment ids, and the flag counts are deltas over
 * that set. The trading dates `2093-06-17..19` are used by no other suite and no gate, and every row
 * this file writes carries {@link MARKER}.
 *
 * Therapists are ids and `staff_reference` handles throughout; no employee here has a name (ADR 0020).
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

const MARKER = 'phr03 credential sweep itest'
const PROBE_PHONE = '+971590000617'

/** The trading day the lapsing labour card is valid THROUGH. Its session ends 02:00 on the 18th. */
const TRADING_DATE = '2093-06-17'
/** The next trading day. The card has lapsed by this date, so every appointment on it is flagged. */
const NEXT_TRADING_DATE = '2093-06-18'
/** Needed only so {@link NEXT_TRADING_DATE}'s session has a calendar day to close on. */
const DAY_AFTER = '2093-06-19'
const DATES = [TRADING_DATE, NEXT_TRADING_DATE, DAY_AFTER]

/** Every mandatory credential expires here except the one the case is about. */
const FAR_FUTURE = '2093-12-31'
/** The renewal filed in the last case: a NEW row, never an edit (employee_document_one_row_per_expiry). */
const RENEWED_TO = '2094-12-31'
/** Lapsed BEFORE the first trading date, so every appointment of that therapist is already unservable. */
const ALREADY_LAPSED = '2093-06-16'
/** The mandatory type this file lapses. It must be IN the set in force or nobody is excluded. */
const LAPSING_TYPE = 'labour_card'

/**
 * 00:30 on the 18th — INSIDE the 17th's trading session, which closes at 02:00.
 *
 * Chosen rather than the cron's own 04:45 because it is the instant that tells the two window floors
 * apart: the trading date here is the 17th and the calendar date is the 18th, so a sweep that floored
 * its window with the calendar date would drop the 17th's 01:30 appointment entirely.
 */
const SWEEP_AT = '2093-06-18T00:30:00+04:00'
/** A second pass, later the same trading session. Same trading date, so the idempotency claim is real. */
const SWEEP_AGAIN_AT = '2093-06-18T01:00:00+04:00'

const HOURS: TradingHours = { open: localTime('11:00'), close: localTime('02:00') }
const HOURS_FOR: HoursForDate = () => HOURS
const dubai = (day: string, hhmm: string): string => `${day} ${hhmm}:00+04`
const at = (day: string, hhmm: string): Instant => instantFromIso(`${day}T${hhmm}:00+04:00`)
const wall = (instant: Instant): string => toLocal(instant, ASIA_DUBAI).time

const DURATION_MINUTES = 60
const TURNAROUND_MINUTES = 20
const BUFFER_MINUTES = 10
const GROSS_FILS = 20_000
const NET_FILS = 19_048
const VAT_FILS = 952

let sql: Sql
let roomId = ''
/** A second room, so two fixture appointments may share one 01:30 without tripping room capacity. */
let secondRoomId = ''
let variantId = ''
let bookingId = ''
const staff = new Map<string, string>()
/** This file's own appointments, by handle, so every assertion narrows to them. */
const appointments = new Map<string, string>()

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

/**
 * A fixture therapist holding every mandatory credential, with `lapsed` overriding one type's expiry.
 *
 * The set is read from `regulatory_profile_current` and never named. Migration 0058 reconciled the row
 * in force with the column DEFAULT — docs/01 decision 20's six — and a fixture that named two of them
 * would stop meaning "holds every mandatory document" the next time that answer moves.
 */
async function addEmployee(args: {
  readonly reference: string
  readonly lapsed?: Readonly<Record<string, string>>
}): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into employee (staff_reference, gender, employed_from, notes)
    values (${args.reference}, 'female', '2090-01-01', ${MARKER})
    on conflict (staff_reference) do update set gender = 'female', notes = excluded.notes
    returning id
  `
  const id = (row as { id: string }).id
  staff.set(args.reference, id)
  await sql`
    insert into employee_skill (employee_id, skill) values (${id}, 'asian_style')
    on conflict do nothing
  `
  for (const documentType of await readMandatoryDocumentTypes(sql)) {
    await sql`
      insert into employee_document (employee_id, document_type, expires_on)
      values (${id}, ${documentType}::employee_document_type,
              ${args.lapsed?.[documentType] ?? FAR_FUTURE}::date)
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
  readonly startsAt: Instant
  readonly endsAt: Instant
  readonly room?: string
}): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into appointment
      (booking_id, trading_date, service_variant_id, shape, therapist_id, room_id, period, status,
       delivery_id, room_places, turnaround_minutes, therapist_buffer_minutes,
       gross_price_fils, net_fils, vat_fils)
    values (${bookingId}, ${args.tradingDate}, ${variantId}, 'solo', ${args.therapist},
            ${args.room ?? roomId},
            ${`[${new Date(args.startsAt).toISOString()},${new Date(args.endsAt).toISOString()})`}::tstzrange,
            'confirmed', uuid_generate_v7(), 1, ${TURNAROUND_MINUTES}, ${BUFFER_MINUTES},
            ${GROSS_FILS}, ${NET_FILS}, ${VAT_FILS})
    returning id::text as id
  `
  const id = (row as { id: string }).id
  appointments.set(args.handle, id)
  return id
}

/**
 * The db pool in the port's shape, so the solver can be handed it.
 *
 * `shifts` is the one field re-wrapped, and only to brand the instants: `Instant` is
 * `Brand<number, 'Instant'>` in `@berelax/core` and `packages/db` may not import core, so the reader
 * answers in epoch milliseconds and the brand is applied on the one side that can see both. The same
 * field copy `asPool` makes in `packages/fixtures/src/therapist-eligibility.itest.ts`, which is where
 * the two shapes are pinned to each other with `satisfies`.
 */
const asPool = (read: TherapistPoolRead): TherapistPool => ({
  therapists: read.therapists,
  excluded: read.excluded,
  shifts: read.shifts.map((shift) => ({
    therapistId: shift.therapistId,
    period: {
      startsAt: shift.period.startsAt as Instant,
      endsAt: shift.period.endsAt as Instant,
    },
  })),
})

/** The slots the availability read offers for one therapist on one trading date. */
async function slotsFor(reference: string, tradingDate: string): Promise<readonly string[]> {
  const pool = asPool(
    await readEligibleTherapists(sql, {
      tradingDate,
      requiredSkill: requiredSkillFor('asian'),
      employeeIds: [idOf(reference)],
    }),
  )
  const request: SlotRequest = {
    now: at(tradingDate, '09'),
    tradingDate: localDate(tradingDate),
    hoursFor: HOURS_FOR,
    closures: [],
    durationMinutes: DURATION_MINUTES,
    turnaroundMinutes: TURNAROUND_MINUTES,
    therapistBufferMinutes: BUFFER_MINUTES,
    minLeadMinutes: 120,
    maxAdvanceDays: 90_000,
    rooms: [{ id: roomId, roomType: 'standard', capacity: 1, isBookable: true }],
    compatibleRoomTypes: ['standard'],
    // Deliberately empty: this file's own committed appointments would otherwise remove the very hours
    // the comparison is about, and the claim here is about the CANDIDATE list rather than about
    // occupancy. `therapist-eligibility.itest.ts` owns the occupancy half.
    appointments: [],
    blocks: [],
    stepMinutes: 30,
    // The whole of the wiring. Nothing in solveAvailability learns what a credential is.
    ...poolSolverInput(pool),
  }
  return solveAvailability(request).slots.map((slot) => wall(slot.startsAt))
}

/** The pool's reason for one therapist on one trading date, or null when they are eligible. */
async function reasonFor(reference: string, tradingDate: string): Promise<string | null> {
  const pool = await readEligibleTherapists(sql, {
    tradingDate,
    requiredSkill: requiredSkillFor('asian'),
    employeeIds: [idOf(reference)],
  })
  return pool.excluded.find((t) => t.therapistId === idOf(reference))?.reason ?? null
}

/** The live flags over THIS file's appointments, keyed by handle. Never a total (brief rule 12). */
async function liveFlags(): Promise<Map<string, { reason: string; documentType: string }>> {
  const rows = await readLiveReassignmentFlags(sql, { appointmentIds: ourAppointmentIds() })
  const byHandle = new Map<string, { reason: string; documentType: string }>()
  for (const row of rows) {
    const handle = [...appointments].find(([, id]) => id === row.appointmentId)?.[0]
    if (handle !== undefined) {
      byHandle.set(handle, { reason: row.reason, documentType: row.documentType })
    }
  }
  return byHandle
}

/** Outbox rows this file's appointments produced, by event type. A delta, never a total (ADR 0008). */
async function eventsFor(eventType: string): Promise<readonly string[]> {
  const rows = await sql<{ aggregate_id: string }[]>`
    select aggregate_id::text as aggregate_id
      from outbox_event
     -- aggregate_id is TEXT (0006) rather than a uuid, so the comparison is against a text array.
     where event_type = ${eventType}
       and aggregate_id = any(${ourAppointmentIds()}::text[])
     order by aggregate_id
  `
  return rows.map((row) => row.aggregate_id)
}

/** Audit rows this file's appointments produced, for the same reason and in the same shape. */
async function auditCount(action: string): Promise<number> {
  const [row] = await sql<{ n: string }[]>`
    select count(*)::text as n from audit_event
     -- entity_id is TEXT (0005): an audit row outlives the table it describes, so it holds no uuid.
     where action = ${action}
       and entity_type = 'appointment'
       and entity_id = any(${ourAppointmentIds()}::text[])
  `
  return Number((row as { n: string }).n)
}

/** Every appointment of this file, with the two columns the sweep promises never to touch. */
async function statusesAndTherapists(): Promise<readonly { status: string; therapist: string }[]> {
  return sql<{ status: string; therapist: string }[]>`
    select status::text as status, therapist_id::text as therapist
      from appointment
     where id = any(${ourAppointmentIds()}::uuid[])
     order by id
  `
}

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })

  await sql`
    insert into business_day (trading_date, opens_at, closes_at, source)
    select d::date, (d::date || ' 11:00:00+04')::timestamptz,
           ((d::date + 1) || ' 02:00:00+04')::timestamptz, 'weekly'
      from unnest(${DATES}::date[]) as d
    on conflict (trading_date) do nothing
  `

  const [room] = await sql<{ id: string }[]>`select id from rooms where code = 'room-1'`
  roomId = (room as { id: string }).id
  const [second] = await sql<{ id: string }[]>`select id from rooms where code = 'room-2'`
  secondRoomId = (second as { id: string }).id
  const [variant] = await sql<{ id: string }[]>`
    select sv.id from service_variant sv
      join service s on s.id = sv.service_id
     where s.style = 'asian' and s.treatment_key = 'normal_massage'
       and sv.duration_minutes = ${DURATION_MINUTES}
  `
  variantId = (variant as { id: string }).id

  const [customer] = await sql<{ id: string }[]>`
    insert into customer (phone_e164, created_via) values (${PROBE_PHONE}, 'guest_booking')
    on conflict (phone_e164) do update set created_via = excluded.created_via
    returning id
  `
  const [booking] = await sql<{ id: string }[]>`
    insert into booking (customer_id, source, notes)
    values (${(customer as { id: string }).id}, 'front_desk', ${MARKER})
    returning id
  `
  bookingId = (booking as { id: string }).id

  // The therapist the file is about: every mandatory credential, with the labour card expiring at the
  // END of the 17th. Eligible on the 17th, not on the 18th — one row, both answers.
  await addEmployee({ reference: 'phr03-lapsing', lapsed: { [LAPSING_TYPE]: TRADING_DATE } })
  // The control. Identical in every respect except that nothing of theirs expires, so an assertion that
  // the lapsing therapist lost their slots is not satisfied by a fixture in which nobody has any.
  await addEmployee({ reference: 'phr03-clear' })
  // Already lapsed before the first trading date, which is what gives the WINDOW something to get wrong:
  // their 01:30 appointment carries the 17th's trading date and a calendar-date floor would skip it, so
  // the flag going missing is the observable consequence of flooring the window with `date(now)`.
  await addEmployee({ reference: 'phr03-expired', lapsed: { [LAPSING_TYPE]: ALREADY_LAPSED } })

  for (const tradingDate of [TRADING_DATE, NEXT_TRADING_DATE]) {
    const nextCalendarDay = tradingDate === TRADING_DATE ? NEXT_TRADING_DATE : DAY_AFTER
    const [shift] = await sql<{ id: string }[]>`
      insert into shift (trading_date, period, label)
      values (${tradingDate},
              ${`[${dubai(tradingDate, '11')},${dubai(nextCalendarDay, '02')})`}::tstzrange,
              ${MARKER})
      returning id::text as id
    `
    for (const id of staff.values()) {
      await sql`
        insert into shift_assignment (shift_id, employee_id)
        values (${(shift as { id: string }).id}, ${id})
        on conflict do nothing
      `
    }
  }

  // Four appointments, and each one is a different question.
  //
  //   past          — 20:00 on the 17th. BEFORE the sweep instant, so it is out of the window: nobody
  //                   can reassign a treatment that has already started, and the sweep must not try.
  //   after-midnight— 01:30 on the 18th, which is the 17th's TRADING date. In the window (its start is
  //                   after the sweep instant) and covered by the card (expires_on is not < 17th), so
  //                   it is considered and NOT flagged. Both halves of the trading-date rule in one row.
  //   lapsed        — 20:00 on the 18th. The card expired at the end of the 17th, so this is the one
  //                   that must be flagged.
  //   control       — the same slot on the 18th for the therapist whose file is current.
  await commitAppointment({
    handle: 'past',
    tradingDate: TRADING_DATE,
    therapist: idOf('phr03-lapsing'),
    startsAt: at(TRADING_DATE, '20'),
    endsAt: at(TRADING_DATE, '21'),
  })
  await commitAppointment({
    handle: 'after-midnight',
    tradingDate: TRADING_DATE,
    therapist: idOf('phr03-lapsing'),
    startsAt: at(NEXT_TRADING_DATE, '01:30'),
    endsAt: at(NEXT_TRADING_DATE, '02:30'),
  })
  await commitAppointment({
    handle: 'lapsed',
    tradingDate: NEXT_TRADING_DATE,
    therapist: idOf('phr03-lapsing'),
    startsAt: at(NEXT_TRADING_DATE, '20'),
    endsAt: at(NEXT_TRADING_DATE, '21'),
  })
  await commitAppointment({
    handle: 'control',
    tradingDate: NEXT_TRADING_DATE,
    therapist: idOf('phr03-clear'),
    startsAt: at(NEXT_TRADING_DATE, '18'),
    endsAt: at(NEXT_TRADING_DATE, '19'),
  })
  // The fourth question: 01:30 on the 18th again — the 17th's trading date — for the therapist whose
  // card lapsed on the 16th. In the window and NOT covered, so it must be flagged. A second room,
  // because room-1 is already held at that minute by `after-midnight` and 0024's capacity trigger is
  // right to refuse two.
  await commitAppointment({
    handle: 'after-midnight-expired',
    tradingDate: TRADING_DATE,
    therapist: idOf('phr03-expired'),
    startsAt: at(NEXT_TRADING_DATE, '01:30'),
    endsAt: at(NEXT_TRADING_DATE, '02:30'),
    room: secondRoomId,
  })
})

afterAll(async () => {
  const ids = [...staff.values()]
  if (ids.length > 0) {
    // The flags go first: there is deliberately no foreign key to `appointment` (0058), so nothing
    // cascades and a row left here would be a live queue entry for an appointment that no longer exists.
    //
    // By `detected_on` and NOT only by this file's appointment ids, and that is brief rule 12 rather than
    // thoroughness. The sweep reads the WHOLE future diary, exactly as it does in production, so a pass
    // driven from here also judges every far-future appointment other suites have committed — and flags
    // the ones whose fixture therapist holds no mandatory document. Those flags are this file's to remove.
    // `detected_on` is the sweep's trading date, which no other suite uses, so it names exactly them.
    await sql`
      delete from appointment_reassignment_flag
       where detected_on = ${TRADING_DATE}::date
          or appointment_id = any(${ourAppointmentIds()}::uuid[])
    `
    await sql`delete from appointment where therapist_id = any(${ids}::uuid[])`
    await sql`delete from booking where notes = ${MARKER}`
    await sql`delete from shift_assignment where employee_id = any(${ids}::uuid[])`
    await sql`delete from shift where label = ${MARKER}`
    await sql`delete from employee_document where employee_id = any(${ids}::uuid[])`
    await sql`delete from employee_skill where employee_id = any(${ids}::uuid[])`
    await sql`delete from employee where id = any(${ids}::uuid[])`
  }
  // `business_day` is left alone: other suites own rows in this table and the three here are harmless.
  // `audit_event` and `outbox_event` are append-only (ADR 0008) and are never cleaned up.
  await sql?.end({ timeout: 5 })
})

describe('acceptance — an expired mandatory credential removes the therapist from availability', () => {
  it('offers slots on the day the labour card is still valid, for both therapists', async () => {
    // The control that everything below is about the credential. On the 17th the card has not expired —
    // `expires_on < trading_date` is false when the two are equal — so the lapsing therapist is offered
    // exactly what the clear one is.
    expect(await reasonFor('phr03-lapsing', TRADING_DATE)).toBeNull()
    const lapsing = await slotsFor('phr03-lapsing', TRADING_DATE)
    const clear = await slotsFor('phr03-clear', TRADING_DATE)
    expect(lapsing.length).toBeGreaterThan(0)
    expect(lapsing).toEqual(clear)
  })

  it('offers ZERO slots for that therapist the next trading day, and the other is unchanged', async () => {
    expect(await reasonFor('phr03-lapsing', NEXT_TRADING_DATE)).toBe('credential_expired')
    expect(await slotsFor('phr03-lapsing', NEXT_TRADING_DATE)).toEqual([])
    // "while other therapists' slots are unchanged" — the same list as the day before, from a therapist
    // rostered identically. Without this the assertion above is satisfied by a fixture that broke the
    // roster, the shift or the skill.
    const clearOnTheDay = await slotsFor('phr03-clear', NEXT_TRADING_DATE)
    expect(clearOnTheDay.length).toBeGreaterThan(0)
    expect(clearOnTheDay).toEqual(await slotsFor('phr03-clear', TRADING_DATE))
    expect(await reasonFor('phr03-clear', NEXT_TRADING_DATE)).toBeNull()
  })

  it('reinstates them the moment a renewal is on file, and withdraws it again', async () => {
    // A renewal is a NEW ROW, never an edit, so the lapsed card stays on file as the evidence of what
    // was valid last month. The read takes the LATEST expiry per type; one that took the earliest, or
    // the first the driver returned, would report a therapist as expired on a licence already replaced.
    await sql`
      insert into employee_document (employee_id, document_type, expires_on)
      values (${idOf('phr03-lapsing')}, ${LAPSING_TYPE}::employee_document_type, ${RENEWED_TO}::date)
    `
    try {
      expect(await reasonFor('phr03-lapsing', NEXT_TRADING_DATE)).toBeNull()
      expect((await slotsFor('phr03-lapsing', NEXT_TRADING_DATE)).length).toBeGreaterThan(0)
    } finally {
      await sql`
        delete from employee_document
         where employee_id = ${idOf('phr03-lapsing')}
           and document_type = ${LAPSING_TYPE}::employee_document_type
           and expires_on = ${RENEWED_TO}::date
      `
    }
    expect(await reasonFor('phr03-lapsing', NEXT_TRADING_DATE)).toBe('credential_expired')
  })
})

describe('acceptance — the sweep window comes from business_day, not from the calendar date', () => {
  it('takes the 01:30 appointment as part of the PREVIOUS trading day', async () => {
    // 00:30 on the 18th is inside the 17th's session, which closes at 02:00. So the window's floor is
    // the 17th and the 01:30 appointment — calendar date the 18th, trading date the 17th — is in it.
    const inWindow = await readReassignmentCandidates(sql, {
      fromTradingDate: TRADING_DATE,
      fromInstant: SWEEP_AT,
    })
    const ids = inWindow.map((row) => row.appointmentId)
    expect(ids).toContain(appointmentOf('after-midnight'))
    expect(ids).toContain(appointmentOf('after-midnight-expired'))
    expect(ids).toContain(appointmentOf('lapsed'))
    // And the past is out of it: an appointment that started four hours ago cannot be reassigned, and a
    // sweep that flagged it would put a treatment already under way into the work queue.
    expect(ids).not.toContain(appointmentOf('past'))

    // The known-bad half. `date(now)` is the 18th, and flooring the window with it drops the 01:30
    // appointment — the two hours of every trading day this comparison exists to cover.
    const calendarFloored = await readReassignmentCandidates(sql, {
      fromTradingDate: NEXT_TRADING_DATE,
      fromInstant: SWEEP_AT,
    })
    expect(calendarFloored.map((row) => row.appointmentId)).not.toContain(
      appointmentOf('after-midnight'),
    )
    expect(calendarFloored.map((row) => row.appointmentId)).not.toContain(
      appointmentOf('after-midnight-expired'),
    )
  })

  it('reports the trading date the instant belongs to, and that the session is still open', async () => {
    const result = await runCredentialSweep(sql, SWEEP_AT)
    expect(result.asOf).toBe(TRADING_DATE)
    // 00:30 is before the 02:00 close, so the session is open. The cron's own 04:45 is not, and the
    // trading date is the same either way — which is the property that stops the answer depending on
    // which side of 02:00 somebody ran it.
    expect(result.withinTradingHours).toBe(true)
    expect(result.considered).toBeGreaterThanOrEqual(4)
    expect(result.profileVersion).toBeGreaterThan(0)
  })
})

describe('acceptance — the sweep flags, and changes nothing else about the appointment', () => {
  it('flags only the appointment whose trading date the credential does not cover', async () => {
    const before = await statusesAndTherapists()
    await runCredentialSweep(sql, SWEEP_AT)
    const flags = await liveFlags()

    // The one the card does not cover.
    expect(flags.get('lapsed')).toEqual({
      reason: 'credential_expired',
      documentType: LAPSING_TYPE,
    })
    // And the 01:30 one whose therapist lapsed the day BEFORE the 17th. This is the flag that goes
    // missing if the window is floored with the sweep instant's calendar date instead of the trading
    // date read from `business_day` — the assertion that makes the window's source load-bearing rather
    // than merely stated.
    expect(flags.get('after-midnight-expired')).toEqual({
      reason: 'credential_expired',
      documentType: LAPSING_TYPE,
    })
    // The 01:30 appointment is IN the window and is NOT flagged, because a document valid through the
    // 17th covers the 17th's trading date — including its last two hours, which fall on the 18th. This
    // is the assertion a calendar-date comparison fails, and it is why both this and the window case
    // exist: one proves the appointment was considered, the other proves the verdict.
    expect(flags.has('after-midnight')).toBe(false)
    // Out of the window entirely.
    expect(flags.has('past')).toBe(false)
    // The therapist whose file is current.
    expect(flags.has('control')).toBe(false)

    // "appointment.status is unchanged, and zero appointments reached CANCELLED_BY_SALON or NO_SHOW as
    // a side effect." Asserted over the rows rather than over the job's return value, because the claim
    // is about the database.
    const after = await statusesAndTherapists()
    expect(after).toEqual(before)
    for (const row of after) {
      expect(row.status).toBe('confirmed')
      expect(['cancelled_by_salon', 'no_show']).not.toContain(row.status)
    }
    // And no silent unassignment: the appointment still holds the therapist who may not deliver it,
    // which is what makes it a decision for a human rather than a slot quietly handed to somebody else.
    const [lapsedRow] = await sql<{ therapist: string; holds: boolean }[]>`
      select therapist_id::text as therapist, holds_resources as holds
        from appointment where id = ${appointmentOf('lapsed')}
    `
    expect(lapsedRow?.therapist).toBe(idOf('phr03-lapsing'))
    expect(lapsedRow?.holds).toBe(true)
  })

  it('writes one audit_event and one staff notification, naming the document type', async () => {
    // Deltas over this file's own appointments. `audit_event` and `outbox_event` are append-only, so a
    // total would be a count of every suite that ran before this one (brief rule 12).
    expect(await auditCount('appointment.needs_reassignment')).toBe(2)
    expect(await eventsFor(CREDENTIAL_REASSIGNMENT_EVENT)).toEqual(
      [appointmentOf('after-midnight-expired'), appointmentOf('lapsed')].sort(),
    )

    const [event] = await sql<{ payload: Record<string, unknown> }[]>`
      select payload from outbox_event
       where event_type = ${CREDENTIAL_REASSIGNMENT_EVENT}
         and aggregate_id = ${appointmentOf('lapsed')}
    `
    // The document type is the point of the notification: "a credential lapsed" is the message the
    // recipient cannot act on, and "the labour card expired on the 17th" is a renewal.
    expect(event?.payload['documentType']).toBe(LAPSING_TYPE)
    expect(event?.payload['documentExpiresOn']).toBe(TRADING_DATE)
    expect(event?.payload['reason']).toBe('credential_expired')
    expect(event?.payload['detectedOn']).toBe(TRADING_DATE)
    expect(event?.payload['therapistId']).toBe(idOf('phr03-lapsing'))

    const [audit] = await sql<{ after_state: Record<string, unknown> }[]>`
      select after_state from audit_event
       where action = 'appointment.needs_reassignment'
         and entity_id = ${appointmentOf('lapsed')}
    `
    expect(audit?.after_state['documentType']).toBe(LAPSING_TYPE)
    expect(audit?.after_state['regulatoryProfileVersion']).toBeGreaterThan(0)
  })

  it('is idempotent: a second pass in the same business day adds nothing', async () => {
    const second = await runCredentialSweep(sql, SWEEP_AGAIN_AT)
    // Same trading date, so this is the "second run in the same business_day" the criterion names.
    expect(second.asOf).toBe(TRADING_DATE)
    expect(second.flagged).toEqual([])
    expect(second.cleared).toEqual([])
    // The same two live flags, the same two audit rows, the same two events — still.
    expect([...(await liveFlags()).keys()].sort()).toEqual(['after-midnight-expired', 'lapsed'])
    expect(await auditCount('appointment.needs_reassignment')).toBe(2)
    expect(await eventsFor(CREDENTIAL_REASSIGNMENT_EVENT)).toEqual(
      [appointmentOf('after-midnight-expired'), appointmentOf('lapsed')].sort(),
    )
    // The row count is what proves the flag was not duplicated behind a deduplicating read.
    const [row] = await sql<{ n: string }[]>`
      select count(*)::text as n from appointment_reassignment_flag
       where appointment_id = ${appointmentOf('lapsed')}::uuid
    `
    expect(Number(row?.n)).toBe(1)
  })
})

describe('acceptance — renewing the document unflags it on the next sweep, end to end', () => {
  it('clears the flag with no manual step, and says so in the audit and the outbox', async () => {
    // The flag raised by the block above is still live; this is the continuation of it rather than a
    // fresh fixture, which is what "end to end without manual intervention" means.
    expect([...(await liveFlags()).keys()].sort()).toEqual(['after-midnight-expired', 'lapsed'])

    // A renewal: a NEW employee_document row. Nothing touches the flag, the appointment or the job.
    await sql`
      insert into employee_document (employee_id, document_type, expires_on)
      values (${idOf('phr03-lapsing')}, ${LAPSING_TYPE}::employee_document_type, ${RENEWED_TO}::date)
    `
    const cleared = await runCredentialSweep(sql, SWEEP_AGAIN_AT)
    expect(cleared.cleared.map((flag) => flag.appointmentId)).toEqual([appointmentOf('lapsed')])
    expect(cleared.flagged).toEqual([])
    // Only that therapist's. The other flag is a different person's lapsed card and must be untouched —
    // a sweep that cleared the queue rather than one appointment would satisfy every assertion above.
    expect([...(await liveFlags()).keys()]).toEqual(['after-midnight-expired'])

    // Cleared, not deleted: the flag is the evidence that the check ran and what it said, and "was this
    // appointment ever at risk" is asked after somebody has already been told it was.
    const [row] = await sql<{ n: string; cleared_on: string | null }[]>`
      select count(*)::text as n, max(cleared_on)::text as cleared_on
        from appointment_reassignment_flag
       where appointment_id = ${appointmentOf('lapsed')}::uuid
    `
    expect(Number(row?.n)).toBe(1)
    expect(row?.cleared_on).toBe(TRADING_DATE)
    expect(await auditCount('appointment.reassignment_cleared')).toBe(1)
    expect(await eventsFor(CREDENTIAL_REASSIGNMENT_CLEARED_EVENT)).toEqual([
      appointmentOf('lapsed'),
    ])

    // And the control that the clearance was the renewal's doing: withdraw it and the next sweep raises
    // a NEW flag, which the partial unique index permits precisely because the first one is history.
    await sql`
      delete from employee_document
       where employee_id = ${idOf('phr03-lapsing')}
         and document_type = ${LAPSING_TYPE}::employee_document_type
         and expires_on = ${RENEWED_TO}::date
    `
    const reraised = await runCredentialSweep(sql, SWEEP_AGAIN_AT)
    expect(reraised.flagged.map((flag) => flag.appointmentId)).toEqual([appointmentOf('lapsed')])
    expect([...(await liveFlags()).keys()].sort()).toEqual(['after-midnight-expired', 'lapsed'])
    const [after] = await sql<{ n: string }[]>`
      select count(*)::text as n from appointment_reassignment_flag
       where appointment_id = ${appointmentOf('lapsed')}::uuid
    `
    expect(Number(after?.n)).toBe(2)
  })
})

describe('the pass is registered, watched and capped', () => {
  it('is in the job registry as a cron naming its agent, and the agent has a row', async () => {
    const job = JOB_REGISTRY.find((entry) => entry.name === 'hr.credential-sweep')
    expect(job, 'hr.credential-sweep is not in JOB_REGISTRY').toBeDefined()
    expect(job?.cron).toBe('45 4 * * *')
    expect(job?.agent).toBe(CREDENTIAL_SWEEP_AGENT)
    // `agentsWithHeartbeat` INNER joins definition to heartbeat, so an agent with a definition and no
    // heartbeat never appears in the watchdog's list at all — worse than unwatched, because the
    // registry-completeness check reports it present (0033).
    const [row] = await sql<{ definitions: string; heartbeats: string }[]>`
      select (select count(*)::text from agent_definition where agent_key = ${CREDENTIAL_SWEEP_AGENT})
               as definitions,
             (select count(*)::text from agent_heartbeat where agent_key = ${CREDENTIAL_SWEEP_AGENT})
               as heartbeats
    `
    expect(row?.definitions).toBe('1')
    expect(row?.heartbeats).toBe('1')
  })

  it('refuses to run against a calendar that holds no session at or before the instant', async () => {
    // Dating a flag by truncating the instant would put it a day out, and at 00:30 it would put it on
    // the wrong trading day entirely. So the pass throws rather than guessing.
    await expect(runCredentialSweep(sql, '1970-01-02T00:00:00+04:00')).rejects.toThrow(
      /business_day holds no trading session/,
    )
  })
})
