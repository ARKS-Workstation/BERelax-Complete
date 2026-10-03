import {
  ASIA_DUBAI,
  type Instant,
  instantFromIso,
  localDate,
  normalisePhone,
  PROVISIONAL_WINBACK_DAYS,
  STOCK_JOURNEY_KEY_LIST,
  STOCK_JOURNEY_KEYS,
  serialiseFlowDefinition,
  stockJourneys,
  toLocal,
  validateFlowDefinition,
  WINBACK_WORKED_EXAMPLE,
  winbackDue,
} from '@berelax/core'
import {
  type Actor,
  createConnection,
  issueInvoice,
  readCurrentTemplateClasses,
  type Sql,
  seedStockFlows,
  withUnitOfWork,
} from '@berelax/db'
import { FIXTURE_HOURS, invoiceFixture, syntheticPerson } from '@berelax/fixtures'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readBirthdayCandidates } from './triggers/birthday.ts'
import {
  readReviewCandidates,
  runReviewSolicitationTrigger,
} from './triggers/review-solicitation.ts'
import { readWinbackCandidates, runWinbackTrigger } from './triggers/winback.ts'

/**
 * C-AUTO-11 — the three stock journeys, their triggers, and the facts the acceptance lines name.
 *
 * Every claim here is about the PAIR. The journeys are composed in `@berelax/core` through C-AUTO-09's
 * typed composer and their documents are judged by `packages/core/src/automation/journeys.test.ts` with
 * no database at all; the win-back arithmetic and its committed worked example are
 * `winback.test.ts`'s. What this file drives is the composition: the seeded rows, the three triggers'
 * eligibility over real appointments and invoices, the schema's refusal to hold a birth year, and the
 * statement count of the birthday pass.
 *
 * ## The probe contacts are not removed, and the appointments are
 *
 * The contacts carry `consent` rows, and `consent` is append-only (ADR 0008, brief rule 9) — so a
 * deleted customer would leave its consent record pointing at nothing. They are created idempotently
 * from one number band and left, exactly as `campaign.itest.ts` does and for the same reason. The
 * bookings, appointments, invoices and flow runs this file creates ARE removed, by predicate, in the
 * order the foreign keys allow.
 *
 * `flow_definition` is append-only too, and the three seeded journeys are the SEED's rows rather than
 * this file's: it asserts them and never rewrites them.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

let sql: Sql

/** This file's own keys and notes. One marker, so every clean-up statement can carry a predicate. */
const MARKER = 'cauto11-itest'

/** The first `syntheticPerson` index of this file's number band. Distinct from every other suite's. */
const BAND_FIRST = 7_200_001
const CONTACTS = 6

/** The trading date this file's appointments live on. Far future, so nothing seeded shares it. */
const TRADING_DATE = '2099-12-01'
const GROSS_FILS = 10_000
const NET_FILS = 9_524
const VAT_FILS = 476

const ACTOR: Actor = { kind: 'system', label: 'C-AUTO-11 fixture' }

/**
 * The therapist every appointment here is assigned to.
 *
 * A literal uuid of this file's own, as `appointment-lifecycle.itest.ts` uses: `appointment.therapist_id`
 * carries no foreign key, and 0024's exclusion constraint means a therapist cannot be in two places — so
 * a shared id would make this file collide with whatever else is using it. Nobody is named: a therapist
 * has no display name until an admin sets one (ADR 0020).
 */
const THERAPIST_ID = '00000000-0000-4000-8000-0000000c1101'

let contactIds: readonly string[] = []
let bookingIds: readonly string[] = []
const appointments = new Map<string, string>()
const invoices: string[] = []

const contact = (index: number): string => {
  const id = contactIds[index]
  if (id === undefined) throw new Error(`no probe contact at ${index}`)
  return id
}

