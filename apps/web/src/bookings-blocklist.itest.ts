import {
  type Instant,
  instantFromIso,
  mayChangeBlocklist,
  normaliseBlocklistKey,
  normalisePhone,
} from '@berelax/core'
import {
  type Actor,
  addBlocklistEntry,
  type BlocklistAuthoriser,
  CRM_AUDIT_ACTIONS,
  createConnection,
  readMandatoryDocumentTypes,
  type Sql,
  withUnitOfWork,
} from '@berelax/db'
import { syntheticPerson } from '@berelax/fixtures'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type BookingEndpointDeps,
  handleBookingRequest,
  NO_AVAILABILITY_BODY,
  NO_AVAILABILITY_STATUS,
} from '../app/api/v1/bookings/handler.ts'

/**
 * C-CRM-01 — `POST /api/v1/bookings` refuses a blocklisted contact, and leaks nothing by doing so.
 *
 * The acceptance line: "a blocklisted customer is refused by the public booking endpoint when matched on
 * normalised E.164 phone AND when matched on normalised email; the refusal response has the same status
 * code and body snapshot as a legitimate no-availability response, so the endpoint leaks no enumeration
 * signal".
 *
 * ## Why the comparison is against a REAL no-availability response
 *
 * The obvious version of this test asserts the blocked response equals a literal somebody typed into the
 * test, which is satisfied by editing the test. So the legitimate response is *produced*: the slot is
 * booked by a customer who is not on the list, the same slot is then requested again, the endpoint
 * answers `slot_taken`, and THAT response is compared with the blocked one — status, headers and body
 * bytes. A pinned literal sits beside it as the snapshot, so a change to either path fails here rather
 * than becoming the new expectation.
 *
 * The handler is called directly rather than over HTTP, exactly as `otp-route.itest.ts` calls its own:
 * what is being compared is the response the handler constructs, and a `next start` in front of it would
 * add a router and a JSON parser to both sides without adding anything to the claim. Nothing here starts
 * a server, so no port is drawn.
 *
 * ## Isolation
 *
 * `2099-09-16` is used by no other suite and no gate. Every customer is `syntheticPerson`, on the
 * unallocated `+971 59` prefix, with an address on the unroutable `fixture.invalid` domain.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

const TRADING_DATE = '2099-09-16'
const NEXT_DAY = '2099-09-17'
const MARKER = 'ccrm01 blocklist endpoint itest'
const MANAGER = 'manager'
const ACTOR: Actor = { kind: 'staff', label: 'Manager (fixture)' }
/** Books successfully, and produces the legitimate no-availability answer on the second attempt. */
const CLEAN = syntheticPerson(4_421)
/** On the list by phone. */
const BLOCKED_PHONE = syntheticPerson(4_422)
/** On the list by email, with a phone nobody has blocked. */
const BLOCKED_EMAIL = syntheticPerson(4_423)

const FROZEN: Instant = instantFromIso('2099-09-16T09:00:00+04:00')
const dubai = (day: string, hhmm: string): string => `${day} ${hhmm}:00+04`
const START = '2099-09-16T19:00:00+04:00'
/**
 * One of the four durations `service_variant_duration_allowed` permits (0017), and the seeded catalogue
 * already holds it — so this suite READS the variant rather than creating one. An arbitrary duration is
 * refused by that constraint, which is the right answer: every other duration has no price.
 */
const DURATION_MINUTES = 45

let sql: Sql
let roomId: string
let variantId: string
let therapistId: string
let shiftId: string
let keySeed = 0

const authorise = mayChangeBlocklist satisfies BlocklistAuthoriser
const deps = (): BookingEndpointDeps => ({ sql, now: () => FROZEN })

function post(body: Record<string, unknown>): Request {
  keySeed += 1
  return new Request('https://example.test/api/v1/bookings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': `ccrm01-blk-${keySeed}` },
    body: JSON.stringify(body),
  })
}

const bookingBody = (person: { phone: string; email: string }, withEmail: boolean) => ({
  phone: person.phone,
  ...(withEmail ? { email: person.email } : {}),
  clientGender: 'female',
  deliveries: [
    {
      serviceVariantId: variantId,
      shape: 'solo',
      roomId,
      therapistIds: [therapistId],
      startsAt: START,
    },
  ],
})

