import { recheckShapeAssignment, solveAvailabilityQuery } from '@berelax/core'
import {
  type Actor,
  type AvailabilityRequest,
  type AvailabilitySolve,
  type BookingDeliveryInput,
  bookingRefusalOf,
  bookSlot,
  type CreateBookingInput,
  drainOutbox,
  type HandlerRegistration,
  publishEvent,
  queryAvailability,
  readMandatoryDocumentTypes,
  type SlotRecheck,
  type Sql,
} from '@berelax/db'

/**
 * The soak's three runs, against a probe salon this module builds and removes.
 *
 * H-HARD-11. Here rather than in `scripts/soak.mjs` because `packages/fixtures` is the package that may
 * depend on both `core` and `db` (brief rule 4), and because a run that lives in a script is a run no
 * test can call. The judgements over what it measures are `packages/core/src/ops/soak.ts`.
 *
 * ## Why a probe salon and not the seeded one
 *
 * `availability-perf.itest.ts` gives the reason and this follows it: CI applies the migrations and
 * seeds, but the soak has to be runnable against any database, and a race against the SEEDED rooms
 * would leave this unit's bookings in the catalogue every other suite reads. The probe salon mirrors
 * what B-CAT-06 seeds — five rooms, three standard at capacity 1, one couples at 2, one wet — and eight
 * rostered therapists, which is `salon.ts`'s roster. It is the same shape and the same volume; it is not
 * the same rows, and the report says so rather than claiming a seed that may not have run.
 *
 * ## Isolation
 *
 * The trading date 2097-04-18 is used by no other suite and no gate. Every row this module writes
 * carries {@link SOAK_MARKER} and is removed by {@link teardownSoakSalon}; nothing is deleted from
 * `audit_event` or any other append-only table, and nothing is deleted that this module did not create.
 */
export const SOAK_MARKER = 'hhard11 soak'
export const SOAK_TRADING_DATE = '2097-04-18'

const PROBE = 'hhard11_soak'
const GROSS_FILS = 20_000
const NET_FILS = 19_048
const VAT_FILS = 952
const CALLER: Actor = { kind: 'staff', label: 'H-HARD-11 soak' }
const DEPS = { recheck: recheckShapeAssignment satisfies SlotRecheck }
const solve = solveAvailabilityQuery satisfies AvailabilitySolve

/** The one capacity-1 room every attempt contends for. */
const LAST_ROOM = 'hhard11-last'
/** The rest of the salon, so the availability query has a real search space to solve over. */
const OTHER_ROOMS = [
  ['hhard11-std-2', 'standard', 1],
  ['hhard11-std-3', 'standard', 1],
  ['hhard11-couples', 'couples', 2],
  ['hhard11-wet', 'wet', 1],
] as const

const THERAPISTS = 8
const CUSTOMERS = 8
/** Events enqueued per transaction. See {@link runOutboxBacklog}. */
const ENQUEUE_BATCH = 250

export interface SoakSalon {
  readonly variantId: string
  readonly lastRoomId: string
  readonly therapistIds: readonly string[]
  readonly customerIds: readonly string[]
  readonly shiftId: string
}

const dubai = (hhmm: string) => `${SOAK_TRADING_DATE} ${hhmm}:00+04`
const nextDay = (date: string) => {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() + 1)
  return value.toISOString().slice(0, 10)
}
const at = (hhmm: string) => Date.parse(`${SOAK_TRADING_DATE}T${hhmm}:00+04:00`)