beforeAll(async () => {
  sql = createConnection({ url, max: 6 })

  const people = Array.from({ length: CONTACTS }, (_, index) =>
    normalisePhone(syntheticPerson(BAND_FIRST + index).phone),
  )
  await sql`
    insert into customer (phone_e164, locale, created_via)
    select phone, 'en', 'front_desk' from unnest(${people as string[]}::text[]) as t(phone)
    on conflict (phone_e164) do nothing
  `
  const rows = await sql<{ id: string }[]>`
    select id::text as id from customer
     where phone_e164 = any(${people as string[]}::text[]) order by phone_e164
  `
  contactIds = rows.map((row) => row.id)
  if (contactIds.length !== CONTACTS) {
    throw new Error(`expected ${CONTACTS} probe contacts, found ${contactIds.length}`)
  }

  // Marketing consent on SMS for contacts 0 to 4; contact 5 has NONE, which is the control for both
  // consent-conditioned journeys. Idempotent on `consent_one_record_per_instant`, and resting on the
  // published wording because `ImportIsNotAnOptIn` (0056) refuses a grant that names none.
  const [wording] = await sql<{ id: string }[]>`
    select id::text as id from consent_wording
     where purpose = 'marketing' order by version desc limit 1
  `
  if (wording === undefined)
    throw new Error('no marketing consent wording is published; run pnpm seed')
  await sql`
    insert into consent (contact_customer_id, channel, purpose, kind, recorded_at,
                         consent_wording_id, wording_hash, capture_source, capture_actor_kind,
                         capture_actor_label, capture_locale, created_at)
    select t.id::uuid, 'sms'::message_channel, 'marketing', 'granted'::consent_kind,
           '2026-09-18T10:00:00.000Z'::timestamptz, ${wording.id}::uuid, w.content_hash,
           'booking_form', 'customer', ${`${MARKER} fixture`}, 'en',
           '2026-09-18T10:00:00.000Z'::timestamptz
      from unnest(${contactIds.slice(0, 5) as string[]}::text[]) as t(id)
      cross join consent_wording w
     where w.id = ${wording.id}::uuid
    on conflict (contact_customer_id, channel, purpose, kind, recorded_at) do nothing
  `

  // The trading day this file's appointments live on, because `appointment.trading_date` references
  // `business_day`. `duration_seconds` and `crosses_midnight` are generated; `source` says where the row
  // came from, and the only two values are 'weekly' and 'override'.
  await sql`
    insert into business_day (trading_date, opens_at, closes_at, source)
    values (
      ${TRADING_DATE}::date,
      ${`${TRADING_DATE} 11:00:00+04`}::timestamptz,
      ${'2099-12-02 02:00:00+04'}::timestamptz,
      'override'
    )
    on conflict (trading_date) do nothing
  `

  const [variant] = await sql<{ id: string }[]>`
    select v.id::text as id from service_variant v order by v.id limit 1
  `
  const [room] = await sql<{ id: string }[]>`select id::text as id from rooms order by id limit 1`
  if (variant === undefined || room === undefined) {
    throw new Error('the fixture salon has no service variant or room; run pnpm seed')
  }

  const bookings: string[] = []
  for (const customerId of contactIds) {
    const [booking] = await sql<{ id: string }[]>`
      insert into booking (customer_id, source, notes)
      values (${customerId}::uuid, 'walk_in', ${`${MARKER} booking`})
      returning id::text as id
    `
    bookings.push(booking?.id ?? '')
  }
  bookingIds = bookings

  /** One appointment at `status`, in its own 45 minutes, so nothing collides on room or therapist. */
  let slot = 0
  const appointmentAt = async (bookingId: string, status: string): Promise<string> => {
    const startMinutes = 11 * 60 + slot * 45
    slot += 1
    const fmt = (minutes: number): string => {
      const dayOffset = Math.floor(minutes / (24 * 60))
      const hh = String(Math.floor((minutes % (24 * 60)) / 60)).padStart(2, '0')
      const mm = String(minutes % 60).padStart(2, '0')
      // Trading runs 11:00-02:00, so a late slot belongs to the NEXT calendar day and the SAME trading
      // date, which is the whole reason `trading_date` is a stored column.
      const date = dayOffset === 0 ? TRADING_DATE : '2099-12-02'
      return `${date} ${hh}:${mm}:00+04`
    }
    const [row] = await sql<{ id: string }[]>`
      insert into appointment (
        booking_id, trading_date, service_variant_id, shape, therapist_id, room_id, period, status,
        delivery_id, room_places, turnaround_minutes, therapist_buffer_minutes,
        gross_price_fils, net_fils, vat_fils, vat_rate_bp
      ) values (
        ${bookingId}::uuid, ${TRADING_DATE}::date, ${variant.id}::uuid, 'solo'::service_shape,
        ${THERAPIST_ID}::uuid, ${room.id}::uuid,
        ${`[${fmt(startMinutes)},${fmt(startMinutes + 45)})`}::tstzrange,
        ${status}::appointment_status,
        gen_random_uuid(), 1, 20, 10, ${GROSS_FILS}, ${NET_FILS}, ${VAT_FILS}, 500
      )
      returning id::text as id
    `
    return row?.id ?? ''
  }

  // The four eligibility cases the acceptance line names, one contact each.
  appointments.set('completed_paid', await appointmentAt(bookingIds[0] ?? '', 'completed'))
  appointments.set('completed_unpaid', await appointmentAt(bookingIds[1] ?? '', 'completed'))
  appointments.set('no_show_paid', await appointmentAt(bookingIds[2] ?? '', 'no_show'))
  appointments.set('confirmed', await appointmentAt(bookingIds[3] ?? '', 'confirmed'))

  // The series counter, set one past the highest number this series has issued in the period. Idempotent,
  // and what `issue-credit-note.itest.ts` does for the same reason: the counter is not an ordering claim.
  await sql`
    update document_series s
       set period_key = '2099',
           next_number = coalesce(
             (select max(i.number) from invoice i
               where i.series_code = s.code and i.period_key = '2099'),
             0
           ) + 1
     where s.code = 'TAX-INV'
  `

  /** An invoice against one appointment, paid in full or not at all. */
  const invoiceFor = async (
    customerId: string,
    appointmentId: string,
    paid: boolean,
  ): Promise<void> => {
    const fixture = invoiceFixture({
      supplyAt: instantFromIso(`${TRADING_DATE}T12:00:00+04:00`),
      issuedAt: instantFromIso(`${TRADING_DATE}T12:30:00+04:00`),
      customerId,
      hoursFor: FIXTURE_HOURS,
      lines: [{ descriptionEn: 'C-AUTO-11 fixture line', quantity: 1, unitGrossFils: GROSS_FILS }],
    })
    const issued = await withUnitOfWork(sql, ACTOR, (uow) => issueInvoice(uow, fixture.input))
    invoices.push(issued.id)
    await sql`
      insert into invoice_appointment (invoice_id, appointment_id, line_no)
      values (${issued.id}::uuid, ${appointmentId}::uuid, 1)
    `
    if (!paid) return
    await sql`
      insert into payment (invoice_id, tender_no, tender_kind, posting_account_code,
                           amount_fils, trading_date)
      values (${issued.id}::uuid, 1, 'cash', '1010', ${GROSS_FILS}, ${TRADING_DATE}::date)
    `
  }

  await invoiceFor(contact(0), appointments.get('completed_paid') ?? '', true)
  await invoiceFor(contact(1), appointments.get('completed_unpaid') ?? '', false)
  await invoiceFor(contact(3), appointments.get('confirmed') ?? '', true)
  await invoiceFor(contact(2), appointments.get('no_show_paid') ?? '', true)
  // The `confirmed` appointment is PAID, which is a prepayment and a real state — and it is what makes
  // its case about the STATUS alone. With no invoice it would be excluded by the settlement join and the
  // status filter would never be reached, so a widened status filter would not have been caught: gate
  // case 187f is what found that, by widening the filter and watching nothing fail.

  // Contact 4's birthday is today in the business zone. Day and month, because there is nowhere to put
  // a year (0155).
  const today = toLocal(Date.now() as Instant, ASIA_DUBAI)
  await sql`
    update customer
       set birth_month = ${Number(today.date.slice(5, 7))},
           birth_day = ${Number(today.date.slice(8, 10))},
           updated_at = now()
     where id = ${contact(4)}::uuid
  `
  // And contact 5's is today too, so the consent control is a real control: the only thing separating
  // them is the consent row.
  await sql`
    update customer
       set birth_month = ${Number(today.date.slice(5, 7))},
           birth_day = ${Number(today.date.slice(8, 10))},
           updated_at = now()
     where id = ${contact(5)}::uuid
  `
}, 180_000)

