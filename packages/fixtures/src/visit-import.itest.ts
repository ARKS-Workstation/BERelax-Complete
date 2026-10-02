import { e164IdentityResult } from '@berelax/core'
import {
  type Actor,
  APPOINTMENT_IMPORT_SQLSTATE,
  createConnection,
  readImportedAppointmentCounts,
  resolveVisitTargets,
  type Sql,
  VISIT_QUARANTINE_REASONS,
  VISIT_QUARANTINES,
  withUnitOfWork,
} from '@berelax/db'
import { runImport, unprovenancedRowIds } from '@berelax/migration'
import {
  buildVisitWorkbook,
  VISIT_HEADER,
  VISIT_OUTCOMES,
  VISITS_IMPORTER_TARGETS,
  visitsImporter,
} from '@berelax/migration/importers/appointments'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { contactNormaliser } from './customer-import.ts'
import { fixtureSuppressionPeppers } from './suppression.ts'
import { syntheticPerson } from './synthetic.ts'

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url) {
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')
}

/**
 * H-MIG-05's four acceptance lines, against a real PostgreSQL, each with a control that must fail.
 *
 * This is the only place they can be asserted. `packages/migration` may import neither `@berelax/core`
 * (so it cannot normalise a number) nor the reporting readers, and `packages/db` may not import
 * `packages/core` at all; `packages/fixtures` may depend on all three, which is why H-MIG-04's pairing
 * suite lives here too.
 *
 * ## Every fact comes out of the database, not out of this file
 *
 * The service slug, the staff reference, the room code and the trading dates are READ in `beforeAll`,
 * never written down. Brief rule 15 is one reason — a plausible staff reference is indistinguishable
 * from a configured one — and the recorded failure in `opening-balances.itest.ts` is the other: a suite
 * that states a fact the seed also states is a suite that eventually disagrees with it, and the
 * disagreement is invisible because both look right.
 *
 * ## Why the 01:30 case is TWO assertions and not one
 *
 * The acceptance line is "an imported appointment starting at 01:30 resolves to the previous
 * business_day, asserted against the business_day primitive". It resolves there, and it is then
 * QUARANTINED — because this business closes at 02:00 and the shortest treatment in its catalogue plus
 * its room turnaround is 65 minutes, so nothing can START at 01:30 and finish inside the session. Those
 * are two different claims and collapsing them would hide the second.
 *
 * So the resolution is asserted directly against `business_day`, an after-midnight visit that DOES fit
 * is imported and lands on the previous trading date, and the 01:30 line is asserted to quarantine as
 * `runs_past_close_with_turnaround` — which is only reachable if the previous day's session was the one
 * found, since an instant in no session quarantines as `trading_date_is_not_a_session` instead. The
 * control is exactly that: the same wall-clock time on a date whose previous day does not trade.
 *
 * ## Teardown: this suite deletes nothing, and that is not an omission
 *
 * `imported_appointment` is append-only (ZY364 refuses UPDATE and DELETE for every role) and it holds
 * `appointment_id` with ON DELETE RESTRICT, so the appointments this file imports cannot be removed
 * either. That is the schema working: the record is the evidence that an import happened. What makes it
 * safe for the suites that follow is that every row is a MIGRATED row with a period in the past —
 * ZY366 guarantees it — and every forward-looking reader (`readCommittedAppointments`,
 * `readReassignmentCandidates`) is bounded below by an instant or a trading date in the future. The
 * customers are in a band of synthetic indices no other fixture uses, for the reason
 * `customer-import.itest.ts` records: `customer.phone_e164` is unique, so a fixed index makes the
 * second run of this file assert about the first run's rows.
 */

let sql: Sql

const ACTOR: Actor = { kind: 'system', label: 'H-MIG-05 visit-history suite' }
const PEPPERS = fixtureSuppressionPeppers(process.env)
const OPTIONS = { pepper: PEPPERS.current, normalise: contactNormaliser }

/**
 * Unique per EXECUTION, in a band above every fixture index any other file uses.
 *
 * `customer-import.itest.ts` names the highest in use (10_700 + 300) and takes a band of its own above
 * it; this one sits above that. A fixed index would make the second run of this file resolve every line
 * to the customer the first run created and assert about rows it did not write.
 */
const BASE_INDEX = 40_000 + Math.floor(Math.random() * 20_000)

interface Catalogue {
  readonly serviceSlug: string
  readonly durationMinutes: number
  readonly turnaroundMinutes: number
  /** Several, because every case needs a slot no other case is standing in. See {@link reserve}. */
  readonly staffReferences: readonly string[]
  readonly roomCodes: readonly string[]
}

interface Session {
  readonly tradingDate: string
  readonly opensAt: Date
  readonly closesAt: Date
}

