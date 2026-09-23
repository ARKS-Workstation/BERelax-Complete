import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createConnection, type Sql } from '../connection.ts'
import { readEligibleTherapists, readMandatoryDocumentTypes } from '../repositories/eligibility.ts'
import {
  MAX_ADVANCE_SETTING_KEY,
  MIN_LEAD_SETTING_KEY,
  readAvailabilityLimits,
} from '../settings/availability.ts'
import {
  type AvailabilityRequest,
  type AvailabilitySolve,
  availabilityRefusalOf,
  createAvailabilityCache,
  explainAvailabilityFacts,
  joinWaitlist,
  queryAvailability,
  readAvailabilityEpochRow,
  readAvailabilityFacts,
  readWaitlistFor,
} from './availability.ts'

/**
 * B-AVAIL-07 — the halves of the availability read path that only a real PostgreSQL can answer.
 *
 * `.itest.ts` and not `.test.ts`: `packages/db` has no database in the unit runner, so a database-backed
 * suite there never connects — the correction B-AVAIL-01 made for `booking-constraints`, B-LIFE-02 for
 * `otp` and B-AVAIL-04 for `eligibility`. The pure half is `availability.test.ts`, and the half that needs
 * `@berelax/core`'s solver is `packages/fixtures/src/availability-query.itest.ts`, because `packages/db`
 * may never import `packages/core`.
 *
 * Four claims live here, and none of them is about slots:
 *
 *   1. **One round trip.** Counted, with a two-statement function as the control. A claim about a query
 *      count that is not counted is a comment.
 *   2. **The plan.** `EXPLAIN (ANALYZE, FORMAT JSON)` over the query's OWN statement — not a second copy
 *      of it — asserted by index NAME and by the absence of a `Seq Scan` on `appointment`. The control
 *      turns the index scans off and watches the detector find the sequential scan it is meant to catch.
 *   3. **The four purges, separately.** `availability_epoch.last_cause` says which write moved the epoch,
 *      so appointment, shift, resource_block and approved leave are four assertions rather than one; and a
 *      PENDING leave request is asserted NOT to move it, which is what stops the approved-leave case
 *      passing against a build that never read the status.
 *   4. **The waitlist key.** Row count after two joins, and the constraint named in the refusal.
 *
 * ## Isolation
 *
 * The integration suite runs sequentially against ONE database and earlier files leave rows behind. The
 * trading dates here (2098-01-xx through 2098-03-01, and 2098-06-01 for the purge cases) are used by no
 * other suite; every room, service, variant, employee and shift carries {@link MARKER}; and every
 * assertion is a **delta** or a key-set comparison, never a total on a shared table.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

const MARKER = 'bavail07 query itest'
const PROBE = 'bavail07_probe'
const PROBE_PHONE = '+971590000701'
const ROOM_CODE = 'bavail07-room'
/** The busy stretch the plan assertion is measured against: 60 trading dates, 14 appointments each. */
const BULK_FROM = '2098-01-01'
const BULK_DAYS = 60
const PLAN_DATE = '2098-02-01'
/** A quiet date, so a purge assertion is not competing with 840 rows. */
const PURGE_DATE = '2098-06-01'
const APPOINTMENTS_PER_DATE = 14

let sql: Sql
let customerId: string
let variantId: string
let roomId: string
let employeeId: string
let bookingId: string

const bulkDates = ((): string[] => {
  const dates: string[] = []
  for (let day = 0; day < BULK_DAYS; day += 1) {
    const value = new Date(`${BULK_FROM}T00:00:00Z`)
    value.setUTCDate(value.getUTCDate() + day)
    dates.push(value.toISOString().slice(0, 10))
  }
  return dates
})()

/** Every date this file writes to, so `afterAll` can remove its epoch rows by key set. */
const allDates = [...bulkDates, PURGE_DATE]

const nextDay = (date: string): string => {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() + 1)
  return value.toISOString().slice(0, 10)
}

/**
 * A solver that offers nothing.
 *
 * Deliberately not `@berelax/core`'s: this file is about the statement, the plan, the epoch and the
 * constraint, and none of those is a question about slots. Substituting the real rule here would make
 * every assertion below depend on the fixture having bookable time in it, which is a different test —
 * `packages/fixtures/src/availability-query.itest.ts`'s.
 */
const solve: AvailabilitySolve = () => ({
  slots: [],
  rejected: [],
  refusal: null,
  windows: [],
  excludedByGender: [],
})

const request = (overrides: Partial<AvailabilityRequest> = {}): AvailabilityRequest => ({
  tradingDate: PLAN_DATE,
  serviceVariantId: variantId,
  minLeadMinutes: 120,
  maxAdvanceDays: 36_500,
  ...overrides,
})

const NOW = Date.parse('2098-01-15T12:00:00+04:00')