/** Builds the probe salon. Idempotent per row, so an interrupted soak can be re-run. */
export async function buildSoakSalon(sql: Sql): Promise<SoakSalon> {
  const customerIds: string[] = []
  for (let index = 0; index < CUSTOMERS; index += 1) {
    const [customer] = await sql<{ id: string }[]>`
      insert into customer (phone_e164, created_via)
      values (${`+9715911000${String(index).padStart(2, '0')}`}, 'guest_booking')
      on conflict (phone_e164) do update set created_via = excluded.created_via
      returning id
    `
    customerIds.push((customer as { id: string }).id)
  }

  await sql`
    insert into business_day (trading_date, opens_at, closes_at, source)
    values (${SOAK_TRADING_DATE}, ${dubai('11')}::timestamptz,
            ${`${nextDay(SOAK_TRADING_DATE)} 02:00:00+04`}::timestamptz, 'weekly')
    on conflict (trading_date) do nothing
  `

  const roomId = async (code: string, type: string, capacity: number) => {
    const [room] = await sql<{ id: string }[]>`
      insert into rooms (code, name, room_type, capacity, display_order, notes)
      values (${code}, ${`Soak ${code}`}, ${type}::room_type, ${capacity}, 96, ${SOAK_MARKER})
      on conflict (code) do update set capacity = excluded.capacity, notes = excluded.notes
      returning id
    `
    return (room as { id: string }).id
  }
  const lastRoomId = await roomId(LAST_ROOM, 'standard', 1)
  for (const [code, type, capacity] of OTHER_ROOMS) await roomId(code, type, capacity)

  const [service] = await sql<{ id: string }[]>`
    insert into service
      (style, treatment_key, slug, internal_name, public_display_name, turnaround_minutes,
       display_order)
    values ('asian', ${PROBE}, ${'hhard11-soak'}, ${'Soak probe'}, ${'Normal Massage (Asian)'}, 20, 96)
    on conflict (style, treatment_key) do update set turnaround_minutes = 20
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
    values ('asian', ${PROBE}, 'solo', 1, 1, 1, 'standard', 10)
    on conflict do nothing
  `
  const [variant] = await sql<{ id: string }[]>`
    insert into service_variant (service_id, duration_minutes, gross_price_fils, provisional_note)
    values (${serviceId}, 60, ${GROSS_FILS}, ${SOAK_MARKER})
    on conflict (service_id, duration_minutes) do update set gross_price_fils = excluded.gross_price_fils
    returning id
  `

  const [shift] = await sql<{ id: string }[]>`
    insert into shift (trading_date, period, label)
    values (${SOAK_TRADING_DATE},
            ${`[${dubai('11')},${nextDay(SOAK_TRADING_DATE)} 02:00:00+04)`}::tstzrange, ${SOAK_MARKER})
    returning id
  `
  const shiftId = (shift as { id: string }).id
  const therapistIds: string[] = []
  const mandatory = await readMandatoryDocumentTypes(sql)
  for (let index = 1; index <= THERAPISTS; index += 1) {
    const [employee] = await sql<{ id: string }[]>`
      insert into employee (staff_reference, gender, employed_from, notes)
      values (${`hhard11-${index}`}, 'female', '2097-01-01', ${SOAK_MARKER})
      on conflict (staff_reference) do update set gender = 'female', notes = excluded.notes
      returning id
    `
    const id = (employee as { id: string }).id
    therapistIds.push(id)
    await sql`
      insert into employee_skill (employee_id, skill) values (${id}, 'asian_style')
      on conflict do nothing
    `
    // The mandatory credential set IN FORCE rather than a hard-coded pair, for 0054's reason: a fixture
    // naming two of them stops meaning "holds every mandatory document" the moment that answer changes.
    for (const type of mandatory) {
      await sql`
        insert into employee_document (employee_id, document_type, expires_on)
        values (${id}, ${type}::employee_document_type, '2097-12-31')
        on conflict do nothing
      `
    }
    await sql`
      insert into shift_assignment (shift_id, employee_id) values (${shiftId}, ${id})
      on conflict do nothing
    `
  }

  return {
    variantId: (variant as { id: string }).id,
    lastRoomId,
    therapistIds,
    customerIds,
    shiftId,
  }
}