/** Status, the one header that matters, and the body BYTES. What "the same response" has to mean. */
async function snapshotOf(response: Response) {
  return {
    status: response.status,
    cacheControl: response.headers.get('cache-control'),
    contentType: response.headers.get('content-type'),
    body: await response.text(),
  }
}

async function auditCount(action: string): Promise<number> {
  const [row] = await sql<{ n: string }[]>`
    select count(*)::text as n from audit_event where action = ${action}
  `
  return Number(row?.n ?? '0')
}

async function customerCount(phone: string): Promise<number> {
  const [row] = await sql<{ n: string }[]>`
    select count(*)::text as n from customer where phone_e164 = ${normalisePhone(phone)}
  `
  return Number(row?.n ?? '0')
}

async function block(kind: 'phone' | 'email', raw: string): Promise<void> {
  const key = normaliseBlocklistKey(kind, raw)
  if (!key.ok) throw new Error(`fixture ${kind} must normalise: ${key.reason}`)
  await withUnitOfWork(sql, ACTOR, (uow) =>
    addBlocklistEntry(
      uow,
      {
        kind,
        value: key.key.value,
        reason: 'Abusive to staff on 2099-09-02.',
        role: MANAGER,
      },
      { authorise },
    ),
  )
}

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })
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
  const [variant] = await sql<{ id: string }[]>`
    select v.id from service_variant v join service s on s.id = v.service_id
     where s.style = 'asian' and s.treatment_key = 'normal_massage'
       and v.duration_minutes = ${DURATION_MINUTES}
  `
  variantId = (variant as { id: string }).id

  const [employee] = await sql<{ id: string }[]>`
    insert into employee (staff_reference, gender, employed_from, notes)
    values ('ccrm01-blk-therapist', 'female', '2099-01-01', ${MARKER})
    returning id
  `
  therapistId = (employee as { id: string }).id
  await sql`insert into employee_skill (employee_id, skill) values (${therapistId}, 'asian_style')`
  // The mandatory set IN FORCE, not a hard-coded pair: migration 0058 reconciled the row with the
  // column DEFAULT (docs/01 decision 20's six), and a fixture naming two of them stops meaning "holds
  // every mandatory document" the moment that answer changes (0054's header, brief rule 12).
  for (const type of await readMandatoryDocumentTypes(sql)) {
    await sql`
      insert into employee_document (employee_id, document_type, expires_on)
      values (${therapistId}, ${type}::employee_document_type, '2099-12-31')
    `
  }
  const [shift] = await sql<{ id: string }[]>`
    insert into shift (trading_date, period, label)
    values (
      ${TRADING_DATE},
      ${`[${dubai(TRADING_DATE, '11')},${dubai(NEXT_DAY, '02')})`}::tstzrange,
      ${MARKER}
    )
    returning id
  `
  shiftId = (shift as { id: string }).id
  await sql`insert into shift_assignment (shift_id, employee_id) values (${shiftId}, ${therapistId})`

  await block('phone', BLOCKED_PHONE.phone)
  await block('email', BLOCKED_EMAIL.email)
})

afterAll(async () => {
  // The BOOKING first: `appointment.booking_id` cascades, so deleting the appointments first would leave
  // the booking rows behind with nothing left to find them by — the endpoint writes no marker of its own.
  await sql`
    delete from booking where id in (
      select booking_id from appointment where therapist_id = ${therapistId}
    )
  `
  await sql`delete from appointment where therapist_id = ${therapistId}`
  await sql`delete from shift_assignment where employee_id = ${therapistId}`
  await sql`delete from shift where id = ${shiftId}`
  await sql`delete from employee_document where employee_id = ${therapistId}`
  await sql`delete from employee_skill where employee_id = ${therapistId}`
  await sql`delete from employee where id = ${therapistId}`
  await sql`delete from customer_blocklist where reason = 'Abusive to staff on 2099-09-02.'`
  await sql`
    delete from customer where phone_e164 = any(${[
      normalisePhone(CLEAN.phone),
      normalisePhone(BLOCKED_PHONE.phone),
      normalisePhone(BLOCKED_EMAIL.phone),
    ]}::text[])
  `
  await sql`delete from business_day where trading_date = ${TRADING_DATE}`
  await sql?.end({ timeout: 5 })
})

/** Produced once and reused: it is the yardstick every assertion below is measured against. */
let legitimate: Awaited<ReturnType<typeof snapshotOf>>