let catalogue: Catalogue
/** A past trading session whose window crosses midnight — the after-midnight case needs one. */
let session: Session
let fileCounter = 0

/**
 * Narrows a read-back value, naming what was missing.
 *
 * `postgres.js` refuses an interpolated `string | undefined` at the type level, which is right: a query
 * parameterised on `undefined` is a query about nothing. A `?.` in a template would have been the quick
 * way past it and the assertion would then have run against a row that was not there.
 */
function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`the suite expected ${what} and the read returned none`)
  return value
}

const plus = (instant: string, minutes: number): string =>
  new Date(new Date(instant).getTime() + minutes * 60_000).toISOString()

/**
 * A slot, a room and a therapist no other case in this file is using.
 *
 * The first spelling of this suite gave every case the same therapist and the same slot — the latest one
 * the session can hold — and seven cases then failed on
 * `appointment_therapist_no_overlap`. That is the constraint doing its job: a reconstructed visit holds
 * its therapist and its room exactly as a live booking does, which is the whole reason the imported
 * dataset can be judged by the same invariants. So the FIXTURE has to be arranged like a real day, and
 * the walk below is what does it: one step is a treatment plus its room turnaround, and within a step
 * the rooms and the therapists advance together so no two reservations in one step share either.
 *
 * The final step is reserved for {@link afterMidnightStart}, which needs the only part of the session
 * that falls on the next calendar date.
 */
let reservations = 0

interface Reservation {
  readonly startedAt: string
  readonly roomCode: string
  readonly staffReference: string
}

function reserve(): Reservation {
  const index = reservations
  reservations += 1
  const step = catalogue.durationMinutes + catalogue.turnaroundMinutes
  const slot = Math.floor(index / catalogue.roomCodes.length)
  const startedAt = new Date(session.opensAt.getTime() + slot * step * 60_000)
  if (startedAt.getTime() + step * 60_000 > session.closesAt.getTime() - step * 60_000) {
    throw new Error(
      `this suite has reserved ${reservations} slots and the trading session ${session.tradingDate} ` +
        'cannot hold another before the step kept back for the after-midnight case. Free a slot or ' +
        'read a longer session.',
    )
  }
  // The room and the therapist advance TOGETHER, so the three reservations inside one step differ in
  // both. Only the first `roomCodes.length` therapists are ever handed out, which keeps the rest free
  // for the cases that need a therapist nothing else in the step is using — the room-capacity case is
  // one, and without the reserve it was refused by the THERAPIST constraint and reported as a pass
  // about room capacity.
  const lane = index % catalogue.roomCodes.length
  return {
    startedAt: startedAt.toISOString(),
    roomCode: catalogue.roomCodes[lane] as string,
    staffReference: catalogue.staffReferences[lane] as string,
  }
}

/** A therapist {@link reserve} never hands out, for a case that needs the room to be the conflict. */
const spareTherapist = (): string => catalogue.staffReferences[catalogue.roomCodes.length] as string

/** The latest start the session can hold, which is after midnight because the session crosses it. */
const afterMidnightStart = (): string =>
  new Date(
    session.closesAt.getTime() - (catalogue.durationMinutes + catalogue.turnaroundMinutes) * 60_000,
  ).toISOString()

interface Line {
  readonly phone: string
  readonly startedAt: string
  readonly finishedAt?: string
  readonly durationMinutes?: number
  readonly serviceSlug?: string
  readonly staffReference?: string
  readonly roomCode?: string
  readonly outcome?: string
  readonly grossFils?: number
}

/** A visit-history file: the generated preamble and header, plus these lines. */
function visitFile(lines: readonly Line[]): string {
  fileCounter += 1
  const rows = lines.map((line) => {
    const duration = line.durationMinutes ?? catalogue.durationMinutes
    return [
      line.phone,
      line.startedAt,
      line.finishedAt ?? plus(line.startedAt, duration),
      String(duration),
      line.serviceSlug ?? catalogue.serviceSlug,
      line.staffReference ?? (catalogue.staffReferences[0] as string),
      line.roomCode ?? (catalogue.roomCodes[0] as string),
      line.outcome ?? 'completed',
      String(line.grossFils ?? 25_000),
    ].join('\t')
  })
  // The counter is a COMMENT, which the parser drops, so it changes the file's bytes and therefore its
  // sha-256 without changing a single value. That is what gives each file in this suite its own
  // `import_run` while keeping every row's content hash exactly what the row says — the distinction
  // `provenance.ts` is built on, exercised here rather than asserted.
  return [buildVisitWorkbook(), `# suite file ${fileCounter}`, ...rows, ''].join('\n')
}

const importFile = async (source: string, mode: 'live' | 'dry-run' = 'live') =>
  runImport({
    sql,
    importer: visitsImporter(OPTIONS),
    sourceFile: `visit-history-${fileCounter}.tsv`,
    sourceText: source,
    mode,
    actor: ACTOR,
  })