afterAll(async () => {
  if (sql === undefined) return
  // This file's own rows, in the order the foreign keys allow, every statement predicated. The flow runs
  // and enrolments go first because they reference the contacts; the invoices stay — `invoice` refuses
  // DELETE (ADR 0008) and nothing in this repository can remove one, which is why this file issues them
  // against a trading date in 2099 that no report's window reaches.
  await sql`
    delete from flow_enrolment where customer_id = any(${contactIds as string[]}::uuid[])
  `
  await sql`delete from booking where notes = ${`${MARKER} booking`}`
  await sql`
    update customer set birth_day = null, birth_month = null
     where id = any(${contactIds as string[]}::uuid[])
  `
  await sql.end({ timeout: 5 })
}, 60_000)

// ------------------------------------------------------------------------------------------------
// The three journeys are seeded rows
// ------------------------------------------------------------------------------------------------

describe('acceptance — all three journeys exist as flow_definition rows in the seed', () => {
  it('all three, active, each with the composed document as its live version', async () => {
    const rows = await sql<{ flowKey: string; isActive: boolean; versions: number }[]>`
      select f.flow_key as "flowKey", f.is_active as "isActive",
             (select count(*)::int from flow_definition d where d.flow_id = f.id) as versions
        from flow f
       where f.flow_key = any(${[...STOCK_JOURNEY_KEY_LIST] as string[]}::text[])
       order by f.flow_key
    `
    expect(rows.map((row) => row.flowKey).sort()).toEqual([...STOCK_JOURNEY_KEY_LIST].sort())
    for (const row of rows) {
      expect(row.isActive, `${row.flowKey} is active`).toBe(true)
      // At least one, and NOT exactly one. The idempotence claim is tested below against a RE-SEED
      // rather than against the version count, because the count is a fact about this database's
      // history: `flow_definition` is append-only, a later unit may legitimately publish a version 2 of
      // a stock journey, and gate case 187h deliberately makes the seeder publish and cannot take the
      // rows back. An assertion on the count would make this suite's answer depend on what ran before
      // it — which is brief rule 12's defect, in the one table that cannot be cleaned up after.
      expect(row.versions, `${row.flowKey} has a published version`).toBeGreaterThanOrEqual(1)
    }
  })

  it('the stored document is byte-identical to the composed one', async () => {
    const templates = await readCurrentTemplateClasses(sql)
    const composed = stockJourneys(templates)
    expect(composed).not.toBeNull()
    for (const journey of composed ?? []) {
      const [row] = await sql<{ definition: unknown }[]>`
        select d.definition from flow_definition d
          join flow f on f.id = d.flow_id
         where f.flow_key = ${journey.key}
         order by d.version desc limit 1
      `
      expect(row).toBeDefined()
      // Re-validated, then re-serialised: `jsonb` normalises key order, so the comparison is made over
      // the canonical form of what came back rather than over its raw text.
      const verdict = validateFlowDefinition(row?.definition, { templates })
      expect(verdict.ok, journey.key).toBe(true)
      if (!verdict.ok) continue
      expect(verdict.canonical).toBe(serialiseFlowDefinition(journey))
    }
  })

  it('seeding a second time publishes nothing', async () => {
    const templates = await readCurrentTemplateClasses(sql)
    const journeys = stockJourneys(templates) ?? []
    const result = await seedStockFlows(sql, {
      flows: journeys.map((journey) => ({
        flowKey: journey.key,
        title: journey.title,
        definition: journey,
      })),
      validate: (candidate) => validateFlowDefinition(candidate, { templates }),
      publishedAtIso: '2026-09-18T10:00:00.000Z',
    })
    expect(result.published).toEqual([])
    expect([...result.unchanged].sort()).toEqual([...STOCK_JOURNEY_KEY_LIST].sort())
  })

  it('refuses to seed with no validator rather than writing an unchecked document', async () => {
    await expect(
      seedStockFlows(sql, { flows: [], publishedAtIso: '2026-09-18T10:00:00.000Z' }),
    ).rejects.toThrow(/no validator/)
  })
})

