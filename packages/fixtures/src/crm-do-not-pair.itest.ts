import {
  type Instant,
  instantFromIso,
  mayChangeBlocklist,
  normalisePhone,
  recheckShapeAssignment,
} from '@berelax/core'
import {
  type Actor,
  type BlocklistAuthoriser,
  type BookingDeliveryInput,
  bookingRefusalOf,
  bookSlot,
  type CreateBookingInput,
  createConnection,
  doNotPairExclusion,
  ensureCustomer,
  liftDoNotPair,
  readAvailabilityFacts,
  type Sql,
  setDoNotPair,
  type TherapistExclusion,
  therapistPoolCtes,
  withUnitOfWork,
} from '@berelax/db'
import { requiredSkillFor } from '@berelax/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { syntheticPerson } from './synthetic.ts'

/**
 * C-CRM-01 — the therapist do-not-pair flag, honoured by the scheduler and invisible to the client.
 *
 * The acceptance line is "a therapist do-not-pair (therapist_id, customer_id) flag removes that pairing
 * from availability results for that customer". This file proves it at the two places a pairing can be
 * made: the availability READ (`therapistPoolCtes`, and the one-statement `readAvailabilityFacts` that
 * composes the same fragment) and the booking WRITE (`bookSlot`, which re-applies the read model inside
 * its transaction). A read-only guard would be a page that stops offering the therapist and a POST that
 * still books them.
 *
 * ## Why every assertion here is about a LIST of exclusions
 *
 * M-VAT-10 adds a second, independent exclusion to this same path. Two units inlining a condition into
 * one `where` is the merge that silently keeps one of them, and the one that is dropped fails nothing —
 * an availability query that offers a therapist it should not offer returns MORE slots. So the exclusion
 * is a value (`TherapistExclusion`, M-VAT-10's shape and now the one both units use), the pool composes
 * a LIST, and the last describe block asserts this unit's exclusion still holds with an unrelated one in
 * play, in both orders, and alongside a therapist excluded by the pool's own reason machinery.
 *
 * The stand-in for the other unit's exclusion REPORTS a reason, because theirs does. That asymmetry is
 * the point of `reason: string | null` and it is asserted directly: one exclusion in the same list names
 * its reason in the answer while this one leaves no trace at all.
 *
 * ## The exclusion is SILENT, and that is asserted
 *
 * An excluded therapist appears in neither `therapists` nor `excluded`. The pool's `reason` column
 * travels — it reaches `AvailabilityFacts.excluded` and any caller that renders "why can I not book" —
 * so a reported reason would tell the customer which therapist will not work with them. That is the
 * disclosure the flag exists to prevent, and it is also a fact about an employee. Every case below
 * checks the `excluded` array as well as the `therapists` array for exactly that, and
 * `names no reason anywhere in the facts a customer-facing DTO is built from` pins it over the whole
 * serialised answer rather than over one field, so filling the reason in later fails here.
 *
 * ## Isolation
 *
 * `2099-09-14` is used by no other suite and no gate, every read narrows `employeeIds` to the employees
 * this file created, and the customer is `syntheticPerson`, on the unallocated `+971 59` prefix. The
 * therapists have no display name: `staff_reference` is a handle, never a name (ADR 0020).
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

const TRADING_DATE = '2099-09-14'
const NEXT_DAY = '2099-09-15'
const MARKER = 'ccrm01 do-not-pair itest'
const MANAGER = 'manager'
const ACTOR: Actor = { kind: 'staff', label: 'Manager (fixture)' }
const CUSTOMER = syntheticPerson(4_401)
const OTHER_CUSTOMER = syntheticPerson(4_402)

const dubai = (day: string, hhmm: string): string => `${day} ${hhmm}:00+04`
const at = (hhmm: string): Instant => instantFromIso(`${TRADING_DATE}T${hhmm}:00+04:00`)

/** 25,000 fils gross, VAT-inclusive, with VAT as the remainder so the sum is exact (ADR 0007). */
const GROSS_FILS = 25_000
const NET_FILS = 23_810
const VAT_FILS = GROSS_FILS - NET_FILS