export async function teardownSoakSalon(sql: Sql, salon: SoakSalon): Promise<void> {
  await sql`delete from booking where notes = ${SOAK_MARKER}`
  await sql`delete from outbox_delivery where event_id in (
    select id from outbox_event where idempotency_key like ${`${PROBE}:%`}
  )`
  await sql`delete from outbox_event where idempotency_key like ${`${PROBE}:%`}`
  await sql`delete from shift_assignment where employee_id = any(${[...salon.therapistIds]}::uuid[])`
  await sql`delete from shift where label = ${SOAK_MARKER}`
  await sql`delete from employee_document where employee_id = any(${[...salon.therapistIds]}::uuid[])`
  await sql`delete from employee_skill where employee_id = any(${[...salon.therapistIds]}::uuid[])`
  await sql`delete from employee where notes = ${SOAK_MARKER}`
  await sql`delete from service where treatment_key = ${PROBE}`
  await sql`delete from rooms where notes = ${SOAK_MARKER}`
  await sql`delete from business_day where trading_date = ${SOAK_TRADING_DATE}`
  await sql`delete from customer where id = any(${[...salon.customerIds]}::uuid[])`
}

const delivery = (salon: SoakSalon, therapist: string): BookingDeliveryInput => ({
  tradingDate: SOAK_TRADING_DATE,
  serviceVariantId: salon.variantId,
  shape: 'solo',
  roomId: salon.lastRoomId,
  therapistIds: [therapist],
  treatment: { startsAt: at('19:00'), endsAt: at('20:00') },
  price: {
    grossFils: GROSS_FILS,
    netFils: NET_FILS,
    vatFils: VAT_FILS,
    vatRateBp: 500,
    priceListId: null,
    promotionId: null,
  },
  status: 'confirmed',
})

const request = (
  salon: SoakSalon,
  key: string,
  customerId: string,
  therapist: string,
): CreateBookingInput => ({
  idempotencyKey: key,
  customerId,
  source: 'online',
  notes: SOAK_MARKER,
  clientGender: 'female',
  deliveries: [delivery(salon, therapist)],
})

export interface ContentionRun {
  readonly attempts: number
  readonly successes: number
  readonly refusalsByName: Readonly<Record<string, number>>
  readonly untypedFailures: number
  readonly rawSqlstateFailures: readonly string[]
  readonly overCapacityRooms: number
  readonly elapsedMs: number
}

/**
 * Every attempt in flight at once for ONE place, and the outcome of each one counted by name.
 *
 * A different therapist and a different customer per attempt, round-robin over eight of each, so the
 * decision is the room lock and never the therapist exclusion constraint or a per-customer rule — the
 * same reason `booking-concurrency.itest.ts` uses different therapists for its pair. Only one booking
 * can commit, so the other 199 see every therapist free and are refused by the capacity recheck inside
 * the lock.
 */
export async function runLastSlotContention(
  sql: Sql,
  salon: SoakSalon,
  attempts: number,
): Promise<ContentionRun> {
  const started = Date.now()
  const settled = await Promise.allSettled(
    Array.from({ length: attempts }, (_, index) =>
      bookSlot(
        sql,
        CALLER,
        request(
          salon,
          `hhard11-soak-${index}`,
          salon.customerIds[index % salon.customerIds.length] as string,
          salon.therapistIds[index % salon.therapistIds.length] as string,
        ),
        DEPS,
      ),
    ),
  )
  const elapsedMs = Date.now() - started

  const refusalsByName: Record<string, number> = {}
  const rawSqlstateFailures: string[] = []
  let untypedFailures = 0
  let successes = 0
  for (const result of settled) {
    if (result.status === 'fulfilled') {
      successes += 1
      continue
    }
    const named = bookingRefusalOf(result.reason)
    const code = (result.reason as { code?: string }).code
    if (named === null) untypedFailures += 1
    else refusalsByName[named] = (refusalsByName[named] ?? 0) + 1
    // A 23xxx reaching a caller is an unhandled constraint violation; 40P01 is a deadlock. Either one
    // is the 5xx the acceptance line counts, whether or not a refusal name was also attached.
    if (code !== undefined && /^(?:23|40)/.test(code)) rawSqlstateFailures.push(code)
  }

  const over = await sql<{ code: string }[]>`
    select r.code
      from rooms r cross join lateral room_peak_concurrency(r.id, null::tstzrange) p
     where r.notes = ${SOAK_MARKER} and p.concurrent > r.capacity
  `
  await sql`delete from booking where notes = ${SOAK_MARKER}`

  return {
    attempts,
    successes,
    refusalsByName,
    untypedFailures,
    rawSqlstateFailures,
    overCapacityRooms: over.length,
    elapsedMs,
  }
}