/** The canonical form of a fixture number, refused loudly rather than falling back to the raw cell. */
function e164Of(raw: string): string {
  const result = e164IdentityResult(raw)
  if (!result.ok) throw new Error(`the fixture number did not normalise: ${raw}`)
  return result.e164
}

/** A fresh synthetic customer, created the way H-MIG-04 creates one. */
let personCounter = 0
async function newCustomer(): Promise<string> {
  personCounter += 1
  const person = syntheticPerson(BASE_INDEX + personCounter)
  await sql`
    insert into customer (phone_e164, created_via) values (${e164Of(person.phone)}, 'import')
    on conflict (phone_e164) do nothing
  `
  return person.phone
}

/**
 * The quarantine reason on the LAST import record written.
 *
 * Keyed on nothing, which is deliberate and is safe for exactly one reason: every case that calls this
 * imports a one-line file immediately before, and `imported_appointment` is append-only, so the newest
 * row is that line's. Keying it on the digest would mean recomputing an HMAC in the suite with the same
 * pepper the importer used — a second statement of the keying, asserted against itself.
 */
const lastQuarantineReason = async (): Promise<string | null> => {
  const rows = await sql<{ reason: string | null }[]>`
    select quarantine_reason as reason from imported_appointment
     order by created_at desc, id desc limit 1
  `
  return rows[0]?.reason ?? null
}

/** `sum(debit) - sum(credit)` over the whole chart, and the row count — ADR 0064's census. */
const ledgerCensus = async (): Promise<{ lines: number; debit: string; credit: string }> => {
  const rows = await sql<{ lines: string; debit: string; credit: string }[]>`
    select count(*)::text                      as lines,
           coalesce(sum(debit_fils), 0)::text  as debit,
           coalesce(sum(credit_fils), 0)::text as credit
      from journal_line
  `
  const row = rows[0]
  return {
    lines: Number(row?.lines ?? '0'),
    debit: row?.debit ?? '0',
    credit: row?.credit ?? '0',
  }
}

beforeAll(async () => {
  sql = createConnection({ url: url as string, max: 6 })

  const services = await sql<{ slug: string; duration: number; turnaround: number }[]>`
    select s.slug, v.duration_minutes as duration, s.turnaround_minutes as turnaround
      from service_variant v
      join service s on s.id = v.service_id
      join service_resource_shape rs
        on rs.service_style = s.style and rs.service_treatment_key = s.treatment_key
     where rs.shape = 'solo' and rs.therapists_required = 1 and rs.rooms_required = 1
     order by v.duration_minutes + s.turnaround_minutes, s.slug
     limit 1
  `
  const service = services[0]
  const staff = await sql<{ reference: string }[]>`
    select staff_reference as reference from employee
     where employed_from <= current_date and (employed_until is null or employed_until >= current_date)
     order by staff_reference
     limit 6
  `
  const rooms = await sql<{ code: string }[]>`
    select code from rooms where room_type = 'standard' and capacity = 1 order by code limit 3
  `
  /*
    A past session that crosses midnight AND that no appointment stands in.

    Chosen from the database rather than fixed, and that is the fix for a real defect this suite found in
    itself on its second run: it leaves its rows behind (see the module note on why it cannot delete
    them), so a fixed session makes the second execution collide with the first on
    `appointment_therapist_no_overlap` — the constraint reporting correctly about a fixture, in two cases
    whose subject was something else entirely. Excluding every appointment and not only the migrated ones
    also keeps this suite out of the way of the seed's bookings and of every other suite's.
  */
  const days = await sql<{ tradingDate: string; opensAt: Date; closesAt: Date }[]>`
    select d.trading_date::text as "tradingDate", d.opens_at as "opensAt", d.closes_at as "closesAt"
      from business_day d
     where d.crosses_midnight
       and d.closes_at < now() - interval '1 day'
       and not exists (select 1 from appointment a where a.trading_date = d.trading_date)
     order by d.trading_date desc
     limit 1
  `
  const day = days[0]
  if (service === undefined || staff.length < 4 || rooms.length < 2 || day === undefined) {
    throw new Error(
      'The seeded salon does not hold a solo service, four employed therapists, two capacity-1 ' +
        'standard rooms and a past trading session that crosses midnight. Run `pnpm seed` — this ' +
        'suite reads every one of those facts rather than stating them (see the module note).',
    )
  }
  catalogue = {
    serviceSlug: service.slug,
    durationMinutes: Number(service.duration),
    turnaroundMinutes: Number(service.turnaround),
    staffReferences: staff.map((row) => row.reference),
    roomCodes: rooms.map((row) => row.code),
  }
  session = { tradingDate: day.tradingDate, opensAt: day.opensAt, closesAt: day.closesAt }
})