// ------------------------------------------------------------------------------------------------
// Review solicitation: COMPLETED and paid, never CONFIRMED
// ------------------------------------------------------------------------------------------------

describe('acceptance — review solicitation enrols only on a COMPLETED and paid appointment', () => {
  const candidatesFor = async () => {
    return readReviewCandidates(sql, {
      sinceTradingDate: TRADING_DATE,
      untilTradingDate: TRADING_DATE,
    })
  }

  it('offers the completed, paid contact — which is the control for the three refusals', async () => {
    const candidates = await candidatesFor()
    expect(candidates.map((candidate) => candidate.customerId)).toContain(contact(0))
  })

  it('offers nobody for a no-show, even one whose invoice is paid', async () => {
    const candidates = await candidatesFor()
    expect(candidates.map((candidate) => candidate.customerId)).not.toContain(contact(2))
  })

  it('offers nobody for an unpaid completion', async () => {
    const candidates = await candidatesFor()
    expect(candidates.map((candidate) => candidate.customerId)).not.toContain(contact(1))
  })

  it('offers nobody for a CONFIRMED appointment, which is the status the clause names', async () => {
    const candidates = await candidatesFor()
    expect(candidates.map((candidate) => candidate.customerId)).not.toContain(contact(3))
  })

  it('enrols the eligible contact and nobody else, and is safe to run twice', async () => {
    const args = {
      sinceTradingDate: TRADING_DATE,
      untilTradingDate: TRADING_DATE,
      at: new Date('2026-09-18T10:00:00.000Z'),
    }
    const first = await runReviewSolicitationTrigger(sql, args)
    expect(first.refused).toEqual([])
    expect(first.enrolled).toBeGreaterThanOrEqual(1)

    // The second pass is the at-least-once claim: `already_enrolled` is an OUTCOME and not a failure, so
    // a sweep delivered twice enrols nobody twice.
    const second = await runReviewSolicitationTrigger(sql, args)
    expect(second.enrolled).toBe(0)
    expect(second.alreadyEnrolled).toBe(first.considered)

    const enrolled = await sql<{ customerId: string }[]>`
      select e.customer_id as "customerId" from flow_enrolment e
        join flow f on f.id = e.flow_id
       where f.flow_key = ${STOCK_JOURNEY_KEYS.reviewSolicitation}
         and e.customer_id = any(${contactIds as string[]}::uuid[])
    `
    expect(enrolled.map((row) => row.customerId)).toEqual([contact(0)])
  }, 60_000)
})