let sql: Sql
let roomId: string
let variantId: string
let customerId: string
let otherCustomerId: string
const staff = new Map<string, string>()
const shiftIds: string[] = []
let keySeed = 0

const idOf = (reference: string): string => {
  const id = staff.get(reference)
  if (id === undefined) throw new Error(`no fixture employee ${reference}`)
  return id
}
const allIds = (): string[] => [...staff.values()]

/**
 * `mayChangeBlocklist` from `@berelax/core`, as the port `packages/db` declares.
 *
 * `satisfies` and not a cast: `packages/db` may not import `packages/core`, so the authoriser is two
 * declarations of one shape, and this line is what makes a change to either a `pnpm typecheck` failure
 * rather than a role check that stopped checking.
 */
const authorise = mayChangeBlocklist satisfies BlocklistAuthoriser

async function addEmployee(args: {
  readonly reference: string
  readonly documents?: readonly { readonly type: string; readonly expiresOn: string }[]
}): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into employee (staff_reference, gender, employed_from, notes)
    values (${args.reference}, 'female', '2099-01-01', ${MARKER})
    returning id
  `
  const id = (row as { id: string }).id
  staff.set(args.reference, id)
  await sql`insert into employee_skill (employee_id, skill) values (${id}, 'asian_style')`
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

/**
 * The pool for this file's therapists, with whatever exclusions the case is about.
 *
 * `therapistPoolCtes` rather than `readEligibleTherapists`: the port takes no exclusions by design —
 * `EligibilityQueryInput` carries none, so the pure implementation can never be handed a reason its
 * answer shape may not carry — and composing the CTEs is exactly what the availability read does.
 *
 * `tp_pool.reason` null means eligible. A therapist an UNREPORTED exclusion removed is in neither list,
 * because the candidate is gone rather than labelled.
 */
const pool = async (exclusions: readonly TherapistExclusion[]) => {
  const ctes = therapistPoolCtes(sql, {
    tradingDate: TRADING_DATE,
    requiredSkill: requiredSkillFor('asian'),
    employeeIds: allIds(),
    clientGender: 'female',
    exclusions,
  })
  const rows = await sql<{ employee_id: string; reason: string | null }[]>`
    with ${ctes}
    select employee_id::text as employee_id, reason from tp_pool order by employee_id
  `
  return {
    therapists: rows
      .filter((row) => row.reason === null)
      .map((row) => ({ therapistId: row.employee_id })),
    excluded: rows
      .filter((row) => row.reason !== null)
      .map((row) => ({ therapistId: row.employee_id, reason: row.reason as string })),
  }
}

const eligibleIds = (read: { readonly therapists: readonly { readonly therapistId: string }[] }) =>
  read.therapists.map((therapist) => therapist.therapistId).sort()

const excludedIds = (read: { readonly excluded: readonly { readonly therapistId: string }[] }) =>
  read.excluded.map((row) => row.therapistId).sort()

/**
 * An unrelated exclusion, standing in for M-VAT-10's overdue blocking obligation.
 *
 * Deliberately a DIFFERENT exclusion rather than a second copy of this unit's: what is being proved is
 * that two independent exclusions both apply, and an exclusion built out of `doNotPairExclusion` would
 * prove that the same rule applies twice.
 *
 * It REPORTS a reason, as theirs does, so the list under test holds one of each kind. A composition that
 * handled only the reported kind, or only the silent kind, fails here rather than in a merge.
 */
const UNRELATED_REASON = 'fixture_unrelated_reason'

const unrelatedExclusion = (employeeId: string): TherapistExclusion => ({
  name: 'fixture_unrelated_exclusion',
  reason: UNRELATED_REASON,
  when: sql`c.id = ${employeeId}::uuid`,
})

function delivery(therapistId: string, overrides: Partial<BookingDeliveryInput> = {}) {
  return {
    tradingDate: TRADING_DATE,
    serviceVariantId: variantId,
    shape: 'solo' as const,
    roomId,
    therapistIds: [therapistId],
    treatment: { startsAt: at('19:00'), endsAt: at('20:00') },
    price: {
      grossFils: GROSS_FILS,
      netFils: NET_FILS,
      vatFils: VAT_FILS,
      vatRateBp: 500,
      priceListId: null,
      promotionId: null,
    },
    status: 'confirmed' as const,
    ...overrides,
  }
}

function request(therapistId: string, forCustomer: string): CreateBookingInput {
  keySeed += 1
  return {
    idempotencyKey: `ccrm01-dnp-${keySeed}`,
    customerId: forCustomer,
    source: 'online',
    notes: MARKER,
    deliveries: [delivery(therapistId)],
    clientGender: 'female',
  }
}

beforeAll(async () => {
  sql = createConnection({ url, max: 2 })
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
    select s.id, 60, ${GROSS_FILS}, ${MARKER} from service s
     where s.style = 'asian' and s.treatment_key = 'normal_massage'
    on conflict (service_id, duration_minutes) do nothing
  `
  const [variant] = await sql<{ id: string }[]>`
    select v.id from service_variant v join service s on s.id = v.service_id
     where s.style = 'asian' and s.treatment_key = 'normal_massage' and v.duration_minutes = 60
  `
  variantId = (variant as { id: string }).id

  await addEmployee({ reference: 'ccrm01-dnp-pairable' })
  await addEmployee({ reference: 'ccrm01-dnp-excluded' })
  await addEmployee({ reference: 'ccrm01-dnp-third' })
  // Excluded by the pool's OWN reason machinery, so the composition is exercised beside it rather than
  // instead of it: a candidate exclusion that only worked when nothing else excluded anybody would pass
  // every case above and fail on a Saturday.
  await addEmployee({
    reference: 'ccrm01-dnp-lapsed',
    documents: [
      { type: 'professional_licence', expiresOn: '2099-09-13' },
      { type: 'health_certificate', expiresOn: '2099-12-31' },
    ],
  })

  const [shift] = await sql<{ id: string }[]>`
    insert into shift (trading_date, period, label)
    values (
      ${TRADING_DATE},
      ${`[${dubai(TRADING_DATE, '11')},${dubai(NEXT_DAY, '02')})`}::tstzrange,
      ${MARKER}
    )
    returning id
  `
  const shiftId = (shift as { id: string }).id
  shiftIds.push(shiftId)
  for (const id of allIds()) {
    await sql`insert into shift_assignment (shift_id, employee_id) values (${shiftId}, ${id})`
  }

  const first = await withUnitOfWork(sql, ACTOR, (uow) =>
    ensureCustomer(uow, {
      phoneE164: normalisePhone(CUSTOMER.phone),
      displayName: null,
      nameMatchKey: null,
      locale: 'en',
      createdVia: 'front_desk',
    }),
  )
  customerId = first.customer.id
  const second = await withUnitOfWork(sql, ACTOR, (uow) =>
    ensureCustomer(uow, {
      phoneE164: normalisePhone(OTHER_CUSTOMER.phone),
      displayName: null,
      nameMatchKey: null,
      locale: 'en',
      createdVia: 'front_desk',
    }),
  )
  otherCustomerId = second.customer.id
})