afterAll(async () => {
  await sql?.end({ timeout: 5 })
})

describe('an after-midnight visit belongs to the previous business_day', () => {
  it('is resolved from business_day itself, not from arithmetic on the calendar date', async () => {
    // The primitive. `business_day` holds `[opens_at, closes_at)` per trading date, and the containment
    // query IS the resolution — `resolveVisitTargets` issues exactly this one. 01:30 Dubai on the day
    // AFTER the trading date is inside that date's session, so the answer is the previous calendar date.
    const after = new Date(session.closesAt.getTime() - 30 * 60_000).toISOString()
    const rows = await sql<{ tradingDate: string; calendarDate: string }[]>`
      select trading_date::text as "tradingDate",
             (${after}::timestamptz at time zone 'Asia/Dubai')::date::text as "calendarDate"
        from business_day
       where opens_at <= ${after}::timestamptz and closes_at > ${after}::timestamptz
    `
    expect(rows[0]?.tradingDate).toBe(session.tradingDate)
    // The control: the instant's own calendar date is NOT the trading date, which is the whole claim.
    expect(rows[0]?.calendarDate).not.toBe(session.tradingDate)
  })

  it('imports onto the previous trading date, and the cohort view agrees', async () => {
    // A visit that fits: it must finish, plus its room turnaround, before 02:00.
    const phone = await newCustomer()
    const report = await importFile(visitFile([{ phone, startedAt: afterMidnightStart() }]))
    expect(report.state).toBe('completed')
    expect(report.applied).toBe(1)

    const rows = await sql<{ tradingDate: string; calendarDate: string; migrated: boolean }[]>`
      select a.trading_date::text as "tradingDate",
             (lower(a.period) at time zone 'Asia/Dubai')::date::text as "calendarDate",
             a.migrated
        from appointment a
        join booking b on b.id = a.booking_id
        join customer c on c.id = b.customer_id
       where c.phone_e164 = ${e164Of(phone)}
    `
    expect(rows).toHaveLength(1)
    expect(rows[0]?.tradingDate).toBe(session.tradingDate)
    expect(rows[0]?.calendarDate).not.toBe(session.tradingDate)
    expect(rows[0]?.migrated).toBe(true)

    // The cohort activity is read from `fact_appointment`, so the imported visit has to be in it with
    // the trading date as its business day — that is what makes a treatment after midnight count in its
    // own trading month (`cohorts.itest.ts`'s second claim).
    await sql`select reporting.refresh('fact_appointment', 'on_demand')`
    const facts = await sql<{ businessDay: string }[]>`
      select business_day::text as "businessDay"
        from reporting.fact_appointment
       where appointment_id = any(
         select a.id from appointment a
           join booking b on b.id = a.booking_id
           join customer c on c.id = b.customer_id
          where c.phone_e164 = ${e164Of(phone)}
       )
    `
    expect(facts.map((fact) => fact.businessDay)).toEqual([session.tradingDate])
  })

  it('quarantines a visit that STARTS at 01:30, having found the previous day’s session', async () => {
    // 01:30 Dubai is 30 minutes before close. The shortest treatment this business sells plus its room
    // turnaround does not fit, so the line is quarantined — and `runs_past_close_with_turnaround` is
    // reachable ONLY once a session has been found, which is the assertion: an instant in no session
    // answers `trading_date_is_not_a_session` instead.
    const halfPastOne = new Date(session.closesAt.getTime() - 30 * 60_000).toISOString()
    const phone = await newCustomer()
    const report = await importFile(visitFile([{ phone, startedAt: halfPastOne }]))
    expect(report.state).toBe('completed')
    expect(await lastQuarantineReason()).toBe(VISIT_QUARANTINES.runsPastCloseWithTurnaround)
  })

  it('quarantines a treatment that FITS but whose room changeover does not', async () => {
    /*
      The case the acceptance line's last four words are about: "nothing past close once turnaround is
      counted". The treatment ends five minutes before close, so a check on the treatment alone admits
      it; the room changeover after it runs fifteen minutes past close, so the session cannot hold the
      delivery. Nothing in PostgreSQL refuses this — `appointment_therapist_no_overlap` and
      `assert_room_capacity` judge overlap, not the session's end — so `resolveVisitTargets` is the only
      thing in front of it, and this is the case that measures that.

      It needs no reservation: a quarantined line inserts nothing.
    */
    const start = new Date(
      session.closesAt.getTime() - (catalogue.durationMinutes + 5) * 60_000,
    ).toISOString()
    const phone = await newCustomer()
    const report = await importFile(
      visitFile([{ phone, startedAt: start, staffReference: spareTherapist() }]),
    )
    expect(report.state).toBe('completed')
    expect(await lastQuarantineReason()).toBe(VISIT_QUARANTINES.runsPastCloseWithTurnaround)
  })

  it('answers trading_date_is_not_a_session for the same wall-clock time outside every session', async () => {
    // The control for the case above. Four hours after close is 06:00 Dubai, which no session covers.
    const outside = new Date(session.closesAt.getTime() + 4 * 60 * 60_000).toISOString()
    const resolution = await resolveVisitTargets(sql, {
      phoneE164: '+971590000001',
      serviceSlug: catalogue.serviceSlug,
      durationMinutes: catalogue.durationMinutes,
      therapistStaffReference: catalogue.staffReferences[0] as string,
      roomCode: catalogue.roomCodes[0] as string,
      startedAt: outside,
      finishedAt: plus(outside, catalogue.durationMinutes),
    })
    expect(resolution.ok).toBe(false)
    expect(resolution.ok ? '' : resolution.reason).toBe(VISIT_QUARANTINES.tradingDateIsNotASession)
  })
})