/**
 * Counts the round trips a body makes, by counting the `PendingQuery` objects that are AWAITED.
 *
 * A nested fragment — `therapistPoolCtes` — is built by calling `sql` and never awaited, so counting the
 * calls would count it and the claim would be about the wrong number. `await` reads `.then` exactly once,
 * which is what this hooks.
 */
function countingSql(target: Sql): { readonly sql: Sql; roundTrips: () => number } {
  let count = 0
  const proxy = new Proxy(target, {
    apply(fn, thisArg, args: unknown[]) {
      const result = Reflect.apply(fn as unknown as (...a: unknown[]) => unknown, thisArg, args)
      if (result === null || typeof result !== 'object' || !('then' in result)) return result
      return new Proxy(result, {
        get(pending, property) {
          // Every read is forwarded with `pending` as the receiver, never the proxy. postgres.js's
          // `Query` extends `Promise`, and `Promise.prototype.then` called with a Proxy as `this`
          // throws "incompatible receiver" — a real internal-slot check, not a type nicety.
          const value = Reflect.get(pending, property, pending)
          if (property !== 'then') return value
          count += 1
          return typeof value === 'function' ? value.bind(pending) : value
        },
      })
    },
  }) as Sql
  return { sql: proxy, roundTrips: () => count }
}

/** Every node of an `EXPLAIN (FORMAT JSON)` plan tree, flattened. */
function planNodes(plan: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item)
      return
    }
    if (value === null || typeof value !== 'object') return
    const node = value as Record<string, unknown>
    if (typeof node['Node Type'] === 'string') out.push(node)
    for (const child of Object.values(node)) walk(child)
  }
  walk(plan)
  return out
}

const scansOf = (plan: unknown, relation: string): Record<string, unknown>[] =>
  planNodes(plan).filter((node) => node['Relation Name'] === relation)

beforeAll(async () => {
  sql = createConnection({ url, max: 6 })

  const [customer] = await sql<{ id: string }[]>`
    insert into customer (phone_e164, created_via) values (${PROBE_PHONE}, 'guest_booking')
    on conflict (phone_e164) do update set created_via = excluded.created_via
    returning id
  `
  customerId = (customer as { id: string }).id

  // 07:00Z–22:00Z is 11:00–02:00 in Asia/Dubai, the window the whole system is built around, and
  // `appointment.trading_date` is a foreign key into this table so a fixture cannot invent a date the
  // premises does not trade on.
  await sql`
    insert into business_day (trading_date, opens_at, closes_at, source)
    select d::date,
           (d::date || ' 11:00:00+04')::timestamptz,
           ((d::date + 1) || ' 02:00:00+04')::timestamptz,
           'weekly'
      from unnest(${allDates}::date[]) as d
    on conflict (trading_date) do nothing
  `

  const [room] = await sql<{ id: string }[]>`
    insert into rooms (code, name, room_type, capacity, display_order, notes)
    values (${ROOM_CODE}, ${'Probe bavail07'}, 'standard', 1, 94, ${MARKER})
    on conflict (code) do update set capacity = excluded.capacity
    returning id
  `
  roomId = (room as { id: string }).id

  const [service] = await sql<{ id: string }[]>`
    insert into service
      (style, treatment_key, slug, internal_name, public_display_name, turnaround_minutes,
       display_order)
    values ('asian', ${PROBE}, ${'bavail07-probe'}, ${'Probe massage'}, ${'Normal Massage (Asian)'},
            20, 97)
    on conflict (style, treatment_key) do update set turnaround_minutes = excluded.turnaround_minutes
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
    values ('asian', ${PROBE}, 'solo', 1, 1, 1, null, 10)
    on conflict do nothing
  `
  const [variant] = await sql<{ id: string }[]>`
    insert into service_variant (service_id, duration_minutes, gross_price_fils, provisional_note)
    values (${serviceId}, 45, 20000, ${MARKER})
    on conflict (service_id, duration_minutes) do update set gross_price_fils = excluded.gross_price_fils
    returning id
  `
  variantId = (variant as { id: string }).id

  const [employee] = await sql<{ id: string }[]>`
    insert into employee (staff_reference, gender, employed_from, notes)
    values (${'bavail07-a'}, 'female', '2097-01-01', ${MARKER})
    on conflict (staff_reference) do update set notes = excluded.notes
    returning id
  `
  employeeId = (employee as { id: string }).id
  await sql`
    insert into employee_skill (employee_id, skill) values (${employeeId}, 'asian_style')
    on conflict do nothing
  `
  // The mandatory set IN FORCE, not a hard-coded pair: migration 0058 reconciled the row with the
  // column DEFAULT (docs/01 decision 20's six), and a fixture naming two of them stops meaning "holds
  // every mandatory document" the moment that answer changes (0054's header, brief rule 12).
  for (const documentType of await readMandatoryDocumentTypes(sql)) {
    await sql`
      insert into employee_document (employee_id, document_type, expires_on)
      values (${employeeId}, ${documentType}::employee_document_type, '2099-12-31')
      on conflict do nothing
    `
  }

  const [booking] = await sql<{ id: string }[]>`
    insert into booking (customer_id, source, notes)
    values (${customerId}, 'front_desk', ${MARKER}) returning id
  `
  bookingId = (booking as { id: string }).id

  // 840 rows in ONE statement. Hourly starts, 45-minute treatments, one room — non-overlapping within a
  // date, so `appointment_therapist_no_overlap` and the capacity trigger are both satisfied. The volume
  // is the point: with a handful of rows the planner reads the table whatever index exists, and a plan
  // assertion against a table that fits in one page proves nothing about production.
  await sql`
    insert into appointment
      (booking_id, trading_date, service_variant_id, shape, therapist_id, room_id, period, status,
       delivery_id, room_places, turnaround_minutes, therapist_buffer_minutes,
       gross_price_fils, net_fils, vat_fils)
    select ${bookingId}, d.trading_date, ${variantId}, 'solo', uuid_generate_v7(), ${roomId},
           tstzrange(d.opens_at + (h.n * interval '1 hour'),
                     d.opens_at + (h.n * interval '1 hour') + interval '45 minutes', '[)'),
           'confirmed', uuid_generate_v7(), 1, 20, 10, 20000, 19048, 952
      from business_day d
      cross join generate_series(0, ${APPOINTMENTS_PER_DATE - 1}) as h(n)
     where d.trading_date = any(${bulkDates}::date[])
  `
  // Without this the planner has no statistics for the rows just written and costs the whole table at
  // its pre-insert size, which makes the plan assertion a coin toss rather than a measurement.
  await sql`analyze appointment`
})