afterAll(async () => {
  const ids = allIds()
  await sql`delete from booking where notes = ${MARKER}`
  if (ids.length > 0) {
    await sql`delete from appointment where therapist_id = any(${ids}::uuid[])`
    await sql`delete from customer_therapist_do_not_pair where employee_id = any(${ids}::uuid[])`
    await sql`delete from shift_assignment where employee_id = any(${ids}::uuid[])`
    if (shiftIds.length > 0) await sql`delete from shift where id = any(${shiftIds}::uuid[])`
    await sql`delete from employee_document where employee_id = any(${ids}::uuid[])`
    await sql`delete from employee_skill where employee_id = any(${ids}::uuid[])`
    await sql`delete from employee where id = any(${ids}::uuid[])`
  }
  await sql`delete from service_variant where provisional_note = ${MARKER}`
  await sql`
    delete from customer where phone_e164 in (${normalisePhone(CUSTOMER.phone)}, ${normalisePhone(OTHER_CUSTOMER.phone)})
  `
  await sql`delete from business_day where trading_date = ${TRADING_DATE}`
  await sql?.end({ timeout: 5 })
})

describe('acceptance — the flag removes the pairing from availability, for that customer only', () => {
  it('offers the therapist before the flag exists, which is the control every case below needs', async () => {
    const read = await pool([doNotPairExclusion(sql, { customerId })])
    expect(eligibleIds(read)).toContain(idOf('ccrm01-dnp-excluded'))
    expect(eligibleIds(read)).toContain(idOf('ccrm01-dnp-pairable'))
    // The unrelated exclusion the pool applies itself, so the cases below are not passing against a
    // pool that excludes nobody for any reason.
    expect(excludedIds(read)).toEqual([idOf('ccrm01-dnp-lapsed')])
    expect(read.excluded.map((row) => row.reason)).toEqual(['credential_expired'])
  })

  it('removes the therapist for that customer once a manager records the flag', async () => {
    await withUnitOfWork(sql, ACTOR, (uow) =>
      setDoNotPair(
        uow,
        {
          customerId,
          employeeId: idOf('ccrm01-dnp-excluded'),
          reason: 'Asked not to be paired again after the visit on 2099-09-01.',
          role: MANAGER,
        },
        { authorise },
      ),
    )
    const read = await pool([doNotPairExclusion(sql, { customerId })])
    expect(eligibleIds(read)).not.toContain(idOf('ccrm01-dnp-excluded'))
    expect(eligibleIds(read)).toContain(idOf('ccrm01-dnp-pairable'))
  })

  it('leaves no trace of the exclusion in the answer — not even a reason', async () => {
    // The disclosure this flag exists to prevent. `excluded` travels to every caller that renders "why
    // can I not book", so the therapist must be absent from it as well as from `therapists`.
    const read = await pool([doNotPairExclusion(sql, { customerId })])
    expect(excludedIds(read)).not.toContain(idOf('ccrm01-dnp-excluded'))
    expect(excludedIds(read)).toEqual([idOf('ccrm01-dnp-lapsed')])
    expect(JSON.stringify(read)).not.toContain('do_not_pair')
    expect(JSON.stringify(read)).not.toContain(idOf('ccrm01-dnp-excluded'))
  })

  it('still offers the therapist to a different customer, and to a query about no customer', async () => {
    const forOther = await pool([doNotPairExclusion(sql, { customerId: otherCustomerId })])
    expect(eligibleIds(forOther)).toContain(idOf('ccrm01-dnp-excluded'))
    // `null` means the query is not about a customer — the admin calendar asking who is working. The
    // answer must be the whole roster, and an exclusion that read NULL as "exclude everybody" would
    // empty the calendar rather than fail visibly.
    const forNobody = await pool([doNotPairExclusion(sql, { customerId: null })])
    expect(eligibleIds(forNobody)).toContain(idOf('ccrm01-dnp-excluded'))
    expect(eligibleIds(forNobody)).toContain(idOf('ccrm01-dnp-pairable'))
  })

  it('offers the therapist again once the flag is lifted', async () => {
    const [row] = await sql<{ id: string }[]>`
      select id::text as id from customer_therapist_do_not_pair
       where customer_id = ${customerId} and employee_id = ${idOf('ccrm01-dnp-excluded')}
         and lifted_at is null
    `
    await withUnitOfWork(sql, ACTOR, (uow) =>
      liftDoNotPair(
        uow,
        {
          id: (row as { id: string }).id,
          role: MANAGER,
          reason: 'Customer asked for the pairing to be restored.',
          atIso: '2099-09-10T10:00:00.000Z',
        },
        { authorise },
      ),
    )
    const read = await pool([doNotPairExclusion(sql, { customerId })])
    expect(eligibleIds(read)).toContain(idOf('ccrm01-dnp-excluded'))
    // The row is still there — a lift is a soft removal — so this also proves the exclusion counts
    // ACTIVE rows rather than any row at all.
    const [count] = await sql<{ n: string }[]>`
      select count(*)::text as n from customer_therapist_do_not_pair
       where customer_id = ${customerId} and employee_id = ${idOf('ccrm01-dnp-excluded')}
    `
    expect(Number((count as { n: string }).n)).toBe(1)
  })
})