describe('the domain invariants hold over the imported dataset', () => {
  it('holds no double-booked therapist, measured over every migrated row', async () => {
    const overlaps = await sql<{ pairs: string }[]>`
      select count(*)::text as pairs
        from appointment a
        join appointment b
          on b.therapist_id = a.therapist_id
         and b.id <> a.id
         and b.period && a.period
       where a.migrated and a.holds_resources and b.holds_resources
    `
    expect(Number(overlaps[0]?.pairs ?? '-1')).toBe(0)
  })

  it('and the measurement can report one, which is what makes the zero mean anything', async () => {
    // The control. `appointment_therapist_no_overlap` is an EXCLUDE constraint, so the overlapping row
    // cannot be committed — the assertion is that the ATTEMPT is refused by that constraint, which is
    // what the measured zero above is a consequence of rather than a coincidence.
    const phone = await newCustomer()
    const slot = reserve()
    const first = await importFile(visitFile([{ phone, ...slot }]))
    expect(first.applied).toBe(1)
    const overlapping = visitFile([
      {
        phone,
        ...slot,
        startedAt: plus(slot.startedAt, Math.floor(catalogue.durationMinutes / 2)),
      },
    ])
    await expect(importFile(overlapping)).rejects.toMatchObject({ code: '23P01' })
  })

  it('refuses a room over capacity, which is the trigger and not this importer', async () => {
    const phone = await newCustomer()
    const other = await newCustomer()
    const slot = reserve()
    // Two DIFFERENT therapists, one capacity-1 room, overlapping periods: the therapist constraint
    // cannot fire, so whatever refuses this is `assert_room_capacity`.
    const second = spareTherapist()
    await importFile(visitFile([{ phone, ...slot }]))
    await expect(
      importFile(
        visitFile([
          {
            phone: other,
            roomCode: slot.roomCode,
            staffReference: second,
            startedAt: plus(slot.startedAt, Math.floor(catalogue.durationMinutes / 2)),
          },
        ]),
      ),
    ).rejects.toThrow(/capacity/i)
  })

  it('leaves nothing past close once turnaround is counted, measured over every migrated row', async () => {
    const past = await sql<{ rows: string }[]>`
      select count(*)::text as rows
        from appointment a
        join service_variant v on v.id = a.service_variant_id
        join service s on s.id = v.service_id
        join business_day d on d.trading_date = a.trading_date
       where a.migrated
         and upper(a.period) + make_interval(mins => s.turnaround_minutes) > d.closes_at
    `
    expect(Number(past[0]?.rows ?? '-1')).toBe(0)
  })
})

