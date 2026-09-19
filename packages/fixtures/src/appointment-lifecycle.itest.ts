import {
  APPOINTMENT_STATUSES,
  type AppointmentStatus,
  appointmentLifecycleViolations,
  decideAppointmentTransition,
  eventTypeFor,
  LEGAL_APPOINTMENT_TRANSITIONS,
  permittedRolesFor,
  ROLES,
  repeatBehaviourFor,
  TERMINAL_APPOINTMENT_STATUSES,
} from '@berelax/core'
import {
  createConnection,
  type Sql,
  type TransitionActor,
  type TransitionDecider,
  type TransitionInput,
  type TransitionResult,
  transitionAppointment,
  transitionAppointmentTx,
  transitionRefusalOf,
  withUnitOfWork,
} from '@berelax/db'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

/**
 * B-LIFE-01 — the lifecycle table and the write path, against real PostgreSQL, as a pair.
 *
 * It lives in `packages/fixtures` because it needs both halves of a boundary. The table that decides what
 * is legal is `decideAppointmentTransition` in `@berelax/core`; the transaction that applies it is
 * `transitionAppointment` in `@berelax/db`; and `packages/db` may never import `packages/core`, so
 * `packages/fixtures` is the only package that may see them at once. The same arrangement
 * `booking-transaction.itest.ts` has for the slot re-check.
 *
 * Three claims here cannot be made anywhere else:
 *
 *   - **the trigger**. 0024 appends the chain from a trigger and 0046 feeds it the actor through
 *     transaction-local settings. Whether that arrives is a fact about PostgreSQL, and a mock would
 *     assert that the mock set a variable.
 *   - **exactly one of each record**. The status update, the history row, the audit row and the outbox
 *     event commit together or not at all, and "not at all" is only observable against a real transaction.
 *   - **the vocabulary agrees**. The `appointment_status` enum, the `actor_role` CHECK and core's own
 *     lists are three declarations of two vocabularies, and each is asserted against the others here.
 *
 * ## Isolation
 *
 * The integration suite runs sequentially against one database and earlier files leave rows behind. The
 * trading date `2099-11-04` is used by no other suite and no gate; the room, the service and the variant
 * are this file's own and carry {@link MARKER}; every appointment is created by this file and read back by
 * its own id; and `afterEach` removes this file's bookings, which cascade to their appointments.
 * `appointment_status_history`, `audit_event` and `outbox_event` are append-only or shared, so what is
 * asserted of them is a **delta counted in SQL** or a per-appointment key set, never a total, and nothing
 * is deleted from any of them (ADR 0008, brief rules 9 and 12).
 *
 * Nothing here drains the outbox. `drainOutbox` claims `order by occurred_at limit batchSize`, so an event
 * behind a large backlog is never reached, and a test that waited for delivery would pass alone and fail
 * in the full run. What is asserted is that the row is there, pending, with the declared type and key.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

const MARKER = 'blife01 lifecycle pair itest'
const TRADING_DATE = '2099-11-04'
const PROBE = 'blife01_probe'
const PROBE_PHONE = '+971590000651'
const PROBE_ROOM = 'blife01-room'

/** 20000 fils gross and the exact split `splitGross` produces. Written out, never re-derived here. */
const GROSS_FILS = 20_000
const NET_FILS = 19_048
const VAT_FILS = 952

/**
 * Core's decision function, as the write path's injected rule.
 *
 * `satisfies` and not a cast, and this line is the point of the whole arrangement: `TransitionDecider`
 * (db) and `decideAppointmentTransition` (core) are two declarations of one seam, because neither package
 * may import the other, and this is what makes a refusal name added to one and not the other a
 * `pnpm typecheck` failure rather than a transition refused with a name no caller can branch on.
 */
const decide = decideAppointmentTransition satisfies TransitionDecider
const DEPS = { decide }

/** The actor every case acts as unless it is testing a role. An id, so the row can be joined back. */
const ACTOR_ID = '00000000-0000-4000-8000-00000000b101'
const OWNER: TransitionActor = {
  kind: 'staff',
  role: 'owner',
  id: ACTOR_ID,
  label: 'B-LIFE-01 pair itest',
}
const REASON = 'stated by the actor at the time of the move'

let sql: Sql
/** The second pool every concurrency assertion needs: a lock one transaction holds is invisible inside it. */
let probe: Sql
let customerId: string
let variantId: string
let roomId: string
let bookingId: string
/**
 * Each appointment in a case gets its own 45 minutes, so no case depends on another's resources being
 * free: the room holds one client (0012) and the therapist cannot be in two places (0024's exclusion
 * constraint). The counter resets in `afterEach`, because that is where this file's appointments go.
 */