describe('acceptance — the exclusion composes with an unrelated one', () => {
  beforeAll(async () => {
    await withUnitOfWork(sql, ACTOR, (uow) =>
      setDoNotPair(
        uow,
        {
          customerId,
          employeeId: idOf('ccrm01-dnp-excluded'),
          reason: 'Re-recorded for the composition cases.',
          role: MANAGER,
        },
        { authorise },
      ),
    )
  })

  it('holds when a second, independent exclusion is also in play', async () => {
    // The case the coordination note asks for. Both exclusions must apply: a composition that kept the
    // last one would pass every single-exclusion case above.
    const read = await pool([
      doNotPairExclusion(sql, { customerId }),
      unrelatedExclusion(idOf('ccrm01-dnp-pairable')),
    ])
    expect(eligibleIds(read)).not.toContain(idOf('ccrm01-dnp-excluded'))
    expect(eligibleIds(read)).not.toContain(idOf('ccrm01-dnp-pairable'))
    // And the pool is not simply empty, which is what two broken exclusions would also produce.
    expect(eligibleIds(read)).toEqual([idOf('ccrm01-dnp-third')])
  })

  it('gives the same answer with the exclusions composed in the other order', async () => {
    const forwards = await pool([
      doNotPairExclusion(sql, { customerId }),
      unrelatedExclusion(idOf('ccrm01-dnp-pairable')),
    ])
    const backwards = await pool([
      unrelatedExclusion(idOf('ccrm01-dnp-pairable')),
      doNotPairExclusion(sql, { customerId }),
    ])
    expect(eligibleIds(backwards)).toEqual(eligibleIds(forwards))
    expect(excludedIds(backwards)).toEqual(excludedIds(forwards))
  })

  it('leaves the pool’s own reasons untouched, so the two mechanisms do not mask each other', async () => {
    const read = await pool([
      doNotPairExclusion(sql, { customerId }),
      unrelatedExclusion(idOf('ccrm01-dnp-pairable')),
    ])
    // Three therapists, three outcomes, from one list. `ccrm01-dnp-lapsed` is excluded by the pool's own
    // `credential_expired`; `ccrm01-dnp-pairable` by a composed exclusion that reports its reason; and
    // `ccrm01-dnp-excluded` by a composed exclusion that reports none, which is why it is in neither
    // list. Nothing has swallowed anything.
    const byId = Object.fromEntries(read.excluded.map((row) => [row.therapistId, row.reason]))
    expect(byId).toEqual({
      [idOf('ccrm01-dnp-lapsed')]: 'credential_expired',
      [idOf('ccrm01-dnp-pairable')]: UNRELATED_REASON,
    })
    expect(read.excluded).toHaveLength(2)
    expect(excludedIds(read)).not.toContain(idOf('ccrm01-dnp-excluded'))
    expect(eligibleIds(read)).toEqual([idOf('ccrm01-dnp-third')])
  })

  it('names no reason anywhere in the facts a customer-facing DTO is built from', async () => {
    // The assertion that stops the reason being "helpfully" filled in later, and the reason the field is
    // `string | null` rather than optional. Asserted over the whole serialised answer rather than over
    // one field: a reason reaches `AvailabilityFacts.excluded[].reason` and from there any DTO built on
    // these facts, so absence has to be a property of the bytes, not of a key somebody remembered to
    // drop. The unrelated exclusion's reason IS present in the same answer, which is what makes this a
    // statement about `reason: null` and not about a serialiser that hides everything.
    const facts = await readAvailabilityFacts(
      sql,
      {
        tradingDate: TRADING_DATE,
        serviceVariantId: variantId,
        shape: 'solo',
        therapistIds: allIds(),
        clientGender: 'female',
        minLeadMinutes: 0,
        maxAdvanceDays: 365_000,
        customerId,
      },
      at('12:00'),
    )
    expect(doNotPairExclusion(sql, { customerId }).reason).toBeNull()
    expect(facts.therapists.map((row) => row.therapistId)).not.toContain(
      idOf('ccrm01-dnp-excluded'),
    )
    expect(facts.excluded.map((row) => row.therapistId)).not.toContain(idOf('ccrm01-dnp-excluded'))
    const serialised = JSON.stringify(facts)
    for (const needle of [
      'customer_do_not_pair',
      'do_not_pair',
      'do-not-pair',
      idOf('ccrm01-dnp-excluded'),
    ]) {
      expect(serialised).not.toContain(needle)
    }
    // The control, in the same bytes: a reason the pool DOES report is present, so the absence above is
    // this exclusion's own choice rather than a read that happens to report nothing at all. (The
    // availability read composes only this unit's exclusion, so the reported reason here is the pool's
    // `credential_expired`; the case above is where a reported COMPOSED reason appears alongside it.)
    expect(serialised).toContain('credential_expired')
  })

  it('is applied by the one-statement availability read as well, not only by the two-statement one', async () => {
    // B-AVAIL-07 composes the same fragment into a single round trip. An exclusion wired into only one
    // of the two callers is a booking page that stops offering the therapist and an API that does not.
    const facts = await readAvailabilityFacts(
      sql,
      {
        tradingDate: TRADING_DATE,
        serviceVariantId: variantId,
        shape: 'solo',
        therapistIds: allIds(),
        clientGender: 'female',
        minLeadMinutes: 0,
        maxAdvanceDays: 365_000,
        customerId,
      },
      at('12:00'),
    )
    const offered = facts.therapists.map((therapist) => therapist.therapistId)
    expect(offered).not.toContain(idOf('ccrm01-dnp-excluded'))
    expect(offered).toContain(idOf('ccrm01-dnp-pairable'))
    expect(facts.excluded.map((row) => row.therapistId)).not.toContain(idOf('ccrm01-dnp-excluded'))
    // The presence rows must not leak the therapist either: a shift for somebody who is not in the pool
    // is a therapist the caller can see without being offered.
    expect(facts.shifts.map((shift) => shift.therapistId)).not.toContain(
      idOf('ccrm01-dnp-excluded'),
    )
    // The control: the same read with no customer offers them.
    const openFacts = await readAvailabilityFacts(
      sql,
      {
        tradingDate: TRADING_DATE,
        serviceVariantId: variantId,
        shape: 'solo',
        therapistIds: allIds(),
        clientGender: 'female',
        minLeadMinutes: 0,
        maxAdvanceDays: 365_000,
      },
      at('12:00'),
    )
    expect(openFacts.therapists.map((therapist) => therapist.therapistId)).toContain(
      idOf('ccrm01-dnp-excluded'),
    )
  })
})