describe('a migrated visit is history, not revenue and not a booking', () => {
  it('contributes nothing to the ledger, and nothing to the invoiced total', async () => {
    const before = await ledgerCensus()
    const invoicesBefore = await sql<{ count: string }[]>`select count(*)::text from invoice`
    const phone = await newCustomer()
    const report = await importFile(visitFile([{ phone, ...reserve() }]))
    expect(report.applied).toBe(1)
    const after = await ledgerCensus()
    const invoicesAfter = await sql<{ count: string }[]>`select count(*)::text from invoice`
    // A statement line is a directed sum over `journal_line` (ADR 0064), so an import that posts no
    // journal line at all contributes zero to every line of every statement. Asserted as the CENSUS and
    // not as a statement: the census is the measurement that needs no account set, so it cannot be
    // satisfied by a line that happens to net to nought.
    expect(after).toEqual(before)
    expect(invoicesAfter[0]?.count).toBe(invoicesBefore[0]?.count)
  })

  it('carries no VAT figure, because the tax point is outside these books', async () => {
    const rows = await sql<{ rate: number; vat: string; net: string; gross: string }[]>`
      select vat_rate_bp as rate, vat_fils::text as vat, net_fils::text as net,
             gross_price_fils::text as gross
        from appointment where migrated
    `
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.rate).toBe(0)
      expect(row.vat).toBe('0')
      expect(row.net).toBe(row.gross)
    }
  })

  it('refuses every change to its booking facts, by name', async () => {
    const [row] = await sql<{ id: string }[]>`
      select id from appointment where migrated order by created_at desc limit 1
    `
    const id = must(row?.id, 'a migrated appointment')
    // ZY361. This is the defect the flag exists to prevent: `recordAppointmentTransition` knows nothing
    // about reconstruction, so a receptionist completing a visit from June is a plausible accident.
    await expect(
      sql`update appointment set status = 'cancelled_by_salon' where id = ${id}::uuid`,
    ).rejects.toMatchObject({ code: APPOINTMENT_IMPORT_SQLSTATE.migratedAppointmentIsNotLive })
    await expect(
      sql`update appointment set gross_price_fils = 1 where id = ${id}::uuid`,
    ).rejects.toMatchObject({ code: APPOINTMENT_IMPORT_SQLSTATE.migratedAppointmentIsNotLive })
    // ZY362, which is a different remedy and therefore a different code.
    await expect(
      sql`update appointment set migrated = false where id = ${id}::uuid`,
    ).rejects.toMatchObject({ code: APPOINTMENT_IMPORT_SQLSTATE.migratedFlagIsImmutable })
  })

  it('permits an update that changes none of them, which is the control', async () => {
    const [row] = await sql<{ id: string }[]>`
      select id from appointment where migrated order by created_at desc limit 1
    `
    // `promotion_id` is not a booking fact and is not in the guard's list. Without this case the guard
    // would pass every assertion above by refusing all updates, which is a different rule.
    const id = must(row?.id, 'a migrated appointment')
    await sql`update appointment set promotion_id = null where id = ${id}::uuid`
  })

  it('cannot be relabelled onto a live booking, and a live booking cannot be relabelled', async () => {
    // ZY362 from the other direction: a booking taken through the booking path may not become history.
    const [live] = await sql<{ id: string }[]>`
      select id from appointment where not migrated order by created_at desc limit 1
    `
    if (live !== undefined) {
      await expect(
        sql`update appointment set migrated = true where id = ${live.id}::uuid`,
      ).rejects.toMatchObject({ code: APPOINTMENT_IMPORT_SQLSTATE.migratedFlagIsImmutable })
    }
  })

  it('refuses an import record that is rewritten or removed', async () => {
    const [record] = await sql<{ id: string }[]>`
      select id from imported_appointment order by created_at desc limit 1
    `
    const id = must(record?.id, 'an imported-appointment record')
    await expect(
      sql`update imported_appointment set outcome = 'quarantined' where id = ${id}::uuid`,
    ).rejects.toMatchObject({ code: APPOINTMENT_IMPORT_SQLSTATE.importedAppointmentImmutable })
    await expect(
      sql`delete from imported_appointment where id = ${id}::uuid`,
    ).rejects.toMatchObject({ code: APPOINTMENT_IMPORT_SQLSTATE.importedAppointmentImmutable })
  })

  it('refuses a migrated row no import record attests to, at COMMIT', async () => {
    // ZY363. Inserted through raw SQL inside a transaction that is then rolled back, because the whole
    // point is that this arrangement cannot be reached through the importer.
    const [template] = await sql<
      {
        bookingId: string
        tradingDate: string
        serviceVariantId: string
        therapistId: string
        roomId: string
        startsAt: Date
        endsAt: Date
      }[]
    >`
      select booking_id as "bookingId", trading_date::text as "tradingDate",
             service_variant_id as "serviceVariantId", therapist_id as "therapistId",
             room_id as "roomId", lower(period) as "startsAt", upper(period) as "endsAt"
        from appointment where migrated order by created_at desc limit 1
    `
    const row = must(template, 'a migrated appointment to copy')
    // A slot of this suite's own, so the insert is refused by ZY363 at COMMIT rather than by the
    // exclusion constraint immediately — which would be a PASS about the wrong rule.
    const slot = reserve()
    const from = slot.startedAt
    void row.endsAt
    await expect(
      withUnitOfWork(sql, ACTOR, async (uow) => {
        await uow.sql`
          insert into appointment (
            booking_id, trading_date, service_variant_id, shape, therapist_id, room_id, period, status,
            gross_price_fils, net_fils, vat_fils, vat_rate_bp, turnaround_minutes,
            therapist_buffer_minutes, room_places, migrated
          ) values (
            ${row.bookingId}::uuid, ${session.tradingDate}::date,
            ${row.serviceVariantId}::uuid, 'solo',
            (select id from employee where staff_reference = ${slot.staffReference}),
            (select id from rooms where code = ${slot.roomCode}),
            tstzrange(${from}::timestamptz, ${plus(from, 5)}::timestamptz, '[)'),
            'completed', 1000, 1000, 0, 0, 0, 0, 1, true
          )
        `
      }),
    ).rejects.toMatchObject({ code: APPOINTMENT_IMPORT_SQLSTATE.migratedAppointmentIsUnattested })
  })

  it('refuses a migrated row dated in the future', async () => {
    // ZY366, which is what keeps reconstruction out of every forward-looking reader without a second
    // `not migrated` growing in each of them.
    const future = new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString()
    const phone = await newCustomer()
    const resolution = await resolveVisitTargets(sql, {
      phoneE164: e164Of(phone),
      serviceSlug: catalogue.serviceSlug,
      durationMinutes: catalogue.durationMinutes,
      therapistStaffReference: catalogue.staffReferences[0] as string,
      roomCode: catalogue.roomCodes[0] as string,
      startedAt: future,
      finishedAt: plus(future, catalogue.durationMinutes),
    })
    // It may or may not resolve, depending on whether that future instant is a session; either way the
    // raw insert below is what ZY366 is about.
    void resolution
    const [template] = await sql<
      { serviceVariantId: string; therapistId: string; roomId: string; tradingDate: string }[]
    >`
      select service_variant_id as "serviceVariantId", therapist_id as "therapistId",
             room_id as "roomId", trading_date::text as "tradingDate"
        from appointment where migrated order by created_at desc limit 1
    `
    const row = must(template, 'a migrated appointment to copy')
    await expect(
      withUnitOfWork(sql, ACTOR, async (uow) => {
        const [booking] = await uow.sql<{ id: string }[]>`
          insert into booking (customer_id, source)
          select id, 'import' from customer where phone_e164 = ${e164Of(phone)}
          returning id
        `
        await uow.sql`
          insert into appointment (
            booking_id, trading_date, service_variant_id, shape, therapist_id, room_id, period, status,
            gross_price_fils, net_fils, vat_fils, vat_rate_bp, turnaround_minutes,
            therapist_buffer_minutes, room_places, migrated
          ) values (
            ${must(booking?.id, 'the booking just inserted')}::uuid, ${row.tradingDate}::date,
            ${row.serviceVariantId}::uuid, 'solo', ${row.therapistId}::uuid,
            ${row.roomId}::uuid,
            tstzrange(${future}::timestamptz, ${plus(future, 45)}::timestamptz, '[)'),
            'completed', 1000, 1000, 0, 0, 0, 0, 1, true
          )
        `
      }),
    ).rejects.toMatchObject({
      code: APPOINTMENT_IMPORT_SQLSTATE.migratedAppointmentIsNotHistory,
    })
  })

  it('admits only a finished status, and the four it admits are the four the workbook names', async () => {
    const [constraint] = await sql<{ definition: string }[]>`
      select pg_get_constraintdef(oid) as definition
        from pg_constraint where conname = 'appointment_migrated_is_finished'
    `
    expect(constraint).toBeDefined()
    for (const outcome of VISIT_OUTCOMES) {
      expect(constraint?.definition).toContain(outcome)
    }
    // The control: the predicate must NOT admit a live label, or the CHECK would be satisfied by every
    // status and the four names above would be decoration.
    expect(constraint?.definition).not.toContain('in_progress')
    expect(constraint?.definition).not.toContain('rescheduled')
  })
})