describe('acceptance — the blocked refusal is the no-availability refusal, byte for byte', () => {
  it('takes the booking for a contact nobody has blocked, and advances the lifecycle', async () => {
    // The control the whole file rests on. Without a booking that SUCCEEDS, "the blocked caller is
    // refused" is satisfied by an endpoint that refuses everybody.
    const created = await handleBookingRequest(deps(), post(bookingBody(CLEAN, true)))
    expect(created.status).toBe(201)
    const body = (await created.json()) as { bookingId: string; replayed: boolean }
    expect(body.replayed).toBe(false)
    const [row] = await sql<{ lifecycle_state: string }[]>`
      select lifecycle_state from customer where phone_e164 = ${normalisePhone(CLEAN.phone)}
    `
    // `lead` is the state a record is born in; a booking is what makes it `new` (C-CRM-01's reducer).
    expect((row as { lifecycle_state: string }).lifecycle_state).toBe('new')
  })

  it('answers the same slot with a legitimate no-availability refusal', async () => {
    const response = await handleBookingRequest(deps(), post(bookingBody(CLEAN, true)))
    legitimate = await snapshotOf(response)
    expect(legitimate.status).toBe(NO_AVAILABILITY_STATUS)
    expect(legitimate.status).toBe(409)
    // The snapshot, written out. A change to the body on either path fails here rather than quietly
    // becoming the new expectation, and the literal is what makes the equality assertions below mean
    // something — two responses can be equal and both wrong.
    expect(JSON.parse(legitimate.body)).toEqual({
      error: 'slot_unavailable',
      refusal: 'slot_taken',
      reason:
        'that time is not available. Choose another time, or ask us to let you know when one frees up.',
    })
    expect(legitimate.body).toBe(JSON.stringify(NO_AVAILABILITY_BODY))
    expect(legitimate.cacheControl).toBe('no-store')
  })

  it('refuses a blocklisted PHONE with the identical response', async () => {
    const response = await handleBookingRequest(deps(), post(bookingBody(BLOCKED_PHONE, false)))
    expect(await snapshotOf(response)).toEqual(legitimate)
  })

  it('refuses a blocklisted EMAIL with the identical response, on an unblocked phone', async () => {
    // The phone is not on the list, so this case can only pass through the email key. Asserting the
    // phone separately below keeps that honest.
    const response = await handleBookingRequest(deps(), post(bookingBody(BLOCKED_EMAIL, true)))
    expect(await snapshotOf(response)).toEqual(legitimate)
    const withoutEmail = await handleBookingRequest(deps(), post(bookingBody(BLOCKED_EMAIL, false)))
    // Without the address there is nothing to match, so the refusal that comes back is the slot's own —
    // which is the same bytes. The proof that the email key did the work is the audit row below.
    expect(await snapshotOf(withoutEmail)).toEqual(legitimate)
  })

  it('matches an un-normalised spelling of a blocked number and address', async () => {
    // `0590004422` and `CUSTOMER.4423@FIXTURE.INVALID` are the same keys as the stored ones. A blocklist
    // that matched raw strings would be bypassed by a space or a capital letter.
    const national = normalisePhone(BLOCKED_PHONE.phone).replace('+971', '0')
    const shouted = { phone: national, email: BLOCKED_EMAIL.email.toUpperCase() }
    const response = await handleBookingRequest(deps(), post(bookingBody(shouted, true)))
    expect(await snapshotOf(response)).toEqual(legitimate)
  })

  it('creates no customer row for a blocked contact', async () => {
    // Refused before `ensureCustomer`, so a blocked contact leaves no trace but the audit row. The clean
    // caller's row is the control: the endpoint does create one when it proceeds.
    expect(await customerCount(BLOCKED_PHONE.phone)).toBe(0)
    expect(await customerCount(CLEAN.phone)).toBe(1)
  })
})