// ------------------------------------------------------------------------------------------------
// Win-back: business_day arithmetic
// ------------------------------------------------------------------------------------------------

describe('acceptance — win-back is computed on business_day arithmetic', () => {
  it('the committed worked example measures from the PREVIOUS business day', () => {
    // The same committed example `winback.test.ts` asserts, re-asserted here against the value rather
    // than against a literal: 01:30 belongs to the session that opened at 11:00 the previous day.
    const decision = winbackDue({
      lastVisitEndedAt: instantFromIso(WINBACK_WORKED_EXAMPLE.lastVisitEndedAtIso),
      hoursFor: FIXTURE_HOURS,
      today: WINBACK_WORKED_EXAMPLE.dueOn,
      intervalDays: PROVISIONAL_WINBACK_DAYS,
    })
    expect(decision.kind).toBe('due')
    if (decision.kind !== 'due') return
    expect(decision.lastVisitBusinessDay).toBe(WINBACK_WORKED_EXAMPLE.businessDay)
    expect(decision.dueOn).toBe(WINBACK_WORKED_EXAMPLE.dueOn)
    // The control, committed beside it: the calendar-dated answer is a different day.
    expect(WINBACK_WORKED_EXAMPLE.calendarDatedWouldBe).not.toBe(WINBACK_WORKED_EXAMPLE.dueOn)
  })

  it('reads each contact’s last COMPLETED visit as an instant, never as a trading date', async () => {
    const candidates = await readWinbackCandidates(sql)
    const mine = new Map(
      candidates
        .filter((candidate) => contactIds.includes(candidate.customerId))
        .map((candidate) => [candidate.customerId, candidate.lastVisitEndedAt]),
    )
    // Contact 0's visit COMPLETED, so there is an instant. Contacts 2 and 3 did not complete, so there
    // is none — which is the difference a `trading_date` column could not express, because the row has
    // one either way.
    expect(mine.get(contact(0))).not.toBeNull()
    expect(mine.get(contact(2))).toBeNull()
    expect(mine.get(contact(3))).toBeNull()
    // Contact 5 has no consent, so the pre-filter excludes them entirely.
    expect(mine.has(contact(5))).toBe(false)
  }, 60_000)

  it('does not enrol a contact whose visit is recent', async () => {
    // "Today" is the day after this file's appointments, so nobody here is 90 days lapsed.
    const outcome = await runWinbackTrigger(sql, {
      today: localDate('2099-12-02'),
      hoursFor: FIXTURE_HOURS,
      intervalDays: PROVISIONAL_WINBACK_DAYS,
      at: new Date('2026-09-18T10:00:00.000Z'),
    })
    const enrolled = await sql<{ n: string }[]>`
      select count(*)::text as n from flow_enrolment e join flow f on f.id = e.flow_id
       where f.flow_key = ${STOCK_JOURNEY_KEYS.winback}
         and e.customer_id = ${contact(0)}::uuid
    `
    expect(Number(enrolled[0]?.n ?? '-1')).toBe(0)
    expect(outcome.refused).toEqual([])
  }, 60_000)

  it('enrols the same contact once the interval has passed', async () => {
    // The control for the case above. 2100-04-01 is well past 2099-12-01 plus ninety days.
    const outcome = await runWinbackTrigger(sql, {
      today: localDate('2100-04-01'),
      hoursFor: FIXTURE_HOURS,
      intervalDays: PROVISIONAL_WINBACK_DAYS,
      at: new Date('2026-09-18T10:00:00.000Z'),
    })
    expect(outcome.refused).toEqual([])
    const enrolled = await sql<{ n: string }[]>`
      select count(*)::text as n from flow_enrolment e join flow f on f.id = e.flow_id
       where f.flow_key = ${STOCK_JOURNEY_KEYS.winback}
         and e.customer_id = ${contact(0)}::uuid
    `
    expect(Number(enrolled[0]?.n ?? '0')).toBe(1)
  }, 60_000)
})