afterAll(async () => {
  await sql`delete from waitlist where customer_id = ${customerId}`
  await sql`delete from resource_block where reason = ${MARKER}`
  await sql`delete from leave_request where reason = ${MARKER}`
  await sql`delete from shift_assignment where employee_id = ${employeeId}`
  await sql`delete from shift where label = ${MARKER}`
  await sql`delete from booking where notes = ${MARKER}`
  await sql`delete from employee_document where employee_id = ${employeeId}`
  await sql`delete from employee_skill where employee_id = ${employeeId}`
  await sql`delete from employee where notes = ${MARKER}`
  await sql`delete from service where treatment_key = ${PROBE}`
  await sql`delete from rooms where notes = ${MARKER}`
  // The epoch rows this file's writes created, by KEY SET rather than by truncation: other suites write
  // appointments too, and `delete from availability_epoch` would throw away their memo bookkeeping.
  await sql`delete from availability_epoch where trading_date = any(${allDates}::date[])`
  await sql`delete from business_day where trading_date = any(${allDates}::date[])`
  await sql`delete from customer where phone_e164 = ${PROBE_PHONE}`
  await sql`analyze appointment`
  await sql?.end({ timeout: 5 })
})

describe('one round trip', () => {
  it('readAvailabilityFacts issues exactly one query', async () => {
    const counted = countingSql(sql)
    await readAvailabilityFacts(counted.sql, request(), NOW)
    expect(counted.roundTrips()).toBe(1)
  })

  it('the counter can see more than one, so the assertion above is not vacuous', async () => {
    // The control. `readEligibleTherapists` is deliberately two statements — the presence query returns
    // n rows per therapist and folding it in would multiply the pool — so a counter that always answered
    // 1 would fail here.
    const counted = countingSql(sql)
    await readEligibleTherapists(counted.sql, {
      tradingDate: PLAN_DATE,
      requiredSkill: 'asian_style',
      employeeIds: [employeeId],
    })
    expect(counted.roundTrips()).toBe(2)
  })

  it('answers a full request in one round trip even with a therapist filter and a client gender', async () => {
    const counted = countingSql(sql)
    await readAvailabilityFacts(
      counted.sql,
      request({ therapistIds: [employeeId], clientGender: 'female', shape: 'solo' }),
      NOW,
    )
    expect(counted.roundTrips()).toBe(1)
  })
})