export interface AvailabilityRun {
  readonly concurrency: number
  readonly batches: number
  readonly samples: readonly number[]
}

/**
 * The availability query under load, with the cache OFF.
 *
 * `availability-perf.itest.ts`'s first decision, for its stated reason: a p95 measured through a
 * 30-second memo is a measurement of a `Map`, and it would pass at any database speed. The samples are
 * returned whole so the percentile can be recomputed from the report rather than trusted.
 */
export async function runAvailabilityLoad(
  sql: Sql,
  salon: SoakSalon,
  concurrency: number,
  batches: number,
): Promise<AvailabilityRun> {
  const payload: AvailabilityRequest = {
    tradingDate: SOAK_TRADING_DATE,
    serviceVariantId: salon.variantId,
    minLeadMinutes: 120,
    maxAdvanceDays: 90,
    clientGender: 'female',
  }
  // Three days before the trading date, so the two-hour lead and the ninety-day advance both hold.
  const now = Date.parse('2097-04-15T12:00:00+04:00')
  // One warm-up query outside the measurement: the first call pays for the plan cache and the
  // connection, and including it would put a one-off cost in the percentile.
  await queryAvailability(sql, payload, { solve, now })

  const samples: number[] = []
  for (let batch = 0; batch < batches; batch += 1) {
    const timings = await Promise.all(
      Array.from({ length: concurrency }, async () => {
        const started = performance.now()
        await queryAvailability(sql, payload, { solve, now })
        return performance.now() - started
      }),
    )
    samples.push(...timings.map((value) => Math.round(value)))
  }
  return { concurrency, batches, samples }
}

export interface BacklogRun {
  readonly events: number
  readonly handlers: number
  readonly drainers: number
  readonly batchSize: number
  readonly deliveries: number
  readonly distinctPairs: number
  readonly unpublishedAfter: number
  readonly drainMs: number
  readonly handlerCalls: Readonly<Record<string, number>>
  /** Calls for events this run did not publish. A measurement; see {@link runOutboxBacklog}. */
  readonly foreignHandlerCalls: Readonly<Record<string, number>>
}

/**
 * A large backlog, drained by several workers at once, with the deliveries counted from the table.
 *
 * Several drainers on purpose. `drainOutbox` claims with `for update skip locked`, which is what makes
 * horizontal scaling safe without a broker — and "exactly one delivery per (event, handler)" is only an
 * interesting claim when more than one worker is trying. With one drainer the claim is trivially true.
 *
 * The handlers COUNT their calls as well, and the two numbers are reported separately: the delivery rows
 * are what the database holds, and the call count is what actually happened. They can disagree in one
 * direction — a handler called twice where the second call was skipped as already delivered — and that
 * is a fact worth seeing rather than hiding behind the row count.
 */