describe('the audit trail is where the truth is recorded', () => {
  it('writes a denied evaluation naming the matched key kind and the reason', async () => {
    const before = await auditCount(CRM_AUDIT_ACTIONS.blocklistEvaluated)
    await handleBookingRequest(deps(), post(bookingBody(BLOCKED_PHONE, false)))
    expect((await auditCount(CRM_AUDIT_ACTIONS.blocklistEvaluated)) - before).toBe(1)
    const [row] = await sql<
      {
        actor_kind: string
        actor_label: string
        operation: string
        after: { matched: boolean; matched_key_kind: string; reason: string; context: string }
      }[]
    >`
      select actor_kind, actor_label, operation, after_state as after from audit_event
       where action = ${CRM_AUDIT_ACTIONS.blocklistEvaluated}
       order by occurred_at desc, id desc limit 1
    `
    const record = row as {
      actor_kind: string
      actor_label: string
      operation: string
      after: { matched: boolean; matched_key_kind: string; reason: string; context: string }
    }
    // The public endpoint's actor: `customer` with a LABEL and no id, because a guest booking has proved
    // nothing about who they are (ADR 0014). This system invents no names for people.
    expect(record.actor_kind).toBe('customer')
    expect(record.actor_label).toBe('Public booking (unauthenticated)')
    expect(record.operation).toBe('denied')
    expect(record.after.matched).toBe(true)
    expect(record.after.matched_key_kind).toBe('phone')
    expect(record.after.context).toBe('public_booking')
    expect(record.after.reason).toBe('Abusive to staff on 2099-09-02.')
  })

  it('records the EMAIL key kind when that is what matched', async () => {
    await handleBookingRequest(deps(), post(bookingBody(BLOCKED_EMAIL, true)))
    const [row] = await sql<{ after: { matched_key_kind: string } }[]>`
      select after_state as after from audit_event
       where action = ${CRM_AUDIT_ACTIONS.blocklistEvaluated}
       order by occurred_at desc, id desc limit 1
    `
    expect((row as { after: { matched_key_kind: string } }).after.matched_key_kind).toBe('email')
  })

  it('audits the clean caller’s evaluation too, so a skipped check is detectable', async () => {
    const before = await auditCount(CRM_AUDIT_ACTIONS.blocklistEvaluated)
    await handleBookingRequest(deps(), post(bookingBody(CLEAN, true)))
    expect((await auditCount(CRM_AUDIT_ACTIONS.blocklistEvaluated)) - before).toBe(1)
    const [row] = await sql<{ operation: string; after: { matched: boolean } }[]>`
      select operation, after_state as after from audit_event
       where action = ${CRM_AUDIT_ACTIONS.blocklistEvaluated}
       order by occurred_at desc, id desc limit 1
    `
    expect((row as { operation: string }).operation).toBe('read')
    expect((row as { after: { matched: boolean } }).after.matched).toBe(false)
  })
})

describe('the validation refusals are the same for a blocked caller and an ordinary one', () => {
  /**
   * The leak from the other end.
   *
   * If the blocklist were evaluated before the request was validated, a blocked caller could post a
   * nonsense variant id and receive `409 slot_unavailable` where everybody else receives
   * `404 unknown_service_variant` — and would have learned they are on the list. So the check runs after
   * every refusal a malformed request can produce, and these cases are what hold that ordering in place.
   */
  const malformed = (person: { phone: string; email: string }) => ({
    ...bookingBody(person, true),
    deliveries: [
      {
        serviceVariantId: '11111111-1111-4111-8111-111111111111',
        shape: 'solo',
        roomId,
        therapistIds: [therapistId],
        startsAt: START,
      },
    ],
  })

  it('answers an unknown service variant identically for both', async () => {
    const forClean = await snapshotOf(await handleBookingRequest(deps(), post(malformed(CLEAN))))
    const forBlocked = await snapshotOf(
      await handleBookingRequest(deps(), post(malformed(BLOCKED_PHONE))),
    )
    expect(forBlocked).toEqual(forClean)
    expect(forClean.status).toBe(404)
    expect(JSON.parse(forClean.body).error).toBe('unknown_service_variant')
  })

  it('answers a malformed email by ignoring it, not by refusing the booking', async () => {
    // The field is optional and its only use is the blocklist check, so refusing over a typo in it would
    // make the blocklist visible by its side effects. A blocked PHONE still blocks.
    const response = await handleBookingRequest(
      deps(),
      post({ ...bookingBody(BLOCKED_PHONE, false), email: 'not-an-address' }),
    )
    expect(await snapshotOf(response)).toEqual(legitimate)
  })

  it('refuses an email longer than the forward-path limit as an invalid request', async () => {
    const response = await handleBookingRequest(
      deps(),
      post({ ...bookingBody(CLEAN, false), email: `${'a'.repeat(250)}@fixture.invalid` }),
    )
    expect(response.status).toBe(400)
    expect((await response.json()).error).toBe('invalid_request')
  })
})