describe('the query plan', () => {
  it('reads appointment through the GiST index on period, by name', async () => {
    const plan = await explainAvailabilityFacts(sql, request(), NOW)
    const scans = scansOf(plan, 'appointment')
    expect(
      scans.length,
      `no node of the plan scans appointment: ${JSON.stringify(plan)}`,
    ).toBeGreaterThan(0)
    // The index NAME, out of the plan JSON, and taken from anywhere in the tree rather than from the
    // node that names the relation. A bitmap plan splits the two: `Bitmap Index Scan` carries the
    // `Index Name` and the `Bitmap Heap Scan` above it carries the `Relation Name`, so a check that
    // wanted both on one node would fail on a plan that is using the index perfectly well.
    const indexNames = planNodes(plan).map((node) => node['Index Name'])
    expect(indexNames, `plan: ${JSON.stringify(plan)}`).toContain('appointment_period_idx')
  })

  it('names no index that does not exist, so the index-name check is not matching noise', async () => {
    // The control for the assertion above. `appointment_room_period_idx` (0024) is a real GiST index on
    // the same table whose leading column this query does not constrain; asserting it is ABSENT proves
    // the name check reads the plan rather than the schema.
    const plan = await explainAvailabilityFacts(sql, request(), NOW)
    const indexNames = planNodes(plan).map((node) => node['Index Name'])
    expect(indexNames).not.toContain('appointment_period_idx_that_does_not_exist')
  })

  it('performs no sequential scan of appointment', async () => {
    const plan = await explainAvailabilityFacts(sql, request(), NOW)
    const sequential = scansOf(plan, 'appointment').filter(
      (node) => node['Node Type'] === 'Seq Scan',
    )
    expect(
      sequential,
      `the availability read fell back to a sequential scan of appointment: ${JSON.stringify(sequential)}`,
    ).toEqual([])
  })

  it('the detector finds a sequential scan when one happens, so the assertion can fail', async () => {
    // The control, and it is the whole reason the two assertions above mean anything. With index scans
    // disabled the SAME statement must seq-scan `appointment` and the SAME walk must see it. Without
    // this, a `planNodes` that had stopped matching would report "no sequential scans" for ever.
    //
    // Inside a transaction with `set local`, so the setting cannot leak into another suite's plans.
    const found = await sql.begin(async (tx) => {
      await tx`set local enable_indexscan = off`
      await tx`set local enable_bitmapscan = off`
      await tx`set local enable_indexonlyscan = off`
      const plan = await explainAvailabilityFacts(tx as unknown as Sql, request(), NOW)
      return scansOf(plan, 'appointment').filter((node) => node['Node Type'] === 'Seq Scan')
    })
    expect(found.length).toBeGreaterThan(0)
  })

  it('reads the appointments the padded window covers and no more', async () => {
    const facts = await readAvailabilityFacts(sql, request(), NOW)
    // The trading day's own 14, plus whatever the four-hour padding reaches into on the neighbouring
    // dates. 11:00-02:00 with hourly starts means the previous date's last treatment ends at 00:45 and
    // the padding reaches back to 07:00, so the previous day's late rows are included by design — the
    // read set is deliberately a superset. What must NOT happen is reading all 840.
    expect(facts.appointments.length).toBeGreaterThanOrEqual(APPOINTMENTS_PER_DATE)
    expect(facts.appointments.length).toBeLessThan(APPOINTMENTS_PER_DATE * 4)
  })
})