export async function runOutboxBacklog(
  sql: Sql,
  options: {
    readonly events: number
    readonly drainers: number
    readonly batchSize: number
  },
): Promise<BacklogRun> {
  const calls: Record<string, number> = { 'soak-handler-a': 0, 'soak-handler-b': 0 }
  /*
    Calls for events this run did NOT publish, counted separately — and this is a measurement rather
    than a precaution. `drainOutbox` drains the WHOLE outbox, and the second handler takes `'*'`, so the
    first run of this soak reported 50 calls for handler A and 51 for handler B over 50 events. The
    extra one was a pending event left in the database by something else, and for a moment it read as a
    handler invoked twice — which is the exact defect this run exists to detect. Counting it apart is
    what keeps the interesting number interesting.

    It also means a soak run against a SHARED database publishes other suites' pending events. That is a
    real side effect and is why `scripts/soak.mjs` is run deliberately against a database somebody chose
    rather than being part of `pnpm verify`.
  */
  const foreign: Record<string, number> = { 'soak-handler-a': 0, 'soak-handler-b': 0 }
  const mine = (key: string) => key.startsWith(`${PROBE}:`)
  const count = (name: string, key: string) => {
    const bag = mine(key) ? calls : foreign
    bag[name] = (bag[name] ?? 0) + 1
  }
  const handlers: readonly HandlerRegistration[] = [
    {
      name: 'soak-handler-a',
      eventTypes: ['soak.probe'],
      handle: async (event) => {
        count('soak-handler-a', event.idempotencyKey)
      },
    },
    {
      name: 'soak-handler-b',
      eventTypes: ['*'],
      handle: async (event) => {
        count('soak-handler-b', event.idempotencyKey)
      },
    },
  ]

  /*
    Enqueued through `publishEvent` rather than by a bulk insert: the namespaced event type, the
    idempotency key and the `on conflict do nothing` are the chokepoint's behaviour, and a soak that
    filled the table by another route would be draining rows nothing in production would have written.

    Batched into transactions of {@link ENQUEUE_BATCH} rather than one each, which is the one place this
    departs from how production writes: there, the event is appended in the SAME transaction as the state
    change it describes, and that is the whole pattern. Here there is no state change, and ten thousand
    three-round-trip transactions cost about a minute of the soak's runtime for no claim.
  */
  for (let from = 0; from < options.events; from += ENQUEUE_BATCH) {
    const until = Math.min(from + ENQUEUE_BATCH, options.events)
    await sql.begin(async (tx) => {
      for (let index = from; index < until; index += 1) {
        await publishEvent(tx as unknown as Sql, {
          eventType: 'soak.probe',
          aggregateType: 'soak',
          aggregateId: `${index}`,
          payload: { index },
          idempotencyKey: `${PROBE}:${index}`,
        })
      }
    })
  }

  const started = Date.now()
  let settled = false
  while (!settled) {
    const results = await Promise.all(
      Array.from({ length: options.drainers }, () =>
        drainOutbox(sql, handlers, { batchSize: options.batchSize }),
      ),
    )
    settled = results.every((result) => result.claimed === 0)
  }
  const drainMs = Date.now() - started

  const [counted] = await sql<{ deliveries: string; pairs: string; unpublished: string }[]>`
    select
      (select count(*)::text from outbox_delivery d
         join outbox_event e on e.id = d.event_id
        where e.idempotency_key like ${`${PROBE}:%`}) as deliveries,
      (select count(*)::text from (
         select distinct d.event_id, d.handler from outbox_delivery d
           join outbox_event e on e.id = d.event_id
          where e.idempotency_key like ${`${PROBE}:%`}) pairs) as pairs,
      (select count(*)::text from outbox_event
        where idempotency_key like ${`${PROBE}:%`} and published_at is null) as unpublished
  `

  return {
    events: options.events,
    handlers: handlers.length,
    drainers: options.drainers,
    batchSize: options.batchSize,
    deliveries: Number(counted?.deliveries ?? 0),
    distinctPairs: Number(counted?.pairs ?? 0),
    unpublishedAfter: Number(counted?.unpublished ?? 0),
    drainMs,
    handlerCalls: calls,
    foreignHandlerCalls: foreign,
  }
}