let slot = 0

const dubai = (date: string, hhmm: string): string => `${date} ${hhmm}:00+04`

/** A distinct 45 minutes inside the trading day, as a `[)` tstzrange literal. */
function nextPeriod(): string {
  const startMinutes = 11 * 60 + slot * 45
  slot += 1
  const fmt = (minutes: number): string => {
    const dayOffset = Math.floor(minutes / (24 * 60))
    const hh = String(Math.floor((minutes % (24 * 60)) / 60)).padStart(2, '0')
    const mm = String(minutes % 60).padStart(2, '0')
    // Trading runs 11:00-02:00, so the late slots belong to the NEXT calendar day and the SAME trading
    // date - which is the whole reason `trading_date` is a stored column (0011) rather than a truncation.
    const date = dayOffset === 0 ? TRADING_DATE : '2099-11-05'
    return dubai(date, `${hh}:${mm}`)
  }
  return `[${fmt(startMinutes)},${fmt(startMinutes + 45)})`
}

/** One appointment, inserted directly at `status`, with its own period. Returns its id. */
async function appointmentAt(status: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into appointment (
      booking_id, trading_date, service_variant_id, shape, therapist_id, room_id, period, status,
      delivery_id, room_places, turnaround_minutes, therapist_buffer_minutes,
      gross_price_fils, net_fils, vat_fils, vat_rate_bp
    ) values (
      ${bookingId}, ${TRADING_DATE}::date, ${variantId}, 'solo'::service_shape,
      ${'00000000-0000-4000-8000-00000000c101'}::uuid, ${roomId},
      ${nextPeriod()}::tstzrange, ${status}::appointment_status,
      gen_random_uuid(), 1, 20, 10, ${GROSS_FILS}, ${NET_FILS}, ${VAT_FILS}, 500
    )
    returning id::text as id
  `
  return (row as { id: string }).id
}

interface HistoryRow {
  readonly id: string
  readonly from_status: string | null
  readonly to_status: string
  readonly occurred_at: Date
  readonly actor_kind: string | null
  readonly actor_id: string | null
  readonly actor_label: string | null
  readonly actor_role: string | null
  readonly reason: string | null
}

/**
 * Every history row for one appointment, oldest first. A per-appointment key set, not a table total.
 *
 * `order by appointment_status_history.id`, qualified, and that is not a flourish: `ORDER BY` resolves an
 * **output column name** before a table column, so `order by id` beside `id::text as id` sorts the ids as
 * TEXT — '10' before '9'. It cost a run here, and the same shape is one character away in any query that
 * casts a bigint key for the driver.
 */
async function historyOf(appointmentId: string): Promise<readonly HistoryRow[]> {
  return await sql<HistoryRow[]>`
    select id::text as id, from_status::text as from_status, to_status::text as to_status,
           occurred_at, actor_kind, actor_id::text as actor_id, actor_label, actor_role, reason
      from appointment_status_history
     where appointment_id = ${appointmentId}
     order by appointment_status_history.id
  `
}

interface EventRow {
  readonly id: string
  readonly event_type: string
  readonly idempotency_key: string
  readonly published_at: string | null
  readonly payload: Record<string, unknown>
}

/** Every outbox row for one appointment. Narrowed by aggregate id, so other suites' rows are invisible. */
async function eventsOf(appointmentId: string): Promise<readonly EventRow[]> {
  return await sql<EventRow[]>`
    select id::text as id, event_type, idempotency_key, published_at, payload
      from outbox_event
     where aggregate_type = 'appointment' and aggregate_id = ${appointmentId}
     order by occurred_at, id
  `
}

/** The audit rows for one appointment, counted IN SQL — `audit_event` is append-only (ADR 0008). */
async function auditCount(appointmentId: string): Promise<number> {
  const [row] = await sql<{ n: string }[]>`
    select count(*)::text as n from audit_event
     where entity_type = 'appointment' and entity_id = ${appointmentId}
  `
  return Number(row?.n ?? 0)
}

const statusOf = async (appointmentId: string): Promise<string> => {
  const [row] = await sql<{ status: string }[]>`
    select status::text as status from appointment where id = ${appointmentId}
  `
  return (row as { status: string }).status
}

const move = (
  appointmentId: string,
  to: string,
  overrides: Partial<TransitionInput> = {},
): Promise<TransitionResult> =>
  transitionAppointmentTx(
    sql,
    { appointmentId, to, actor: OWNER, reason: REASON, ...overrides },
    DEPS,
  )

/** The refusal a rejected move carries, or `null` when it resolved. */
async function refusalOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise
    return null
  } catch (error) {
    return transitionRefusalOf(error)
  }
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
  sql = createConnection({ url, max: 6 })
  probe = createConnection({ url, max: 2 })

  const [customer] = await sql<{ id: string }[]>`
    insert into customer (phone_e164, created_via) values (${PROBE_PHONE}, 'guest_booking')
    on conflict (phone_e164) do update set created_via = excluded.created_via
    returning id
  `
  customerId = (customer as { id: string }).id

  // The trading calendar is a TABLE (0011) and `appointment.trading_date` is a foreign key into it, so a
  // fixture cannot invent a date the premises does not trade on. 07:00Z-22:00Z is 11:00-02:00 in
  // Asia/Dubai, the window the whole system is built around.
  await sql`
    insert into business_day (trading_date, opens_at, closes_at, source)
    values (${TRADING_DATE}, ${dubai(TRADING_DATE, '11')}::timestamptz,
            ${dubai('2099-11-05', '02')}::timestamptz, 'weekly')
    on conflict (trading_date) do nothing
  `

  const [room] = await sql<{ id: string }[]>`
    insert into rooms (code, name, room_type, capacity, display_order, notes)
    values (${PROBE_ROOM}, 'Probe lifecycle room', 'standard'::room_type, 1, 97, ${MARKER})
    on conflict (code) do update set capacity = excluded.capacity
    returning id
  `
  roomId = (room as { id: string }).id

  const [service] = await sql<{ id: string }[]>`
    insert into service
      (style, treatment_key, slug, internal_name, public_display_name, turnaround_minutes,
       display_order)
    values ('asian', ${PROBE}, 'blife01-probe', 'Probe massage', 'Normal Massage (Asian)', 20, 99)
    on conflict (style, treatment_key) do update set turnaround_minutes = excluded.turnaround_minutes
    returning id
  `
  const [variant] = await sql<{ id: string }[]>`
    insert into service_variant (service_id, duration_minutes, gross_price_fils, provisional_note)
    values (${(service as { id: string }).id}, 45, ${GROSS_FILS}, ${MARKER})
    on conflict (service_id, duration_minutes) do update set gross_price_fils = excluded.gross_price_fils
    returning id
  `
  variantId = (variant as { id: string }).id

  const [booking] = await sql<{ id: string }[]>`
    insert into booking (customer_id, source, notes)
    values (${customerId}, 'front_desk', ${MARKER})
    returning id::text as id
  `
  bookingId = (booking as { id: string }).id
})

afterEach(async () => {
  // The appointments go; the chain, the audit rows and the outbox rows stay, because all three are
  // append-only or shared and every assertion above is a delta or a per-appointment key set.
  await sql`delete from appointment where booking_id = ${bookingId}`
  slot = 0
})

afterAll(async () => {
  await sql`delete from booking where notes = ${MARKER}`
  await sql`delete from service where treatment_key = ${PROBE}`
  await sql`delete from rooms where notes = ${MARKER}`
  await sql`delete from business_day where trading_date = ${TRADING_DATE}`
  await sql`delete from customer where phone_e164 = ${PROBE_PHONE}`
  await probe?.end({ timeout: 5 })
  await sql?.end({ timeout: 5 })
})

describe('acceptance — the vocabulary in the database and the vocabulary in the table agree', () => {
  it('has the nine labels core declares, in the same order, and no shared cancelled label', async () => {
    const labels = await sql<{ label: string }[]>`
      select e.enumlabel as label
        from pg_enum e join pg_type t on t.oid = e.enumtypid
       where t.typname = 'appointment_status'
       order by e.enumsortorder
    `
    expect(labels.map((row) => row.label)).toEqual([...APPOINTMENT_STATUSES])
    // The distinction the two cancellations exist for cannot be collapsed into a label that does not
    // exist: there is no `cancelled` in the enum to collapse them into.
    expect(labels.map((row) => row.label)).not.toContain('cancelled')
  })

  it('accepts exactly the F07 roles in actor_role, in both directions', async () => {
    // 0046 restates the role list as a CHECK because the database cannot import the policy layer. The
    // duplication is made safe HERE: the accepted set is read out of the constraint's own definition and
    // compared with `ROLES`, so a role added to one and not the other fails this file.
    expect(
      await checkVocabulary(
        'appointment_status_history',
        'appointment_status_history_actor_role_known',
      ),
    ).toEqual([...ROLES].sort())
    const accepted = await checkVocabulary(
      'appointment_status_history',
      'appointment_status_history_actor_role_known',
    )
    const stored = await sql<{ ok: boolean }[]>`
      select ${accepted.length} = (select count(distinct r) from unnest(${accepted}::text[]) as r)::int
        as ok
    `
    expect(stored[0]?.ok).toBe(true)
  })

  it('uses the same actor_kind vocabulary as audit_event, rather than a second one', async () => {
    // Compared constraint to constraint rather than to a list written here: two tables agreeing with a
    // literal in a test file is two tables agreeing with a test file.
    const history = await checkVocabulary(
      'appointment_status_history',
      'appointment_status_history_actor_kind_known',
    )
    const audit = await checkVocabulary('audit_event', 'audit_event_actor_kind_check')
    expect(history).toEqual(audit)
    expect(history).toEqual(['agent', 'customer', 'staff', 'system'])
  })

  it('finds the shipped table self-consistent, over the same data the write path uses', () => {
    expect(appointmentLifecycleViolations()).toEqual([])
  })
})

describe('acceptance — every transition appends one history row and emits one event', () => {
  /** Every legal pair, from the table itself: the test iterates the declaration, not a copy of it. */
  const legalPairs = APPOINTMENT_STATUSES.flatMap((from) =>
    LEGAL_APPOINTMENT_TRANSITIONS[from].map((target) => ({ from, to: target.to })),
  )

  it('covers all fifteen declared transitions', () => {
    expect(legalPairs).toHaveLength(15)
  })

  for (const { from, to } of legalPairs) {
    it(`${from} -> ${to} writes exactly one history row, one audit row and one event`, async () => {
      const appointmentId = await appointmentAt(from)
      const auditBefore = await auditCount(appointmentId)
      const before = await historyOf(appointmentId)
      // The creation row: `from_status` NULL, and unattributed because a creation is not a transition
      // and B-AVAIL-06's writer has no F07 role to state.
      expect(before).toHaveLength(1)
      expect(before[0]?.from_status).toBeNull()
      expect(before[0]?.actor_role).toBeNull()

      const startedAt = new Date()
      const result = await move(appointmentId, to)
      expect(result.kind).toBe('transitioned')
      if (result.kind !== 'transitioned') return
      expect(await statusOf(appointmentId)).toBe(to)

      const after = await historyOf(appointmentId)
      // EXACTLY one appended. A delta over this appointment's own rows, which is why the appointment is
      // created by this case rather than shared with another.
      expect(after).toHaveLength(before.length + 1)
      const appended = after[after.length - 1] as HistoryRow
      expect(appended.id).toBe(result.history.id)
      expect(appended.from_status).toBe(from)
      expect(appended.to_status).toBe(to)
      // Actor, role, reason and timestamptz - the four the acceptance asks for, read back from the row
      // the TRIGGER wrote rather than from the object the caller passed.
      expect(appended.actor_kind).toBe('staff')
      expect(appended.actor_id).toBe(ACTOR_ID)
      expect(appended.actor_label).toBe(OWNER.label)
      expect(appended.actor_role).toBe('owner')
      expect(appended.reason).toBe(REASON)
      expect(appended.occurred_at).toBeInstanceOf(Date)
      expect(appended.occurred_at.getTime()).toBeGreaterThanOrEqual(startedAt.getTime() - 1000)

      // Exactly one event, of the type the table declares, keyed on the business fact, and pending.
      const events = await eventsOf(appointmentId)
      expect(events).toHaveLength(1)
      expect(events[0]?.event_type).toBe(eventTypeFor(to))
      expect(events[0]?.event_type).toBe(result.eventType)
      expect(events[0]?.idempotency_key).toBe(`${eventTypeFor(to)}:${appointmentId}`)
      expect(events[0]?.published_at).toBeNull()
      expect(events[0]?.payload).toMatchObject({
        appointmentId,
        bookingId,
        fromStatus: from,
        toStatus: to,
        actorRole: 'owner',
        reason: REASON,
      })

      // And exactly one audit row, counted in SQL.
      expect(await auditCount(appointmentId)).toBe(auditBefore + 1)
    })
  }

  it('carries the money on the completion and on nothing else', async () => {
    const completing = await appointmentAt('in_progress')
    await move(completing, 'completed')
    const [completion] = await eventsOf(completing)
    expect(completion?.event_type).toBe('appointment.completed')
    // The till knows the truth: the revenue event carries the figures the appointment snapshotted, as
    // strings, because `fils` is int8 and a double does not hold it (ADR 0007).
    expect(completion?.payload['money']).toEqual({
      grossFils: String(GROSS_FILS),
      netFils: String(NET_FILS),
      vatFils: String(VAT_FILS),
      vatRateBp: 500,
    })

    const confirming = await appointmentAt('requested')
    await move(confirming, 'confirmed')
    const [confirmation] = await eventsOf(confirming)
    expect(confirmation?.event_type).toBe('appointment.confirmed')
    // A confirmed booking is a guess about money. Not a zero, not an empty object: absent.
    expect(confirmation?.payload).not.toHaveProperty('money')
    expect(/revenue|sale|invoice/.test(confirmation?.event_type as string)).toBe(false)
  })

  it('emits no event whose name reads as money for any transition but the completion', async () => {
    // The allowlist, asserted against the events actually stored rather than against the table.
    const stored = await sql<{ event_type: string }[]>`
      select distinct event_type from outbox_event
       where aggregate_type = 'appointment' and event_type like 'appointment.%'
    `
    for (const row of stored) {
      if (row.event_type === 'appointment.completed') continue
      expect(/revenue|sale|invoice/.test(row.event_type), row.event_type).toBe(false)
    }
  })
})

describe('acceptance — a refused transition writes nothing', () => {
  /** Asserts the three records and the status are all untouched by a refusal. */
  async function expectNothingWritten(
    appointmentId: string,
    expected: { readonly status: string; readonly history: number; readonly audit: number },
  ): Promise<void> {
    expect(await statusOf(appointmentId)).toBe(expected.status)
    expect(await historyOf(appointmentId)).toHaveLength(expected.history)
    expect(await auditCount(appointmentId)).toBe(expected.audit)
    expect(await eventsOf(appointmentId)).toHaveLength(0)
  }

  it('refuses an illegal pair by name and leaves the row where it was', async () => {
    const appointmentId = await appointmentAt('confirmed')
    const audit = await auditCount(appointmentId)
    expect(await refusalOf(move(appointmentId, 'completed'))).toBe('illegal_transition')
    await expectNothingWritten(appointmentId, { status: 'confirmed', history: 1, audit })
  })

  it('refuses a receptionist the transitions the policy layer reserves', async () => {
    const appointmentId = await appointmentAt('confirmed')
    const audit = await auditCount(appointmentId)
    expect(
      await refusalOf(
        move(appointmentId, 'cancelled_by_salon', {
          actor: { kind: 'staff', role: 'receptionist', id: ACTOR_ID },
        }),
      ),
    ).toBe('transition_forbidden')
    await expectNothingWritten(appointmentId, { status: 'confirmed', history: 1, audit })
    // The control: the same move by a manager is taken, so the refusal was about the role.
    const taken = await move(appointmentId, 'cancelled_by_salon', {
      actor: { kind: 'staff', role: 'manager', id: ACTOR_ID },
    })
    expect(taken.kind).toBe('transitioned')
  })

  it('refuses a salon cancellation with no reason, and takes it with one', async () => {
    const appointmentId = await appointmentAt('confirmed')
    expect(
      await refusalOf(
        transitionAppointmentTx(
          sql,
          { appointmentId, to: 'cancelled_by_salon', actor: OWNER },
          DEPS,
        ),
      ),
    ).toBe('reason_required')
    expect(await statusOf(appointmentId)).toBe('confirmed')
    const taken = await move(appointmentId, 'cancelled_by_salon')
    expect(taken.kind).toBe('transitioned')
  })

  it('refuses a status label this build does not declare, rather than writing it', async () => {
    const appointmentId = await appointmentAt('confirmed')
    // Deny by default at the seam: the label never reaches the enum cast, so the refusal is named
    // rather than a raw 22P02 from the driver.
    expect(await refusalOf(move(appointmentId, 'paused'))).toBe('illegal_transition')
    expect(await statusOf(appointmentId)).toBe('confirmed')
  })

  it('refuses an appointment that does not exist', async () => {
    expect(await refusalOf(move('00000000-0000-4000-8000-0000000000ff', 'confirmed'))).toBe(
      'appointment_not_found',
    )
  })

  it('refuses a half-written attribution at the database, whoever writes it', async () => {
    // The integration-level control for 0046's `attribution_is_whole`: a role with no kind of actor
    // cannot answer the question the columns exist for, and the database says so rather than storing it.
    const appointmentId = await appointmentAt('confirmed')
    const failed = await sql
      .begin(async (tx) => {
        await tx`select set_config('berelax.transition_actor_role', 'owner', true)`
        await tx`update appointment set status = 'checked_in' where id = ${appointmentId}`
      })
      .then(
        () => null,
        (error: unknown) =>
          (error as { constraint_name?: string }).constraint_name ?? String(error),
      )
    expect(failed).toBe('appointment_status_history_attribution_is_whole')
  })
})

describe('acceptance — each terminal state behaves as its declaration says on a repeat', () => {
  for (const status of TERMINAL_APPOINTMENT_STATUSES) {
    const declared = repeatBehaviourFor(status)
    it(`${status} declares ${declared} and behaves that way against the database`, async () => {
      // Reached through the machine rather than inserted at the terminal state, so the repeat is a repeat
      // of a transition that really happened and the chain under it is real.
      const from = APPOINTMENT_STATUSES.find((candidate) =>
        LEGAL_APPOINTMENT_TRANSITIONS[candidate].some((target) => target.to === status),
      ) as AppointmentStatus
      const appointmentId = await appointmentAt(from)
      const role = permittedRolesFor(status)[0] as string
      const actor: TransitionActor = { kind: 'staff', role, id: ACTOR_ID }
      await move(appointmentId, status, { actor })
      const history = await historyOf(appointmentId)
      const audit = await auditCount(appointmentId)
      const events = await eventsOf(appointmentId)
      expect(events).toHaveLength(1)

      const repeat = transitionAppointmentTx(
        sql,
        { appointmentId, to: status, actor, reason: REASON },
        DEPS,
      )
      if (declared === 'idempotent') {
        const result = await repeat
        expect(result.kind).toBe('no_op')
      } else {
        expect(await refusalOf(repeat)).toBe('already_in_status')
      }
      // Either way NOTHING was written a second time: not a history row (0024's `_is_a_change` refuses a
      // row from a state to itself), not an audit row, and not a second event.
      expect(await historyOf(appointmentId)).toHaveLength(history.length)
      expect(await auditCount(appointmentId)).toBe(audit)
      expect(await eventsOf(appointmentId)).toHaveLength(1)
      expect(await statusOf(appointmentId)).toBe(status)
    })
  }
})

describe('acceptance — two actors moving one appointment at once', () => {
  it('lets exactly one completion through, and the second reads the state it now holds', async () => {
    const appointmentId = await appointmentAt('in_progress')

    // The first transaction is held OPEN after its transition, which is what makes this a race rather
    // than two calls that happened to be issued together. Without the delay the second request's read
    // lands after the first has committed however the lock is written, and the case passes with the lock
    // removed — which is exactly what it did before this hold was added (gate 51j watches for it).
    let release = (): void => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = withUnitOfWork(sql, { kind: 'staff', id: ACTOR_ID }, async (uow) => {
      const result = await transitionAppointment(
        uow,
        { appointmentId, to: 'completed', actor: OWNER, reason: REASON },
        DEPS,
      )
      await held
      return result
    })

    // Long enough for the first transaction to have taken its row lock, and on a SECOND pool so the
    // second request cannot be waiting for a connection instead of for the row.
    await new Promise((resolve) => setTimeout(resolve, 250))
    // `select … for update` is what makes this orderly rather than simultaneous: this request blocks on
    // the appointment row, and when it is released reads `completed` under READ COMMITTED — so it asks
    // completed -> completed and is answered by the repeat declaration, which for the one state where a
    // silent yes would hide a second invoice is an error.
    const second = transitionAppointmentTx(
      probe,
      { appointmentId, to: 'completed', actor: OWNER, reason: REASON },
      DEPS,
    )
    setTimeout(release, 250)

    const [won, lost] = await Promise.allSettled([first, second])
    expect(won.status).toBe('fulfilled')
    expect(won.status === 'fulfilled' ? won.value.kind : 'rejected').toBe('transitioned')
    expect(lost.status).toBe('rejected')
    expect(transitionRefusalOf((lost as PromiseRejectedResult).reason)).toBe('already_in_status')

    // One transition, one history row, one audit row, one revenue event. The whole point of the lock.
    expect(await historyOf(appointmentId)).toHaveLength(2)
    expect(await eventsOf(appointmentId)).toHaveLength(1)
    expect(await auditCount(appointmentId)).toBe(1)
    expect(await statusOf(appointmentId)).toBe('completed')
  })
})