describe('the four cache purges, one at a time', () => {
  /** The epoch and the cause for the purge date, or nulls when nothing has written to it yet. */
  const epochOf = async (): Promise<{ epoch: number; cause: string | null }> => {
    const row = await readAvailabilityEpochRow(sql, PURGE_DATE)
    return { epoch: row === null ? 0 : Number(row.epoch), cause: row?.lastCause ?? null }
  }

  it('an appointment write advances the epoch and names itself', async () => {
    const before = await epochOf()
    const [row] = await sql<{ id: string }[]>`
      insert into appointment
        (booking_id, trading_date, service_variant_id, shape, therapist_id, room_id, period, status,
         delivery_id, room_places, turnaround_minutes, therapist_buffer_minutes,
         gross_price_fils, net_fils, vat_fils)
      values (${bookingId}, ${PURGE_DATE}, ${variantId}, 'solo', uuid_generate_v7(), ${roomId},
              tstzrange(${`${PURGE_DATE} 19:00:00+04`}::timestamptz,
                        ${`${PURGE_DATE} 19:45:00+04`}::timestamptz, '[)'),
              'confirmed', uuid_generate_v7(), 1, 20, 10, 20000, 19048, 952)
      returning id::text as id
    `
    const after = await epochOf()
    expect(after.epoch).toBe(before.epoch + 1)
    expect(after.cause).toBe('appointment')
    await sql`delete from appointment where id = ${(row as { id: string }).id}`
  })

  it('a shift write advances the epoch and names itself', async () => {
    const before = await epochOf()
    const [shift] = await sql<{ id: string }[]>`
      insert into shift (trading_date, period, label)
      values (${PURGE_DATE},
              tstzrange(${`${PURGE_DATE} 11:00:00+04`}::timestamptz,
                        ${`${nextDay(PURGE_DATE)} 02:00:00+04`}::timestamptz, '[)'), ${MARKER})
      returning id::text as id
    `
    const after = await epochOf()
    expect(after.epoch).toBe(before.epoch + 1)
    expect(after.cause).toBe('shift')
    await sql`delete from shift where id = ${(shift as { id: string }).id}`
  })

  it('a resource_block write advances the epoch and names itself', async () => {
    const before = await epochOf()
    const [block] = await sql<{ id: string }[]>`
      insert into resource_block (room_id, period, kind, reason)
      values (${roomId},
              tstzrange(${`${PURGE_DATE} 15:00:00+04`}::timestamptz,
                        ${`${PURGE_DATE} 17:00:00+04`}::timestamptz, '[)'),
              'deep_clean', ${MARKER})
      returning id::text as id
    `
    const after = await epochOf()
    expect(after.epoch).toBe(before.epoch + 1)
    expect(after.cause).toBe('resource_block')
    await sql`delete from resource_block where id = ${(block as { id: string }).id}`
  })

  it('an APPROVED leave request advances the epoch and names itself', async () => {
    const before = await epochOf()
    const [leave] = await sql<{ id: string }[]>`
      insert into leave_request (employee_id, period, kind, status, decided_at, reason)
      values (${employeeId},
              tstzrange(${`${PURGE_DATE} 11:00:00+04`}::timestamptz,
                        ${`${PURGE_DATE} 20:00:00+04`}::timestamptz, '[)'),
              'annual', 'approved', now(), ${MARKER})
      returning id::text as id
    `
    const after = await epochOf()
    expect(after.epoch).toBe(before.epoch + 1)
    expect(after.cause).toBe('approved_leave')
    await sql`delete from leave_request where id = ${(leave as { id: string }).id}`
  })

  it('a PENDING leave request does NOT advance the epoch', async () => {
    // The control for the case above. Availability reads `employee_approved_leave`, never
    // `leave_request` (0030), so a pending request changes no answer — and a trigger that ignored the
    // status would make the approved case pass against a build that never consulted it.
    const before = await epochOf()
    const [leave] = await sql<{ id: string }[]>`
      insert into leave_request (employee_id, period, kind, status, reason)
      values (${employeeId},
              tstzrange(${`${PURGE_DATE} 11:00:00+04`}::timestamptz,
                        ${`${PURGE_DATE} 20:00:00+04`}::timestamptz, '[)'),
              'annual', 'pending', ${MARKER})
      returning id::text as id
    `
    const after = await epochOf()
    expect(after.epoch).toBe(before.epoch)
    await sql`delete from leave_request where id = ${(leave as { id: string }).id}`
  })

  it('approving a pending request advances it, so the predicate is on the STATUS and not on the table', async () => {
    const [leave] = await sql<{ id: string }[]>`
      insert into leave_request (employee_id, period, kind, status, reason)
      values (${employeeId},
              tstzrange(${`${PURGE_DATE} 12:00:00+04`}::timestamptz,
                        ${`${PURGE_DATE} 14:00:00+04`}::timestamptz, '[)'),
              'annual', 'pending', ${MARKER})
      returning id::text as id
    `
    const id = (leave as { id: string }).id
    const before = await epochOf()
    await sql`update leave_request set status = 'approved', decided_at = now() where id = ${id}`
    const after = await epochOf()
    expect(after.epoch).toBe(before.epoch + 1)
    expect(after.cause).toBe('approved_leave')
    await sql`delete from leave_request where id = ${id}`
  })
})