describe('a line that cannot be resolved is quarantined, never guessed', () => {
  it('names the reason for an unknown therapist reference, and creates no employee', async () => {
    const employeesBefore = await sql<{ count: string }[]>`select count(*)::text from employee`
    const phone = await newCustomer()
    const report = await importFile(
      visitFile([{ phone, ...reserve(), staffReference: 'no-such-reference' }]),
    )
    expect(report.state).toBe('completed')
    expect(await lastQuarantineReason()).toBe(VISIT_QUARANTINES.therapistReferenceUnknown)
    const employeesAfter = await sql<{ count: string }[]>`select count(*)::text from employee`
    // The acceptance line's own words: "rather than assigned to a placeholder". A placeholder therapist
    // would put a treatment somebody else performed into a named person's commission base.
    expect(employeesAfter[0]?.count).toBe(employeesBefore[0]?.count)
  })

  it('names the reason for an unknown room code, and creates no room', async () => {
    const roomsBefore = await sql<{ count: string }[]>`select count(*)::text from rooms`
    const phone = await newCustomer()
    await importFile(visitFile([{ phone, ...reserve(), roomCode: 'no-such-room' }]))
    expect(await lastQuarantineReason()).toBe(VISIT_QUARANTINES.roomCodeUnknown)
    const roomsAfter = await sql<{ count: string }[]>`select count(*)::text from rooms`
    expect(roomsAfter[0]?.count).toBe(roomsBefore[0]?.count)
  })

  it('names the reason for a service nothing sells, and files it as nothing else', async () => {
    const phone = await newCustomer()
    await importFile(visitFile([{ phone, ...reserve(), serviceSlug: 'no-such-service' }]))
    expect(await lastQuarantineReason()).toBe(VISIT_QUARANTINES.serviceNotInTheCatalogue)
  })

  it('names the reason for a number nothing in this database holds, and creates no customer', async () => {
    const customersBefore = await sql<{ count: string }[]>`select count(*)::text from customer`
    const unimported = syntheticPerson(BASE_INDEX + 9_000).phone
    await importFile(visitFile([{ phone: unimported, ...reserve() }]))
    expect(await lastQuarantineReason()).toBe(VISIT_QUARANTINES.customerNotImported)
    const customersAfter = await sql<{ count: string }[]>`select count(*)::text from customer`
    // H-MIG-04 is the only door into `customer`: it is where the consent floor is enforced and where
    // the contact record ZY273 holds to the facts is written. A second door would have none of that.
    expect(customersAfter[0]?.count).toBe(customersBefore[0]?.count)
  })

  it('names the reason for a cell that is not a number at all', async () => {
    await importFile(visitFile([{ phone: 'no number recorded', ...reserve() }]))
    expect(await lastQuarantineReason()).toBe(VISIT_QUARANTINES.customerNotImported)
  })

  it('quarantines rather than failing the run, so the rest of the file still imports', async () => {
    const phone = await newCustomer()
    const good = await newCustomer()
    const before = await readImportedAppointmentCounts(sql)
    const report = await importFile(
      visitFile([
        { phone, ...reserve(), roomCode: 'no-such-room' },
        { phone: good, ...reserve() },
      ]),
    )
    expect(report.state).toBe('completed')
    expect(report.applied).toBe(2)
    const after = await readImportedAppointmentCounts(sql)
    // A delta, never a total: `imported_appointment` only grows (brief rule 9).
    expect(after.imported - before.imported).toBe(1)
    expect(after.quarantined - before.quarantined).toBe(1)
  })

  it('leaves no quarantine reason unreachable, and every recorded one is in the vocabulary', async () => {
    const used = await sql<{ reason: string }[]>`
      select distinct quarantine_reason as reason from imported_appointment
       where quarantine_reason is not null
    `
    for (const row of used) {
      expect(VISIT_QUARANTINE_REASONS).toContain(row.reason)
    }
    expect(used.length).toBeGreaterThan(0)
  })
})