describe('the booking transaction refuses the pairing too', () => {
  it('refuses a flagged pairing with therapist_not_eligible, naming no reason', async () => {
    // The write, not the read. A guard applied only to availability is a page that stops offering the
    // therapist and a POST that still books them from a tuple assembled before the flag was recorded.
    let caught: unknown
    try {
      await bookSlot(sql, ACTOR, request(idOf('ccrm01-dnp-excluded'), customerId), {
        recheck: recheckShapeAssignment,
      })
    } catch (error) {
      caught = error
    }
    expect(bookingRefusalOf(caught)).toBe('therapist_not_eligible')
    // And the refusal names no reason for the exclusion, because a candidate exclusion has none to
    // name. `excluded` in the error details carries the pool's reported reasons only.
    expect(JSON.stringify((caught as { details?: unknown }).details)).not.toContain('do_not_pair')
  })

  it('books the same slot for the same customer with a therapist who is not flagged', async () => {
    // The control. Without it, the refusal above could be any of the eight other reasons this
    // transaction refuses for.
    const created = await bookSlot(sql, ACTOR, request(idOf('ccrm01-dnp-pairable'), customerId), {
      recheck: recheckShapeAssignment,
    })
    expect(created.replayed).toBe(false)
    expect(created.deliveries).toHaveLength(1)
    await sql`delete from booking where id = ${created.bookingId}`
  })

  it('books the flagged therapist for a customer with no flag against them', async () => {
    const created = await bookSlot(
      sql,
      ACTOR,
      request(idOf('ccrm01-dnp-excluded'), otherCustomerId),
      { recheck: recheckShapeAssignment },
    )
    expect(created.replayed).toBe(false)
    await sql`delete from booking where id = ${created.bookingId}`
  })
})