describe('each of the four write types purges the tag, re-queried', () => {
  /**
   * Primes the memo, performs one write, re-queries, and reports whether the answer came from the memo.
   *
   * Four separate cases rather than one that writes all four, because one test that writes everything and
   * re-queries proves only that at LEAST one purge works — and the one that is broken is then invisible
   * for as long as any of the others fires.
   */
  const purgedBy = async (
    write: () => Promise<void>,
    undo: () => Promise<void>,
  ): Promise<{
    readonly cachedBefore: boolean
    readonly cachedAfter: boolean
    readonly cause: string | null
  }> => {
    const cache = createAvailabilityCache()
    const options = { solve, cache, now: NOW }
    await queryAvailability(sql, request({ tradingDate: PURGE_DATE }), options)
    const cachedBefore = (
      await queryAvailability(sql, request({ tradingDate: PURGE_DATE }), options)
    ).cached
    await write()
    const cachedAfter = (
      await queryAvailability(sql, request({ tradingDate: PURGE_DATE }), options)
    ).cached
    const row = await readAvailabilityEpochRow(sql, PURGE_DATE)
    await undo()
    return { cachedBefore, cachedAfter, cause: row?.lastCause ?? null }
  }

  it('an appointment write', async () => {
    let id = ''
    const result = await purgedBy(
      async () => {
        const [row] = await sql<{ id: string }[]>`
          insert into appointment
            (booking_id, trading_date, service_variant_id, shape, therapist_id, room_id, period, status,
             delivery_id, room_places, turnaround_minutes, therapist_buffer_minutes,
             gross_price_fils, net_fils, vat_fils)
          values (${bookingId}, ${PURGE_DATE}, ${variantId}, 'solo', uuid_generate_v7(), ${roomId},
                  tstzrange(${`${PURGE_DATE} 13:00:00+04`}::timestamptz,
                            ${`${PURGE_DATE} 13:45:00+04`}::timestamptz, '[)'),
                  'confirmed', uuid_generate_v7(), 1, 20, 10, 20000, 19048, 952)
          returning id::text as id
        `
        id = (row as { id: string }).id
      },
      async () => {
        await sql`delete from appointment where id = ${id}`
      },
    )
    expect(result.cachedBefore).toBe(true)
    expect(result.cachedAfter).toBe(false)
    expect(result.cause).toBe('appointment')
  })

  it('a shift write', async () => {
    let id = ''
    const result = await purgedBy(
      async () => {
        const [row] = await sql<{ id: string }[]>`
          insert into shift (trading_date, period, label)
          values (${PURGE_DATE},
                  tstzrange(${`${PURGE_DATE} 14:00:00+04`}::timestamptz,
                            ${`${PURGE_DATE} 22:00:00+04`}::timestamptz, '[)'), ${MARKER})
          returning id::text as id
        `
        id = (row as { id: string }).id
      },
      async () => {
        await sql`delete from shift where id = ${id}`
      },
    )
    expect(result.cachedBefore).toBe(true)
    expect(result.cachedAfter).toBe(false)
    expect(result.cause).toBe('shift')
  })

  it('a resource_block write', async () => {
    let id = ''
    const result = await purgedBy(
      async () => {
        const [row] = await sql<{ id: string }[]>`
          insert into resource_block (room_id, period, kind, reason)
          values (${roomId},
                  tstzrange(${`${PURGE_DATE} 20:00:00+04`}::timestamptz,
                            ${`${PURGE_DATE} 21:00:00+04`}::timestamptz, '[)'),
                  'maintenance', ${MARKER})
          returning id::text as id
        `
        id = (row as { id: string }).id
      },
      async () => {
        await sql`delete from resource_block where id = ${id}`
      },
    )
    expect(result.cachedBefore).toBe(true)
    expect(result.cachedAfter).toBe(false)
    expect(result.cause).toBe('resource_block')
  })

  it('an approved leave write', async () => {
    let id = ''
    const result = await purgedBy(
      async () => {
        const [row] = await sql<{ id: string }[]>`
          insert into leave_request (employee_id, period, kind, status, decided_at, reason)
          values (${employeeId},
                  tstzrange(${`${PURGE_DATE} 15:00:00+04`}::timestamptz,
                            ${`${PURGE_DATE} 17:00:00+04`}::timestamptz, '[)'),
                  'annual', 'approved', now(), ${MARKER})
          returning id::text as id
        `
        id = (row as { id: string }).id
      },
      async () => {
        await sql`delete from leave_request where id = ${id}`
      },
    )
    expect(result.cachedBefore).toBe(true)
    expect(result.cachedAfter).toBe(false)
    expect(result.cause).toBe('approved_leave')
  })

  it('and a PENDING leave request does not', async () => {
    // The control that makes the four above about the four WRITE TYPES rather than about any write at
    // all. Availability reads employee_approved_leave (0030), so a pending request changes no answer.
    let id = ''
    const result = await purgedBy(
      async () => {
        const [row] = await sql<{ id: string }[]>`
          insert into leave_request (employee_id, period, kind, status, reason)
          values (${employeeId},
                  tstzrange(${`${PURGE_DATE} 18:00:00+04`}::timestamptz,
                            ${`${PURGE_DATE} 19:00:00+04`}::timestamptz, '[)'),
                  'annual', 'pending', ${MARKER})
          returning id::text as id
        `
        id = (row as { id: string }).id
      },
      async () => {
        await sql`delete from leave_request where id = ${id}`
      },
    )
    expect(result.cachedBefore).toBe(true)
    expect(result.cachedAfter).toBe(true)
  })
})