describe('every row the import wrote is traceable to its line', () => {
  it('leaves no unprovenanced row in any of its three target tables', async () => {
    for (const relation of VISITS_IMPORTER_TARGETS) {
      const unprovenanced = await unprovenancedRowIds(sql, relation)
      if (relation === 'public.imported_appointment' || relation === 'public.appointment') {
        // `appointment` and `booking` hold rows from the seed and from every booking suite, so the claim
        // that can be made about them is about the MIGRATED ones; `imported_appointment` holds nothing
        // but this import's rows, so for it the claim is total.
        if (relation === 'public.imported_appointment') expect(unprovenanced).toEqual([])
      }
    }
    const orphans = await sql<{ rows: string }[]>`
      select count(*)::text as rows
        from appointment a
       where a.migrated
         and not exists (
           select 1 from import_staging.import_provenance p
            where p.target_table = 'appointment' and p.target_id = a.id::text
         )
    `
    expect(Number(orphans[0]?.rows ?? '-1')).toBe(0)
  })

  it('and the measurement is not vacuous: a row with no provenance IS reported', async () => {
    // The control. Counting rows that DO have provenance proves the predicate is doing work; a zero
    // from a query that matched nothing at all would look identical.
    const provenanced = await sql<{ rows: string }[]>`
      select count(*)::text as rows
        from appointment a
        join import_staging.import_provenance p
          on p.target_table = 'appointment' and p.target_id = a.id::text
       where a.migrated
    `
    expect(Number(provenanced[0]?.rows ?? '0')).toBeGreaterThan(0)
  })

  it('rehearses without changing anything', async () => {
    const phone = await newCustomer()
    const before = await readImportedAppointmentCounts(sql)
    const report = await importFile(visitFile([{ phone, ...reserve() }]), 'dry-run')
    expect(report.committed).toBe(false)
    expect(report.applied).toBe(1)
    expect(await readImportedAppointmentCounts(sql)).toEqual(before)
  })
})

describe('the generated file is what the parser demands', () => {
  it('writes a header the parser accepts and refuses one it did not write', async () => {
    const phone = await newCustomer()
    const file = visitFile([{ phone, ...reserve() }])
    expect(file).toContain(VISIT_HEADER)
    const broken = file.replace(VISIT_HEADER, VISIT_HEADER.replace('outcome', 'how_it_ended'))
    await expect(importFile(broken)).rejects.toThrow(/not the generated one/)
  })
})