// ------------------------------------------------------------------------------------------------
// Birthday: day and month only, and never the clinical schema
// ------------------------------------------------------------------------------------------------

describe('acceptance — birthday journeys use day and month only', () => {
  it('the customer table has NO birth-year column, by any spelling', async () => {
    const rows = await sql<{ columnName: string }[]>`
      select column_name as "columnName" from information_schema.columns
       where table_schema = 'public' and table_name = 'customer'
    `
    const names = rows.map((row) => row.columnName)
    // The control first: the two columns that DO exist, so this is a claim about an absence beside a
    // presence rather than a query that matched nothing.
    expect(names).toContain('birth_day')
    expect(names).toContain('birth_month')
    for (const forbidden of [
      'birth_year',
      'birthdate',
      'birth_date',
      'date_of_birth',
      'dob',
      'age',
    ]) {
      expect(names, `customer must not carry ${forbidden}`).not.toContain(forbidden)
    }
  })

  it('refuses a birthday that is not a real calendar day, and one half of a pair', async () => {
    const probe = async (month: number | null, day: number | null): Promise<string | null> => {
      try {
        await sql`
          update customer set birth_month = ${month}, birth_day = ${day}
           where id = ${contact(3)}::uuid
        `
        await sql`
          update customer set birth_month = null, birth_day = null where id = ${contact(3)}::uuid
        `
        return null
      } catch (error) {
        return typeof (error as { code?: unknown }).code === 'string'
          ? (error as { code: string }).code
          : null
      }
    }
    // 30 February is not a day. 31 April is not a day. A month with no day is a birthday nobody can
    // send on, and a day with no month fires twelve times a year.
    expect(await probe(2, 30)).toBe('23514')
    expect(await probe(4, 31)).toBe('23514')
    expect(await probe(5, null)).toBe('23514')
    expect(await probe(null, 14)).toBe('23514')
    // The control: 29 February IS a real birthday and is accepted. Y9-birthday-leap owns the send rule.
    expect(await probe(2, 29)).toBeNull()
  })

  it('finds the contact whose day and month are today, and not the one with no consent', async () => {
    const today = toLocal(Date.now() as Instant, ASIA_DUBAI)
    const candidates = await readBirthdayCandidates(sql, {
      month: Number(today.date.slice(5, 7)),
      day: Number(today.date.slice(8, 10)),
    })
    const ids = candidates.map((candidate) => candidate.customerId)
    expect(ids).toContain(contact(4))
    // The control, and the only thing separating the two contacts is the consent row.
    expect(ids).not.toContain(contact(5))
  })

  it('never reads the clinical schema, proved by every statement the pass issues', async () => {
    const statements: string[] = []
    // A recording wrapper around the connection, so the claim is about the statements that RAN rather
    // than about the source somebody read. A pass whose statement count depended on its input could not
    // be held to a list of tables at all, which is why the query is one statement.
    const recorder = new Proxy(sql as unknown as Record<string, unknown>, {
      apply(target, thisArg, args: unknown[]) {
        const strings = args[0] as readonly string[]
        statements.push(strings.join(' ? '))
        return Reflect.apply(target as never, thisArg, args as never)
      },
      get(target, property) {
        return Reflect.get(target, property)
      },
    }) as unknown as Sql

    const today = toLocal(Date.now() as Instant, ASIA_DUBAI)
    await readBirthdayCandidates(recorder, {
      month: Number(today.date.slice(5, 7)),
      day: Number(today.date.slice(8, 10)),
    })

    // ONE statement. Counted, because the assertion below is a difference against what was recorded and
    // a difference against nothing is empty (ADR 0002).
    expect(statements).toHaveLength(1)
    const text = statements.join('\n').toLowerCase()
    expect(text).toContain('birth_month')
    expect(text).not.toContain('clinical.')
    for (const table of [
      'intake_submission',
      'treatment_note',
      'contraindication_flag',
      'treatment_consent',
      'step_up_grant',
    ]) {
      expect(text, `the birthday pass must not read ${table}`).not.toContain(table)
    }
  })
})