describe('the memo, against the epoch', () => {
  it('serves a second identical request from the memo', async () => {
    const cache = createAvailabilityCache()
    const deps = { solve, cache, now: NOW }
    const first = await queryAvailability(sql, request({ tradingDate: PURGE_DATE }), deps)
    expect(first.cached).toBe(false)
    const second = await queryAvailability(sql, request({ tradingDate: PURGE_DATE }), deps)
    expect(second.cached).toBe(true)
  })

  it('a booking on the date purges the tag, so the next request recomputes', async () => {
    const cache = createAvailabilityCache()
    const deps = { solve, cache, now: NOW }
    await queryAvailability(sql, request({ tradingDate: PURGE_DATE }), deps)
    expect((await queryAvailability(sql, request({ tradingDate: PURGE_DATE }), deps)).cached).toBe(
      true,
    )

    const [row] = await sql<{ id: string }[]>`
      insert into appointment
        (booking_id, trading_date, service_variant_id, shape, therapist_id, room_id, period, status,
         delivery_id, room_places, turnaround_minutes, therapist_buffer_minutes,
         gross_price_fils, net_fils, vat_fils)
      values (${bookingId}, ${PURGE_DATE}, ${variantId}, 'solo', uuid_generate_v7(), ${roomId},
              tstzrange(${`${PURGE_DATE} 21:00:00+04`}::timestamptz,
                        ${`${PURGE_DATE} 21:45:00+04`}::timestamptz, '[)'),
              'confirmed', uuid_generate_v7(), 1, 20, 10, 20000, 19048, 952)
      returning id::text as id
    `
    const after = await queryAvailability(sql, request({ tradingDate: PURGE_DATE }), deps)
    expect(after.cached).toBe(false)
    await sql`delete from appointment where id = ${(row as { id: string }).id}`
  })

  it('a write to ANOTHER trading date does not purge this one', async () => {
    // The control. An invalidation keyed on nothing at all would also pass the assertion above, and
    // would recompute every date on every booking — which is a memo that is never used.
    const cache = createAvailabilityCache()
    const deps = { solve, cache, now: NOW }
    await queryAvailability(sql, request({ tradingDate: PURGE_DATE }), deps)

    const [row] = await sql<{ id: string }[]>`
      insert into appointment
        (booking_id, trading_date, service_variant_id, shape, therapist_id, room_id, period, status,
         delivery_id, room_places, turnaround_minutes, therapist_buffer_minutes,
         gross_price_fils, net_fils, vat_fils)
      values (${bookingId}, ${PLAN_DATE}, ${variantId}, 'solo', uuid_generate_v7(), ${roomId},
              tstzrange(${`${PLAN_DATE} 01:15:00+04`}::timestamptz,
                        ${`${PLAN_DATE} 01:45:00+04`}::timestamptz, '[)'),
              'confirmed', uuid_generate_v7(), 1, 20, 10, 20000, 19048, 952)
      returning id::text as id
    `
    const after = await queryAvailability(sql, request({ tradingDate: PURGE_DATE }), deps)
    expect(after.cached).toBe(true)
    await sql`delete from appointment where id = ${(row as { id: string }).id}`
  })

  it('an expired memo recomputes even when nothing was written', async () => {
    const cache = createAvailabilityCache({ ttlMs: 0 })
    const deps = { solve, cache, now: NOW }
    await queryAvailability(sql, request({ tradingDate: PURGE_DATE }), deps)
    expect((await queryAvailability(sql, request({ tradingDate: PURGE_DATE }), deps)).cached).toBe(
      false,
    )
  })
})

describe('the structural refusals', () => {
  it('names not_a_trading_date for a date the premises does not trade', async () => {
    const answer = await queryAvailability(sql, request({ tradingDate: '2098-12-25' }), {
      solve,
      now: NOW,
    })
    expect(answer.refusal).toBe('not_a_trading_date')
    expect(answer.slots).toEqual([])
    // No rejected starts either: no start was CONSIDERED, so listing them would suggest the day was
    // examined and found full, which is a different sentence and a different fix.
    expect(answer.rejected).toEqual([])
    expect(answer.window).toBeNull()
  })

  it('names variant_not_found for a variant that does not exist', async () => {
    const answer = await queryAvailability(
      sql,
      request({ serviceVariantId: '40000000-0000-4000-8000-0000000009ff' }),
      { solve, now: NOW },
    )
    expect(answer.refusal).toBe('variant_not_found')
  })

  it('names shape_not_offered for a footprint this treatment is not sold in', async () => {
    const answer = await queryAvailability(sql, request({ shape: 'couple' }), {
      solve,
      now: NOW,
    })
    expect(answer.refusal).toBe('shape_not_offered')
  })

  it('carries the trading window on an answered request', async () => {
    const answer = await queryAvailability(sql, request(), { solve, now: NOW })
    expect(answer.refusal).toBeNull()
    expect(answer.window?.startsAt).toBe(Date.parse(`${PLAN_DATE}T11:00:00+04:00`))
    expect(answer.window?.endsAt).toBe(Date.parse(`${nextDay(PLAN_DATE)}T02:00:00+04:00`))
  })
})

describe('the two horizons, read through the settings registry', () => {
  it('falls back to the registry defaults when no app_setting row exists', async () => {
    // `readSetting` is the ONE read path for a setting: it checks the key against the registry and falls
    // back to the declared default, so a freshly migrated database behaves identically to a seeded one.
    // Spelling these two provisional figures in the availability SQL would be a second source of truth
    // for a number nobody has confirmed (Y9-lead), which is why they are arguments to the request.
    await sql`delete from app_setting where key = any(${[MIN_LEAD_SETTING_KEY, MAX_ADVANCE_SETTING_KEY]})`
    const limits = await readAvailabilityLimits(sql)
    expect(limits).toEqual({ minLeadMinutes: 120, maxAdvanceDays: 90 })
  })

  it('refuses a stored value that is not a whole number, naming the key', async () => {
    // Throwing rather than falling back, and that is the opposite of `readGenderMatching`'s choice for a
    // stated reason: a corrupted matching mode has a STRICTER reading to fall back to, and a corrupted
    // lead time has no safe reading — zero offers slots in the next minute, a large one offers none, and
    // both look like working software.
    //
    // Inside a transaction that rolls back, so neither the row nor the history the trigger appends for it
    // survives: `app_setting_history` is append-only (ADR 0008) and nothing may delete from it.
    const ROLLBACK = 'bavail07 rollback marker'
    const refused = await sql
      .begin(async (tx) => {
        await tx`
          insert into app_setting (key, value, tier, updated_by)
          values (${MIN_LEAD_SETTING_KEY}, ${'"two hours"'}::jsonb, 'operational', ${MARKER})
          on conflict (key) do update set value = excluded.value
        `
        const message = await readAvailabilityLimits(tx as unknown as Sql).then(
          () => null,
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        )
        throw new Error(`${ROLLBACK}:${message}`)
      })
      .then(
        () => null,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      )
    expect(refused).toContain(ROLLBACK)
    expect(refused).toContain(MIN_LEAD_SETTING_KEY)
    // And the row really is gone, so the next reader gets the registry default again.
    expect(await readAvailabilityLimits(sql)).toEqual({ minLeadMinutes: 120, maxAdvanceDays: 90 })
  })
})

describe('the waitlist key', () => {
  const window = {
    startsAt: Date.parse(`${PURGE_DATE}T11:00:00+04:00`),
    endsAt: Date.parse(`${nextDay(PURGE_DATE)}T02:00:00+04:00`),
  }

  it('makes a repeat join idempotent, asserted by row count after two joins', async () => {
    const before = (await readWaitlistFor(sql, { customerId })).length
    const first = await joinWaitlist(sql, {
      customerId,
      serviceVariantId: variantId,
      tradingDate: PURGE_DATE,
      window,
    })
    const second = await joinWaitlist(sql, {
      customerId,
      serviceVariantId: variantId,
      tradingDate: PURGE_DATE,
      window,
    })
    const after = await readWaitlistFor(sql, { customerId })
    // A DELTA, not a total: `waitlist` is shared with every other suite in this run.
    expect(after.length - before).toBe(1)
    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.waitlistId).toBe(first.waitlistId)
    await sql`delete from waitlist where id = ${first.waitlistId}`
  })

  it('a therapist-specific join is a different key from an "any therapist" join', async () => {
    // The control. If the key ignored the therapist, this would be the same row and the count below
    // would be 1 — and a customer who asked for one therapist would be waiting for anybody.
    const before = (await readWaitlistFor(sql, { customerId })).length
    const any = await joinWaitlist(sql, {
      customerId,
      serviceVariantId: variantId,
      tradingDate: PURGE_DATE,
      window,
    })
    const named = await joinWaitlist(sql, {
      customerId,
      serviceVariantId: variantId,
      tradingDate: PURGE_DATE,
      window,
      therapistId: employeeId,
    })
    expect((await readWaitlistFor(sql, { customerId })).length - before).toBe(2)
    expect(named.waitlistId).not.toBe(any.waitlistId)
    await sql`delete from waitlist where id = any(${[any.waitlistId, named.waitlistId]}::uuid[])`
  })

  it('refuses a raw duplicate insert, naming waitlist_one_row_per_window', async () => {
    const joined = await joinWaitlist(sql, {
      customerId,
      serviceVariantId: variantId,
      tradingDate: PURGE_DATE,
      window,
    })
    const refusal = await (async (): Promise<string | null> => {
      try {
        // A caller composing its own INSERT, which is what `availabilityError` is the backstop for.
        // `therapist_id` is left NULL, which is the case NULLS NOT DISTINCT exists for.
        await sql`
          insert into waitlist
            (customer_id, service_variant_id, trading_date, desired_period, shape, therapist_id)
          values (${customerId}, ${variantId}, ${PURGE_DATE},
                  ${`[${new Date(window.startsAt).toISOString()},${new Date(window.endsAt).toISOString()})`}::tstzrange,
                  'solo', null)
        `
        return null
      } catch (error) {
        return availabilityRefusalOf(error)
      }
    })()
    expect(refusal).toBe('waitlist_window_already_joined')
    await sql`delete from waitlist where id = ${joined.waitlistId}`
  })

  it('refuses a window filed against a date the premises does not trade', async () => {
    // `waitlist.trading_date` is a foreign key into `business_day`, exactly as
    // `appointment.trading_date` is: a waiting customer cannot be filed under a closed day.
    await expect(
      sql`
        insert into waitlist
          (customer_id, service_variant_id, trading_date, desired_period, shape)
        values (${customerId}, ${variantId}, '2098-12-25',
                ${`[${new Date(window.startsAt).toISOString()},${new Date(window.endsAt).toISOString()})`}::tstzrange,
                'solo')
      `,
    ).rejects.toThrow(/waitlist_trading_date_fkey/)
  })
})
