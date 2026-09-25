import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BOOKING_TOKEN_GRACE_SECONDS,
  BOOKING_TOKEN_LENGTH,
  BOOKING_TOKEN_NOT_FOUND,
  BOOKING_TOKEN_PURPOSES,
  bookingTokenExpiry,
  CLINICAL_FIELD_MARKERS,
  CUSTOMER_LINK_PRINCIPAL,
  cancellationVerdictFor,
  decideAppointmentTransition,
  type Instant,
  MANAGE_BOOKING_FIELDS,
  recheckShapeAssignment,
  reminderPlanFor,
} from '@berelax/core'
import {
  type Actor,
  bookingTokenDigest,
  bookSlot,
  type CancellationPolicy,
  cancelBookingTx,
  createConnection,
  mintBookingManageGrant,
  readMandatoryDocumentTypes,
  rescheduleAppointmentTx,
  type ScheduledStepMaintainer,
  type ScheduledStepPlanner,
  type SlotRecheck,
  type Sql,
  scheduledStepMaintainer,
  scheduledStepsFor,
  seedMessageTemplates,
  type TransitionActor,
  type TransitionDecider,
  transitionAppointmentTx,
  withUnitOfWork,
} from '@berelax/db'
import { auditPage, blockingViolations, describeViolation } from '@berelax/harness/accessibility'
import {
  captureUntilStable,
  DETERMINISM_CSS,
  DETERMINISTIC_LAUNCH_ARGS,
} from '@berelax/harness/determinism'
import { DIRECTIONS, THEMES, VIEWPORTS } from '@berelax/harness/matrix'
import { DEFAULT_TEMPLATES } from '@berelax/messaging'
import { MANAGE_BOOKING_PATH_PREFIX, manageBookingPath } from '@berelax/shared'
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  handleManageBookingRead,
  handleManageBookingWrite,
  MANAGE_BOOKING_WRITE_PATHS,
} from '../app/(public)/booking/[token]/handler.ts'
import { repositoryRoot } from './media/storage.ts'
import { routeByPath } from './routes/registry.ts'

/**
 * B-UI-05 — the magic-link token service and the manage-booking page, against real PostgreSQL.
 *
 * ## Why this file starts no server, and takes no port band
 *
 * The handlers are called directly, exactly as `preferences-route.itest.ts` and `otp-route.itest.ts` call
 * theirs, and that file states the reason this one inherits: what is asserted is the SHAPE of a refusal and
 * the rows a write leaves, and a `next start` in front of them would add a router and a form parser to every
 * case without changing one of them. Brief rule 18 asks a server-starting suite to draw a band from
 * `@berelax/harness/ports`; nothing here starts a server, so no band is drawn and none is declared.
 *
 * The axe audit and the screenshot matrix still need a browser, and they get one without a server because
 * `render.ts` is PURE: `page.setContent(html)` renders the same bytes the route would serve. That is not a
 * shortcut around the criterion — it is a stronger form of it, because the document under the camera is the
 * document the renderer produced rather than one a server, a cache and a hydration pass have all touched.
 *
 * ## What is proved here and nowhere else
 *
 *   - **No column holds the token.** Read out of `information_schema`, plus the digest compared against the
 *     token the mint returned — so "hashed" is a property of the row rather than of the code that wrote it.
 *   - **Every refusal is one response, byte for byte.** An altered character, an unknown token, an expired
 *     one and a revoked one, compared as bytes, with the `audit_event` delta that says each was recorded.
 *   - **The customer's write is the staff write.** Asserted by shared REFERENCE and then behaviourally
 *     against the same cancellation window, because two paths that agree today are how two paths come to
 *     disagree quietly.
 *   - **The reschedule's effect on `scheduled_step`**, as row states: the predecessor's steps superseded and
 *     the successor's built, with the keys the appointment's NEW period derives.
 *
 * ## Isolation (brief rule 12)
 *
 * The integration suite runs sequentially against ONE database and earlier files leave rows behind. The
 * trading dates `2099-12-20` and `2099-12-21` are used by no other suite and no gate; every room, employee,
 * service, variant, customer and booking here carries {@link MARKER} or the run id, and every read narrows
 * to them. `audit_event` is append-only, so every assertion over it is a DELTA counted in SQL and never a
 * total — and never through a capped reader, which is how `settings-store.itest.ts` came to read three
 * recorded changes as zero.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url) {
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')
}

const MARKER = 'bui05 manage booking itest'
/** Unique per run: `audit_event` cannot be cleaned up, so nothing here may reuse a recipient or an id. */
const RUN = `${process.pid}${Math.floor(Math.random() * 1e6)}`

/** 11:00–02:00 Dubai. The session that opens on the 20th closes at 02:00 on the 21st. */
const TRADING_DATE = '2099-12-20'
const NEXT_TRADING_DATE = '2099-12-21'
const THIRD_TRADING_DATE = '2099-12-22'
const DAY_AFTER = '2099-12-23'
/** Every trading date this file writes on, in order. */
const DATES = [TRADING_DATE, NEXT_TRADING_DATE, THIRD_TRADING_DATE] as const
const PROBE = 'bui05_probe'
/**
 * Six rooms and six therapists, one pair per concurrent booking.
 *
 * Not two, and the reason is arithmetic rather than caution: `service.turnaround_minutes` is 20, so a
 * 45-minute treatment occupies its room for 65 minutes, and two bookings an hour apart in one room are a
 * `slot_taken` from the exclusion constraint. Every case here needs its own booking and several need a
 * second one to move onto, so {@link nextSlot} hands out a distinct (room, date, hour) triple per booking
 * and advances the ROOM fastest — which also keeps the therapist distinct, because the therapist index is
 * the room's. Six rooms times four hours times three dates is 72 slots against about 25 bookings.
 *
 * A file that shared a room between cases would pass alone and fail the moment a case was added above it,
 * which is the failure mode brief rule 12 is about arriving from inside one file.
 */
const ROOM_CODES = [
  'bui05-room-1',
  'bui05-room-2',
  'bui05-room-3',
  'bui05-room-4',
  'bui05-room-5',
  'bui05-room-6',
] as const
/**
 * Three hours apart, so a booking and the slot two hours after it are both free in one room.
 *
 * 65 minutes of occupancy means 90 would do; three hours leaves room for the `+2h` move every reschedule
 * case makes without that target ever being another case's slot. 23:00 is deliberately absent: the session
 * closes at 02:00, and a move from 23:00 to 01:00 would put the turnaround past the close — a state the
 * booking transaction does not police and this file has no business asserting about.
 */
const SLOT_HOURS = ['11', '14', '17', '20'] as const
/** A UAE mobile this run alone writes to. Seven digits of the run id, padded. */
const PHONE = `+9715${RUN.slice(0, 7).padStart(7, '0')}`
/** The Arabic reader, so the RTL half of the matrix is a real Arabic document and not a flipped English one. */
const PHONE_AR = `+9714${RUN.slice(0, 7).padStart(7, '0')}`

const GROSS_FILS = 20_000
const NET_FILS = 19_048
const VAT_FILS = 952

const CALLER: Actor = { kind: 'staff', label: MARKER }
const OWNER: TransitionActor = {
  kind: 'staff',
  role: 'owner',
  id: '00000000-0000-4000-8000-00000000d501',
  label: MARKER,
}
/**
 * The link holder, as the handler builds it: `system` on the row, the principal in the check.
 *
 * `principals/customer-link.ts` records why it is a principal and not a ninth role, and
 * `TransitionActor.principal` records why the two are separate fields — `appointment_status_history`'s
 * `actor_role` CHECK accepts exactly the eight F07 roles, and it refused the first draft.
 */
const LINK_HOLDER: TransitionActor = {
  kind: 'customer',
  role: 'system',
  principal: CUSTOMER_LINK_PRINCIPAL,
  label: MARKER,
}

const decide = decideAppointmentTransition satisfies TransitionDecider
const recheck = recheckShapeAssignment satisfies SlotRecheck
const classify = cancellationVerdictFor satisfies CancellationPolicy

const stepPlan: ScheduledStepPlanner = ({ appointmentId, period }) =>
  reminderPlanFor({ appointmentId, period, offsetsHours: [24, 2] })
const maintainer: ScheduledStepMaintainer = scheduledStepMaintainer({ plan: stepPlan })

/** Dubai wall clock as epoch milliseconds, and as the literal `business_day` needs. */
const at = (date: string, hhmm: string): number => Date.parse(`${date}T${hhmm}:00+04:00`)
const dubai = (date: string, hhmm: string): string => `${date} ${hhmm}:00+04`

/** Every treatment is 45 minutes, which is the one variant this file publishes. */
const TREATMENT_MINUTES = 45

/** One booking's place: a room, a therapist, a trading date and a period. */
interface Slot {
  readonly tradingDate: string
  readonly startsAt: number
  readonly endsAt: number
  readonly room: string
  readonly therapist: number
}

let slotIndex = 0

/**
 * The next free (room, date, hour) triple. See {@link ROOM_CODES} for why they must all be distinct.
 *
 * A counter rather than hand-picked times, because hand-picked times are what collided: a case added above
 * another one shifts nothing, and a case that reuses an hour in a room fails with `slot_taken` from
 * `createBooking` — a message about the fixture wearing the shape of a defect in the code under test.
 */
function nextSlot(): Slot {
  const index = slotIndex
  slotIndex += 1
  const roomIndex = index % ROOM_CODES.length
  const hour = SLOT_HOURS[Math.floor(index / ROOM_CODES.length) % SLOT_HOURS.length] as string
  const date = DATES[
    Math.floor(index / (ROOM_CODES.length * SLOT_HOURS.length)) % DATES.length
  ] as string
  const startsAt = at(date, hour)
  return {
    tradingDate: date,
    startsAt,
    endsAt: startsAt + TREATMENT_MINUTES * 60_000,
    room: ROOM_CODES[roomIndex] as string,
    therapist: roomIndex,
  }
}

/**
 * The frozen "now" for a slot: two days before the treatment.
 *
 * Two days, so the default 24-hour cancellation window is OPEN. A case that needs it closed passes a
 * different instant rather than a different booking, which is what makes "inside the window" and "outside
 * it" two instants over one fixture.
 */
const nowFor = (slot: Slot): number => slot.startsAt - 48 * 60 * 60 * 1000

/** The slot two hours on, in the same room. Free by construction; see {@link SLOT_HOURS}. */
const twoHoursOn = (slot: Slot): Slot => ({
  ...slot,
  startsAt: slot.startsAt + 2 * 60 * 60 * 1000,
  endsAt: slot.endsAt + 2 * 60 * 60 * 1000,
})

const SCREENS = join(repositoryRoot(), 'artifacts', 'screens', 'B-UI-05')

let sql: Sql
let browser: Browser
let customerId: string
let arabicCustomerId: string
let variantId: string
const rooms = new Map<string, string>()
const staff: string[] = []

const roomId = (code: string): string => rooms.get(code) as string

/** A count over an append-only table, in SQL. Subtracted, never read as a total (brief rule 9). */
async function auditCount(action: string): Promise<number> {
  const [row] = await sql<{ count: string }[]>`
    select count(*)::text as count from audit_event where action = ${action}
  `
  return Number(row?.count ?? '0')
}

async function grantCount(bookingId: string): Promise<number> {
  const [row] = await sql<{ count: string }[]>`
    select count(*)::text as count from booking_manage_grant where booking_id = ${bookingId}::uuid
  `
  return Number(row?.count ?? '0')
}

/** One booking through `createBooking`, so every appointment here was really sold. */
async function book(args: {
  readonly key: string
  readonly slot: Slot
  readonly arabic?: boolean
}): Promise<{ readonly bookingId: string; readonly appointmentId: string }> {
  const created = await bookSlot(
    sql,
    CALLER,
    {
      idempotencyKey: `${MARKER}:${RUN}:${args.key}`,
      customerId: args.arabic === true ? arabicCustomerId : customerId,
      source: 'online',
      notes: MARKER,
      clientGender: 'female',
      deliveries: [
        {
          tradingDate: args.slot.tradingDate,
          serviceVariantId: variantId,
          shape: 'solo',
          roomId: roomId(args.slot.room),
          therapistIds: [staff[args.slot.therapist] as string],
          treatment: { startsAt: args.slot.startsAt, endsAt: args.slot.endsAt },
          price: {
            grossFils: GROSS_FILS,
            netFils: NET_FILS,
            vatFils: VAT_FILS,
            vatRateBp: 500,
            priceListId: null,
            promotionId: null,
          },
          status: 'requested',
        },
      ],
    },
    { recheck },
  )
  const appointmentId = created.deliveries[0]?.appointmentIds[0]
  if (appointmentId === undefined) throw new Error('the fixture booking wrote no appointment')
  await transitionAppointmentTx(
    sql,
    { appointmentId, to: 'confirmed', actor: OWNER },
    { decide, steps: maintainer },
  )
  return { bookingId: created.bookingId, appointmentId }
}

/** A booking with a live link on it, which is what a reminder leaves behind. */
async function bookWithLink(args: {
  readonly key: string
  readonly slot: Slot
  readonly arabic?: boolean
}): Promise<{
  readonly bookingId: string
  readonly appointmentId: string
  readonly token: string
  readonly expiresAtIso: string
  readonly slot: Slot
}> {
  const booked = await book(args)
  const grant = await mintFor(booked.bookingId, args.slot, nowFor(args.slot))
  return { ...booked, token: grant.token, expiresAtIso: grant.expiresAtIso, slot: args.slot }
}

/** One grant, minted by the rule: the treatment's end plus 24 hours, issued at a supplied instant. */
const mintFor = (
  bookingId: string,
  slot: Slot,
  issuedAtMs: number,
): Promise<{ readonly token: string; readonly expiresAtIso: string }> =>
  withUnitOfWork(sql, CALLER, (uow) =>
    mintBookingManageGrant(uow, {
      bookingId,
      purpose: BOOKING_TOKEN_PURPOSES[0] as string,
      issuedAtIso: new Date(issuedAtMs).toISOString(),
      expiresAtIso: new Date(bookingTokenExpiry(slot.endsAt)).toISOString(),
    }),
  )

/** The handler's dependencies at a chosen instant. The clock is an argument, never `Date.now()`. */
const depsAt = (nowMs: number): { readonly sql: Sql; readonly now: () => Instant } => ({
  sql,
  now: () => nowMs as Instant,
})

const readPage = (token: string | null, nowMs: number, query = ''): Promise<Response> =>
  handleManageBookingRead({ token, searchParams: new URLSearchParams(query) }, depsAt(nowMs))

const postPage = (
  token: string | null,
  form: Record<string, string>,
  nowMs: number,
): Promise<Response> =>
  handleManageBookingWrite({ token, form: new URLSearchParams(form) }, depsAt(nowMs))

beforeAll(async () => {
  sql = createConnection({ url, max: 6 })
  browser = await chromium.launch({ args: [...DETERMINISTIC_LAUNCH_ARGS] })

  for (const [phone, locale] of [
    [PHONE, 'en'],
    [PHONE_AR, 'ar'],
  ] as const) {
    const [row] = await sql<{ id: string }[]>`
      insert into customer (phone_e164, created_via, locale)
      values (${phone}, 'guest_booking', ${locale})
      on conflict (phone_e164) do update set locale = excluded.locale
      returning id
    `
    if (locale === 'en') customerId = (row as { id: string }).id
    else arabicCustomerId = (row as { id: string }).id
  }

  for (const [date, nextCalendarDate] of [
    [TRADING_DATE, NEXT_TRADING_DATE],
    [NEXT_TRADING_DATE, THIRD_TRADING_DATE],
    [THIRD_TRADING_DATE, DAY_AFTER],
  ] as const) {
    await sql`
      insert into business_day (trading_date, opens_at, closes_at, source)
      values (${date}, ${dubai(date, '11')}::timestamptz,
              ${dubai(nextCalendarDate, '02')}::timestamptz, 'weekly')
      on conflict (trading_date) do nothing
    `
  }

  for (const code of ROOM_CODES) {
    const [room] = await sql<{ id: string }[]>`
      insert into rooms (code, name, room_type, capacity, display_order, notes)
      values (${code}, ${`Probe ${code}`}, 'standard'::room_type, 1, 95, ${MARKER})
      on conflict (code) do update set capacity = excluded.capacity
      returning id
    `
    rooms.set(code, (room as { id: string }).id)
  }

  const [service] = await sql<{ id: string }[]>`
    insert into service
      (style, treatment_key, slug, internal_name, public_display_name, turnaround_minutes,
       display_order)
    values ('asian', ${PROBE}, 'bui05-probe', 'Probe massage', 'Normal Massage (Asian)', 20, 97)
    on conflict (style, treatment_key) do update set turnaround_minutes = excluded.turnaround_minutes
    returning id
  `
  const serviceId = (service as { id: string }).id
  await sql`
    insert into service_room_type_compat (service_style, service_treatment_key, room_type)
    values ('asian', ${PROBE}, 'standard'::room_type)
    on conflict do nothing
  `
  await sql`
    insert into service_resource_shape
      (service_style, service_treatment_key, shape, therapists_required, rooms_required,
       min_room_capacity, required_room_type, therapist_buffer_minutes)
    values ('asian', ${PROBE}, 'solo'::service_shape, 1, 1, 1, null, 10)
    on conflict do nothing
  `
  const [variant] = await sql<{ id: string }[]>`
    insert into service_variant (service_id, duration_minutes, gross_price_fils, provisional_note)
    values (${serviceId}, 45, ${GROSS_FILS}, ${MARKER})
    on conflict (service_id, duration_minutes) do update set gross_price_fils = excluded.gross_price_fils
    returning id
  `
  variantId = (variant as { id: string }).id

  for (const reference of ROOM_CODES.map((code) => code.replace('room', 'therapist'))) {
    const [row] = await sql<{ id: string }[]>`
      insert into employee (staff_reference, gender, employed_from, notes)
      values (${reference}, 'female', '2099-01-01', ${MARKER})
      on conflict (staff_reference) do update set notes = excluded.notes
      returning id
    `
    const id = (row as { id: string }).id
    staff.push(id)
    await sql`
      insert into employee_skill (employee_id, skill) values (${id}, 'asian_style'::therapist_skill)
      on conflict do nothing
    `
    // The mandatory set IN FORCE, not a hard-coded pair: a fixture naming two of them stops meaning
    // "holds every mandatory document" the moment that answer changes (0054's header, brief rule 12).
    for (const type of await readMandatoryDocumentTypes(sql)) {
      await sql`
        insert into employee_document (employee_id, document_type, expires_on)
        values (${id}, ${type}::employee_document_type, '2099-12-31')
        on conflict do nothing
      `
    }
  }

  for (const [date, nextCalendarDate] of [
    [TRADING_DATE, NEXT_TRADING_DATE],
    [NEXT_TRADING_DATE, THIRD_TRADING_DATE],
    [THIRD_TRADING_DATE, DAY_AFTER],
  ] as const) {
    const [shift] = await sql<{ id: string }[]>`
      insert into shift (trading_date, period, label)
      values (${date},
              ${`[${dubai(date, '11')},${dubai(nextCalendarDate, '02')})`}::tstzrange, ${MARKER})
      returning id
    `
    for (const id of staff) {
      await sql`
        insert into shift_assignment (shift_id, employee_id)
        values (${(shift as { id: string }).id}, ${id})
      `
    }
  }

  // `booking.reminder` has to be a ROW because `message.template_id` is a foreign key. Nothing here sends,
  // but the maintainer's steps resolve their template by key and a suite that seeded none would prove less.
  await seedMessageTemplates(sql, DEFAULT_TEMPLATES)
}, 180_000)

afterAll(async () => {
  // The grants first, and by hand: `booking_manage_grant.booking_id` is a plain uuid with no foreign key
  // (0067's header records why, and that a cascade was tried), so nothing removes them with the bookings.
  // A suite that left them behind would leave live credentials for bookings that no longer exist.
  await sql`
    delete from booking_manage_grant
     where booking_id in (select id from booking where notes = ${MARKER})
  `
  await sql`delete from appointment where booking_id in (select id from booking where notes = ${MARKER})`
  await sql`delete from booking where notes = ${MARKER}`
  await sql`delete from shift_assignment where employee_id = any(${staff}::uuid[])`
  await sql`delete from shift where label = ${MARKER}`
  await sql`delete from employee_document where employee_id = any(${staff}::uuid[])`
  await sql`delete from employee_skill where employee_id = any(${staff}::uuid[])`
  await sql`delete from employee where notes = ${MARKER}`
  await sql`delete from service where treatment_key = ${PROBE}`
  await sql`delete from rooms where notes = ${MARKER}`
  await sql`delete from business_day where trading_date = any(${[...DATES]}::date[])`
  await sql`delete from customer where phone_e164 = any(${[PHONE, PHONE_AR]}::text[])`
  await browser?.close()
  await sql?.end({ timeout: 5 })
})

describe('acceptance — the token is hashed, single-purpose, expiring and revoked on cancellation', () => {
  it('stores no column that could hold a token, and stores the digest of the one it handed out', async () => {
    const { bookingId, token } = await bookWithLink({ key: 'hashed', slot: nextSlot() })
    expect(token).toHaveLength(BOOKING_TOKEN_LENGTH)

    const columns = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'booking_manage_grant'
       order by column_name
    `
    const names = columns.map((row) => row.column_name)
    // Enumerated, not searched: a `not.toContain('token')` would pass on a table that had grown a
    // `plaintext` column, and the failure this asserts against is somebody ADDING one.
    expect(names).toEqual([
      'booking_id',
      'created_at',
      'expires_at',
      'id',
      'issued_at',
      'purpose',
      'token_sha256',
    ])

    // The stronger half: the row really holds the digest and not the token. `sha256` computed by
    // PostgreSQL rather than by the same Node call the repository made, so the two sides agree
    // independently — a mint that stored the token would satisfy a comparison against itself.
    const [row] = await sql<{ token_sha256: string; pg_digest: string }[]>`
      select token_sha256, encode(sha256(${token}::bytea), 'hex') as pg_digest
        from booking_manage_grant where booking_id = ${bookingId}::uuid
    `
    expect(row?.token_sha256).toBe(row?.pg_digest)
    expect(row?.token_sha256).toBe(bookingTokenDigest(token))
    expect(row?.token_sha256).not.toBe(token)
    // And no column anywhere in the row carries the token as a substring, which is the assertion that
    // survives a column being added — the enumeration above tells you WHICH.
    const [asText] = await sql<{ row_text: string }[]>`
      select to_jsonb(booking_manage_grant.*)::text as row_text
        from booking_manage_grant where booking_id = ${bookingId}::uuid
    `
    expect(asText?.row_text).not.toContain(token)
    expect(asText?.row_text).toContain(bookingTokenDigest(token))
  })

  it('is single-purpose, and the database refuses a purpose core does not declare', async () => {
    const slot = nextSlot()
    const { bookingId } = await bookWithLink({ key: 'purpose', slot })
    // The vocabulary pinned in BOTH directions, which is the duplication the boundary forces: the CHECK
    // constraint restates `BOOKING_TOKEN_PURPOSES` because PostgreSQL cannot import it.
    const [check] = await sql<{ definition: string }[]>`
      select pg_get_constraintdef(oid) as definition from pg_constraint
       where conname = 'booking_manage_grant_purpose_known'
    `
    expect(check?.definition).toBeDefined()
    for (const purpose of BOOKING_TOKEN_PURPOSES) {
      expect(check?.definition, purpose).toContain(purpose)
    }
    await expect(
      sql`
        insert into booking_manage_grant (token_sha256, booking_id, purpose, issued_at, expires_at)
        values (${'f'.repeat(64)}, ${bookingId}::uuid, 'clinical_intake',
                ${new Date(nowFor(slot)).toISOString()}::timestamptz,
                ${new Date(bookingTokenExpiry(slot.endsAt)).toISOString()}::timestamptz)
      `,
    ).rejects.toThrow(/booking_manage_grant_purpose_known/)
    // The control: the declared purpose IS accepted, so the refusal above is about the value.
    await expect(
      sql`
        insert into booking_manage_grant (token_sha256, booking_id, purpose, issued_at, expires_at)
        values (${'e'.repeat(64)}, ${bookingId}::uuid, 'manage_booking',
                ${new Date(nowFor(slot)).toISOString()}::timestamptz,
                ${new Date(bookingTokenExpiry(slot.endsAt)).toISOString()}::timestamptz)
      `,
    ).resolves.toBeDefined()
    // The grant written straight in above carries no token anybody holds, so it is removed rather than left
    // as a live credential nothing can redeem. A DELETE, which is the revocation path (0067).
    await sql`delete from booking_manage_grant where token_sha256 = ${'e'.repeat(64)}`
  })

  it('expires at the appointment end plus 24 hours, asserted at the boundary under a frozen clock', async () => {
    const slot = nextSlot()
    const { token, expiresAtIso } = await bookWithLink({ key: 'expiry', slot })
    const expiresAt = Date.parse(expiresAtIso)
    expect(expiresAt).toBe(slot.endsAt + BOOKING_TOKEN_GRACE_SECONDS * 1000)
    // Not the START plus 24 hours, which is the arithmetic somebody writes when the period is to hand: for
    // a 45-minute treatment the two differ by 45 minutes and the mistake is invisible for a day.
    expect(expiresAt).not.toBe(slot.startsAt + BOOKING_TOKEN_GRACE_SECONDS * 1000)

    // Alive a millisecond before, dead at it. Both against the HTTP surface, because the expiry is only
    // worth something where it is enforced.
    expect((await readPage(token, expiresAt - 1)).status).toBe(200)
    expect((await readPage(token, expiresAt)).status).toBe(404)
    expect((await readPage(token, expiresAt + 60_000)).status).toBe(404)
  })

  it('is revoked by a cancellation, in the same transaction, for every link on the booking', async () => {
    const slot = nextSlot()
    const now = nowFor(slot)
    const booked = await bookWithLink({ key: 'revoke', slot })
    const second = await mintFor(booked.bookingId, slot, now + 1000)
    // Two live links, which is what a 24-hour and a 2-hour reminder leave: the mint is per SEND.
    expect(await grantCount(booked.bookingId)).toBe(2)
    expect((await readPage(booked.token, now)).status).toBe(200)
    expect((await readPage(second.token, now)).status).toBe(200)

    const before = await auditCount('booking_manage_grant.revoked')
    await cancelBookingTx(
      sql,
      {
        bookingId: booked.bookingId,
        to: 'cancelled_by_customer',
        actor: OWNER,
        reason: 'the fixture cancels it',
        nowMs: now,
      },
      { decide, classify, steps: maintainer },
    )
    expect(await grantCount(booked.bookingId)).toBe(0)
    // BOTH links, not the one that was presented. A revocation that took one would leave the customer who
    // cancelled by telephone still able to reschedule from the older SMS.
    expect((await readPage(booked.token, now)).status).toBe(404)
    expect((await readPage(second.token, now)).status).toBe(404)
    expect(await auditCount('booking_manage_grant.revoked')).toBeGreaterThan(before)
  })

  it('leaves a link alone when nothing was cancelled', async () => {
    // The control on the revocation. Without it, "revoked on cancellation" is satisfied by a repository
    // that deletes every grant on every write — and the page would 404 for every customer after any change.
    const slot = nextSlot()
    const booked = await bookWithLink({ key: 'no-revoke', slot })
    await transitionAppointmentTx(
      sql,
      { appointmentId: booked.appointmentId, to: 'checked_in', actor: OWNER },
      { decide, steps: maintainer },
    )
    expect(await grantCount(booked.bookingId)).toBe(1)
    expect((await readPage(booked.token, nowFor(slot))).status).toBe(200)
  })
})

describe('acceptance — one booking per token, and every refusal is the same 404', () => {
  it('answers a token with one character altered exactly as it answers an unknown one', async () => {
    const slot = nextSlot()
    const now = nowFor(slot)
    const { token } = await bookWithLink({ key: 'altered', slot })
    // One character, changed to another hex digit, so the SHAPE is still valid and the lookup really runs.
    // A character outside the alphabet would be refused by the regex before any query, which is a
    // different claim.
    const altered = `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`
    expect(altered).not.toBe(token)
    expect(altered).toHaveLength(token.length)

    const before = await auditCount('booking_manage_grant.refused')
    const alteredResponse = await readPage(altered, now)
    const unknownResponse = await readPage('9'.repeat(64), now)

    expect(alteredResponse.status).toBe(BOOKING_TOKEN_NOT_FOUND.status)
    expect(unknownResponse.status).toBe(BOOKING_TOKEN_NOT_FOUND.status)
    const alteredBody = await alteredResponse.text()
    const unknownBody = await unknownResponse.text()
    // Byte for byte. The criterion literally, and the reason the refusal document is a module constant with
    // nothing from the request reaching it.
    expect(Buffer.compare(Buffer.from(alteredBody), Buffer.from(unknownBody))).toBe(0)
    expect(alteredBody).toContain(BOOKING_TOKEN_NOT_FOUND.body.error)
    // Neither body carries the token it was asked about, and neither names a REASON. The prose does say
    // "may have expired, or ... may have been cancelled" — both, as one sentence, which is the honest thing
    // to tell a reader and says nothing about which. What must never appear is a refusal NAME, because that
    // is the vocabulary the audit row uses and the thing that would make two refusals distinguishable.
    for (const leak of [
      altered,
      token,
      'token_expired',
      'token_unknown',
      'token_not_for_this_purpose',
      'booking_not_manageable',
    ]) {
      expect(alteredBody, leak).not.toContain(leak)
    }
    // Every header a caller can see, compared as a map: a `cache-control` that differed would be an oracle
    // as surely as a body that did.
    expect([...alteredResponse.headers.entries()].sort()).toEqual(
      [...unknownResponse.headers.entries()].sort(),
    )
    // Two attempts, two audit rows. The `audit_event` row is the only record of WHY, because the response
    // cannot carry one. A delta, counted in SQL.
    expect(await auditCount('booking_manage_grant.refused')).toBe(before + 2)

    // The control on the comparison: a VALID token answers something else entirely. Without it, both
    // assertions above pass for a route that 404s everything.
    const valid = await readPage(token, now)
    expect(valid.status).toBe(200)
    expect(Buffer.compare(Buffer.from(await valid.text()), Buffer.from(alteredBody))).not.toBe(0)
  })

  it('records the reason it refused, and records it only in the audit row', async () => {
    const slot = nextSlot()
    const { token } = await bookWithLink({ key: 'reasons', slot })
    const expiredAt = Date.parse(
      (
        await sql<{ expires_at: Date }[]>`
        select expires_at from booking_manage_grant where token_sha256 = ${bookingTokenDigest(token)}
      `
      )[0]?.expires_at.toISOString() ?? '',
    )
    await readPage(token, expiredAt + 1)
    const [row] = await sql<{ after_state: { reason: string; grant_present: boolean } }[]>`
      select after_state from audit_event
       where action = 'booking_manage_grant.refused'
       order by occurred_at desc, id desc limit 1
    `
    expect(row?.after_state.reason).toBe('token_expired')
    expect(row?.after_state.grant_present).toBe(true)
    // The other side of the same pair: an unknown token records that no row was found, which is every
    // mistyped, forged and swept link at once — and is not the token.
    await readPage('8'.repeat(64), nowFor(slot))
    const [unknown] = await sql<{ after_state: { reason: string; grant_present: boolean } }[]>`
      select after_state from audit_event
       where action = 'booking_manage_grant.refused'
       order by occurred_at desc, id desc limit 1
    `
    expect(unknown?.after_state.reason).toBe('token_unknown')
    expect(unknown?.after_state.grant_present).toBe(false)
    expect(JSON.stringify(unknown?.after_state)).not.toContain('8'.repeat(64))
  })

  it('costs no query and writes no audit row for a token that is not a token', async () => {
    // A malformed token is refused by a regex. The audit delta is ZERO, deliberately: an unauthenticated
    // page must not let a flood of rubbish become a flood of inserts into an append-only table.
    const before = await auditCount('booking_manage_grant.refused')
    for (const rubbish of [null, '', 'not-a-token', 'A'.repeat(64), '0'.repeat(63)]) {
      expect((await readPage(rubbish, Date.parse('2099-12-20T12:00:00Z'))).status).toBe(404)
    }
    expect(await auditCount('booking_manage_grant.refused')).toBe(before)
  })

  it('grants exactly one booking, and a second booking needs its own token', async () => {
    const firstSlot = nextSlot()
    const secondSlot = nextSlot()
    const first = await bookWithLink({ key: 'one-a', slot: firstSlot })
    const second = await bookWithLink({ key: 'one-b', slot: secondSlot })
    const firstBody = await (await readPage(first.token, nowFor(firstSlot))).text()
    const secondBody = await (await readPage(second.token, nowFor(secondSlot))).text()
    // The reference is the TAIL of the uuid, and this case is why: `uuid_generate_v7()` puts a millisecond
    // timestamp in the leading twelve hex digits, so a reference taken from the front is the SAME string for
    // two bookings made in one second — which is what the first draft of this assertion found.
    const reference = (id: string): string => id.replace(/-/g, '').slice(-8)
    expect(reference(first.bookingId)).not.toBe(reference(second.bookingId))
    expect(firstBody).toContain(reference(first.bookingId))
    expect(secondBody).toContain(reference(second.bookingId))
    // Neither page names the other booking, which is what "exactly one" means when both are the same
    // customer's — the grant is the statement of which one, and there is no second half of the URL to
    // disagree with it.
    expect(firstBody).not.toContain(reference(second.bookingId))
    expect(secondBody).not.toContain(reference(first.bookingId))
  })
})

describe('acceptance — the customer write is the staff write', () => {
  it('holds the same function reference the front desk calls', () => {
    // A shared REFERENCE and not behavioural similarity, which is the criterion's own words. Two
    // implementations that agree today are how two implementations come to disagree quietly, and a
    // behavioural test cannot tell one function from two that match.
    expect(MANAGE_BOOKING_WRITE_PATHS.reschedule).toBe(rescheduleAppointmentTx)
    expect(MANAGE_BOOKING_WRITE_PATHS.cancel).toBe(cancelBookingTx)
    // The rules are shared too, which is the half a reference to the write path does not cover: a second
    // copy of `cancellationVerdictFor` would make the window a different number on this surface.
    expect(MANAGE_BOOKING_WRITE_PATHS.classify).toBe(cancellationVerdictFor)
    expect(MANAGE_BOOKING_WRITE_PATHS.decide).toBe(decideAppointmentTransition)
    expect(MANAGE_BOOKING_WRITE_PATHS.recheck).toBe(recheckShapeAssignment)
    // The control: identity is being asserted, not truthiness. A wrapper would fail this.
    expect(MANAGE_BOOKING_WRITE_PATHS.reschedule).not.toBe(cancelBookingTx)
  })

  it('obeys the cancellation window identically, judged at the same instant', async () => {
    // Outside the window (two days out) and inside it (one hour out), for the link holder and for the
    // front desk, at the same instants. The FLAG is the criterion: the policy is provisional against
    // Y9-windows and charges nothing, so "obeys" means the same verdict and the same record, not a refusal.
    const outsideSlot = nextSlot()
    const insideSlot = nextSlot()
    const outside = await bookWithLink({ key: 'window-out', slot: outsideSlot })
    const inside = await bookWithLink({ key: 'window-in', slot: insideSlot })
    const insideNow = insideSlot.startsAt - 60 * 60 * 1000

    const linkOutside = await postPage(outside.token, { intent: 'cancel' }, nowFor(outsideSlot))
    expect(linkOutside.status).toBe(200)
    const linkInside = await postPage(inside.token, { intent: 'cancel' }, insideNow)
    expect(linkInside.status).toBe(200)

    const flagOf = async (appointmentId: string): Promise<boolean> => {
      const [row] = await sql<{ late: boolean }[]>`
        select late_cancellation as late from appointment where id = ${appointmentId}
      `
      return row?.late === true
    }
    expect(await flagOf(outside.appointmentId)).toBe(false)
    expect(await flagOf(inside.appointmentId)).toBe(true)

    // The same two instants through the STAFF path, on their own bookings, and the flags match.
    const staffOutsideSlot = nextSlot()
    const staffInsideSlot = nextSlot()
    const staffOutside = await book({ key: 'staff-out', slot: staffOutsideSlot })
    const staffInside = await book({ key: 'staff-in', slot: staffInsideSlot })
    await cancelBookingTx(
      sql,
      {
        bookingId: staffOutside.bookingId,
        to: 'cancelled_by_customer',
        actor: OWNER,
        reason: 'the desk cancels it',
        nowMs: nowFor(staffOutsideSlot),
      },
      { decide, classify, steps: maintainer },
    )
    await cancelBookingTx(
      sql,
      {
        bookingId: staffInside.bookingId,
        to: 'cancelled_by_customer',
        actor: OWNER,
        reason: 'the desk cancels it',
        nowMs: staffInsideSlot.startsAt - 60 * 60 * 1000,
      },
      { decide, classify, steps: maintainer },
    )
    expect(await flagOf(staffOutside.appointmentId)).toBe(false)
    expect(await flagOf(staffInside.appointmentId)).toBe(true)
  })

  it('creates no payment, invoice or ledger row for a cancellation from this page', async () => {
    // B-LIFE-03's criterion, re-asserted from this surface because it is the surface a customer reaches:
    // the window is provisional and charges nothing, and deltas of zero are what says so. Counted in SQL.
    const counts = async (): Promise<Record<string, number>> => {
      const out: Record<string, number> = {}
      for (const table of ['invoice', 'invoice_line', 'journal_entry', 'journal_line'] as const) {
        const [row] = await sql<{ count: string }[]>`
          select count(*)::text as count from ${sql(table)}
        `
        out[table] = Number(row?.count ?? '0')
      }
      return out
    }
    const slot = nextSlot()
    const booked = await bookWithLink({ key: 'no-money', slot })
    const before = await counts()
    expect((await postPage(booked.token, { intent: 'cancel' }, nowFor(slot))).status).toBe(200)
    expect(await counts()).toEqual(before)
  })

  it('refuses a move the principal may not make, from the policy layer', () => {
    // The cage, at the decision the write path consults. A link holder may cancel their own appointment and
    // may not mark it a no-show; `principals/customer-link.ts` records why that is a principal and not a
    // role, and this is the assertion that the lifecycle agrees.
    const caller = LINK_HOLDER.principal as string
    expect(caller).toBe(CUSTOMER_LINK_PRINCIPAL)
    expect(decide('confirmed', 'cancelled_by_customer', caller, null).kind).toBe('allowed')
    expect(decide('confirmed', 'no_show', caller, 'a reason').kind).toBe('refused')
    expect(decide('confirmed', 'cancelled_by_salon', caller, 'a reason').kind).toBe('refused')
    // And the ROLE the history row stores is one of the eight, which is the other half of the same
    // decision: the `system` role holds neither booking capability, so a surface that sent the role to the
    // policy layer instead of the principal would be refused every move it exists to make.
    expect(LINK_HOLDER.role).toBe('system')
    expect(decide('confirmed', 'cancelled_by_customer', LINK_HOLDER.role, null).kind).toBe(
      'refused',
    )
  })
})

describe('acceptance — the page renders only the declared allowlist', () => {
  it('prints every declared field and no clinical, contraindication or intake field name', async () => {
    const slot = nextSlot()
    const { token } = await bookWithLink({ key: 'allowlist', slot })
    const body = await (await readPage(token, nowFor(slot))).text()
    const lower = body.toLowerCase()

    for (const marker of CLINICAL_FIELD_MARKERS) {
      expect(lower, `the response body contains '${marker}'`).not.toContain(marker)
    }
    // The control on the search. Without it, the sweep above is satisfied by a body the search cannot
    // read — a minifier, a different encoding, an empty string — and a gate that cannot fire is not a gate.
    const planted = `${body}<p>contraindication</p>`
    expect(CLINICAL_FIELD_MARKERS.some((marker) => planted.toLowerCase().includes(marker))).toBe(
      true,
    )

    // The positive half: every declared field really is on the page. Asserted through the field NAMES'
    // values rather than the labels, because a label is copy the owner may reword.
    expect(MANAGE_BOOKING_FIELDS.length).toBeGreaterThan(5)
    expect(body).toContain('data-manage-region="facts"')
    // Ten `<dt>`/`<dd>` pairs, one per declared field, so a field silently dropped from the render fails
    // here rather than being noticed by nobody.
    expect((body.match(/<dt>/g) ?? []).length).toBe(MANAGE_BOOKING_FIELDS.length)

    // And the three absences that are decisions rather than omissions.
    expect(body).not.toContain(PHONE)
    expect(lower).not.toContain('fils')
    expect(lower).not.toContain(GROSS_FILS.toString())
  })

  it('renders the Arabic customers page in Arabic, from the row and not from a header', async () => {
    const arabicSlot = nextSlot()
    const { token } = await bookWithLink({ key: 'arabic', slot: arabicSlot, arabic: true })
    const body = await (await readPage(token, nowFor(arabicSlot))).text()
    expect(body).toContain('<html lang="ar" dir="rtl">')
    // The control: the English customer's page is not Arabic, so the language really comes from the row.
    const englishSlot = nextSlot()
    const english = await bookWithLink({ key: 'english', slot: englishSlot })
    expect(await (await readPage(english.token, nowFor(englishSlot))).text()).toContain(
      '<html lang="en" dir="ltr">',
    )
  })

  it('carries the noindex header and the no-referrer policy on every response', async () => {
    // The token is in the path, so every outbound link would otherwise carry it in a Referer, and an
    // indexed copy of this page is a published credential.
    const slot = nextSlot()
    const { token } = await bookWithLink({ key: 'headers', slot })
    const now = nowFor(slot)
    for (const response of [await readPage(token, now), await readPage('7'.repeat(64), now)]) {
      expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive')
      expect(response.headers.get('referrer-policy')).toBe('no-referrer')
      expect(response.headers.get('cache-control')).toBe('no-store')
    }
  })

  it('is the route the registry declares, at the path the link builder builds', () => {
    const entry = routeByPath('/booking/[token]')
    expect(entry?.id).toBe('manage-booking')
    // A handler and not a document, which `render.ts` explains: a document would need a live token in
    // `sampleParams` and would publish the token in its own hreflang set.
    expect(entry?.kind).toBe('handler')
    expect(entry?.indexable).toBe(false)
    expect(entry?.sitemap).toBe(false)
    // The two spellings of one path held together: the registry's pattern and the builder's prefix.
    expect(entry?.path).toBe(`${MANAGE_BOOKING_PATH_PREFIX}[token]`)
    expect(manageBookingPath('abc')).toBe('/booking/abc')
  })
})

describe('acceptance — a reschedule supersedes the previous reminders and creates new ones', () => {
  it('moves the booking, supersedes the old steps and builds the successors', async () => {
    const slot = nextSlot()
    const now = nowFor(slot)
    const booked = await bookWithLink({ key: 'resched', slot })
    const beforeSteps = await scheduledStepsFor(sql, booked.appointmentId)
    // Two pending steps, from the confirmation. Stated so the assertion below is about a CHANGE.
    expect(beforeSteps.map((step) => step.state)).toEqual(['pending', 'pending'])
    const oldKeys = beforeSteps.map((step) => step.invalidationKey).sort()

    const moved = twoHoursOn(slot).startsAt
    const response = await postPage(
      booked.token,
      { intent: 'reschedule', startsAt: localInput(moved) },
      now,
    )
    // A 303 back to the SAME token: the grant names the booking and a successor is a new row in it, so the
    // link survives the move.
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe(`/booking/${booked.token}?done=rescheduled`)

    const after = await scheduledStepsFor(sql, booked.appointmentId)
    expect(after.map((step) => step.state)).toEqual(['superseded', 'superseded'])
    for (const step of after) expect(step.settledAtIso).not.toBeNull()

    const [successor] = await sql<{ id: string; starts_at: Date }[]>`
      select id::text as id, lower(period) as starts_at
        from appointment
       where rescheduled_from_id = ${booked.appointmentId}::uuid
    `
    expect(successor?.starts_at.getTime()).toBe(moved)
    const successorSteps = await scheduledStepsFor(sql, successor?.id as string)
    expect(successorSteps.map((step) => step.state)).toEqual(['pending', 'pending'])
    // New KEYS, not new rows with the old keys: the key is derived from the appointment and its period, and
    // a successor carrying the predecessor's key is a reminder about a period that no longer exists.
    expect(successorSteps.map((step) => step.invalidationKey).sort()).not.toEqual(oldKeys)
    expect(new Set(successorSteps.map((step) => step.invalidationKey)).size).toBe(2)

    // The page now shows the new period, through the same link.
    const reread = await readPage(booked.token, now, 'done=rescheduled')
    expect(reread.status).toBe(200)
    const body = await reread.text()
    expect(body).toContain('data-manage-state="rescheduled"')
  })

  it('refuses a slot that is taken, by name, and leaves the steps alone', async () => {
    const slot = nextSlot()
    const target = twoHoursOn(slot)
    const mine = await bookWithLink({ key: 'clash-a', slot })
    // A second booking holding the slot the first will ask for, in the SAME room and with the same
    // therapist, so the exclusion constraint and the capacity trigger are what answer.
    await book({ key: 'clash-b', slot: target })
    const nowMs = nowFor(slot)
    const response = await postPage(
      mine.token,
      { intent: 'reschedule', startsAt: localInput(target.startsAt) },
      nowMs,
    )
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe(`/booking/${mine.token}?refused=slot_taken`)
    // Nothing moved and nothing was superseded: the refusal is the transaction rolling back, not a
    // compensating write.
    const steps = await scheduledStepsFor(sql, mine.appointmentId)
    expect(steps.map((step) => step.state)).toEqual(['pending', 'pending'])
    // And the page has words for it, which is what a named refusal is for.
    const body = await (await readPage(mine.token, nowMs, 'refused=slot_taken')).text()
    expect(body).toContain('data-manage-refusal="slot_taken"')
  })

  it('refuses a time the salon is not open, and a time it cannot read', async () => {
    const slot = nextSlot()
    const booked = await bookWithLink({ key: 'closed', slot })
    const nowMs = nowFor(slot)
    // 05:00 is inside the daytime gap: trading runs 11:00–02:00, so no trading date claims it.
    const closed = await postPage(
      booked.token,
      { intent: 'reschedule', startsAt: localInput(at(slot.tradingDate, '05')) },
      nowMs,
    )
    expect(closed.headers.get('location')).toContain('refused=new_slot_outside_trading')
    // A value the form could not have produced.
    const unreadable = await postPage(
      booked.token,
      { intent: 'reschedule', startsAt: 'tomorrow evening' },
      nowMs,
    )
    expect(unreadable.headers.get('location')).toBe(
      `/booking/${booked.token}?refused=new_period_invalid`,
    )
    expect((await scheduledStepsFor(sql, booked.appointmentId)).map((s) => s.state)).toEqual([
      'pending',
      'pending',
    ])
  })

  it('offers nothing to change once the booking is terminal, and refuses a form that says otherwise', async () => {
    const slot = nextSlot()
    const booked = await bookWithLink({ key: 'terminal', slot })
    const nowMs = nowFor(slot)
    const cancelled = await postPage(booked.token, { intent: 'cancel' }, nowMs)
    expect(cancelled.status).toBe(200)
    const body = await cancelled.text()
    // Rendered rather than redirected, because the cancellation revoked the link the redirect would go to.
    expect(body).toContain('data-manage-state="cancelled"')
    expect(body).toContain('data-manage-region="closed"')
    expect(body).not.toContain('data-manage-region="reschedule"')
    // And the link really is dead now, which is the same claim from the other side.
    expect((await readPage(booked.token, nowMs)).status).toBe(404)
  })
})

/** A Dubai instant as the `datetime-local` value a form submits. No offset, which is the whole point. */
function localInput(ms: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dubai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(ms))
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`
}

/** One cell of the matrix: a viewport, a theme and a direction. Three times two times two. */
interface Cell {
  readonly width: number
  readonly height: number
  readonly theme: 'light' | 'dark'
  readonly direction: 'ltr' | 'rtl'
  readonly viewportName: string
}

const CELLS: readonly Cell[] = VIEWPORTS.flatMap((viewport) =>
  THEMES.flatMap((theme) =>
    DIRECTIONS.map((direction) => ({
      width: viewport.width,
      height: viewport.height,
      theme,
      direction,
      viewportName: viewport.name,
    })),
  ),
)

describe('acceptance — axe is clean and the render is reproducible', () => {
  /**
   * The document under the camera, for one cell.
   *
   * `setContent` rather than `goto`, because `render.ts` is pure and the bytes it produces ARE the
   * response — so there is no server to start, no port to draw (brief rule 18) and nothing between the
   * renderer and the assertion. The direction axis is the LOCALE, exactly as the registry matrix has it: an
   * RTL cell is the Arabic customer's document, not the English one with an attribute flipped.
   */
  async function withCell<T>(
    cell: Cell,
    html: string,
    body: (page: Page) => Promise<T>,
  ): Promise<T> {
    const context: BrowserContext = await browser.newContext({
      viewport: { width: cell.width, height: cell.height },
      deviceScaleFactor: 1,
      colorScheme: cell.theme,
      locale: cell.direction === 'rtl' ? 'ar-AE' : 'en-AE',
      timezoneId: 'Asia/Dubai',
      reducedMotion: 'reduce',
    })
    try {
      const page = await context.newPage()
      await page.setContent(html, { waitUntil: 'load' })
      await page.addStyleTag({ content: DETERMINISM_CSS })
      await page.evaluate(async () => {
        await document.fonts.ready
      })
      return await body(page)
    } finally {
      await context.close()
    }
  }

  const backgroundLuminance = (page: Page): Promise<number> =>
    page.evaluate(() => {
      const colour = globalThis.getComputedStyle(document.body).backgroundColor
      const parts = colour.match(/\d+(\.\d+)?/g)?.map(Number) ?? [255, 255, 255]
      const [r, g, b] = [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0]
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    })

  let english = ''
  let arabic = ''

  beforeAll(async () => {
    const enSlot = nextSlot()
    const arSlot = nextSlot()
    const en = await bookWithLink({ key: 'shot-en', slot: enSlot })
    const ar = await bookWithLink({ key: 'shot-ar', slot: arSlot, arabic: true })
    english = await (await readPage(en.token, nowFor(enSlot))).text()
    arabic = await (await readPage(ar.token, nowFor(arSlot))).text()
    expect(english).toContain('data-manage-region="reschedule"')
    expect(arabic).toContain('<html lang="ar" dir="rtl">')
  }, 120_000)

  const documentFor = (cell: Cell): string => (cell.direction === 'rtl' ? arabic : english)

  it('reports zero serious or critical violations in all twelve cells', async () => {
    // Twelve, stated rather than counted after the fact: a matrix that lost an axis would report a pass
    // over six renders.
    expect(VIEWPORTS).toHaveLength(3)
    expect(THEMES).toHaveLength(2)
    expect(DIRECTIONS).toHaveLength(2)
    expect(CELLS).toHaveLength(12)

    const luminance: Record<string, number> = {}
    let audited = 0
    for (const cell of CELLS) {
      const where = `${cell.viewportName} ${cell.theme} ${cell.direction}`
      const { violations, width, dir, lum } = await withCell(
        cell,
        documentFor(cell),
        async (page) => {
          const result = await auditPage(page, {
            page: 'manage-booking',
            viewport: {
              name: cell.viewportName,
              width: cell.width,
              height: cell.height,
              scale: 1,
              why: 'B-UI-05 acceptance',
            },
            theme: cell.theme,
            direction: cell.direction,
          })
          return {
            violations: result.violations,
            width: await page.evaluate(() => globalThis.innerWidth),
            dir: await page.evaluate(() => document.documentElement.getAttribute('dir')),
            lum: await backgroundLuminance(page),
          }
        },
      )
      // Each render is the cell it claims to be. Without this, twelve identical light LTR audits would
      // satisfy the count and the labels would be the only thing that differed.
      expect(width, `${where}: viewport`).toBe(cell.width)
      expect(dir, `${where}: direction`).toBe(cell.direction)
      luminance[where] = lum
      const blocking = blockingViolations(violations)
      expect(
        blocking.map(describeViolation),
        `${where}: ${blocking.length} serious/critical violation(s)`,
      ).toEqual([])
      audited += 1
    }
    expect(audited).toBe(12)
    // The theme axis is real: the dark cell resolved a darker ground at every width and in both directions.
    for (const viewport of VIEWPORTS) {
      for (const direction of DIRECTIONS) {
        expect(
          luminance[`${viewport.name} dark ${direction}`],
          `${viewport.name} ${direction}: dark is darker than light`,
        ).toBeLessThan(luminance[`${viewport.name} light ${direction}`] ?? 0)
      }
    }
  }, 600_000)

  it('finds the two defects a known-bad version of this page has, by rule id', async () => {
    // The control on the audit itself. A sweep that reported zero because axe never ran would pass the case
    // above for ever (ADR 0003), so the page is audited again with an unlabelled button and body text on the
    // decorative gold — the two failures docs/08 fences off — injected into the DOM.
    const cell = CELLS[0] as Cell
    const violations = await withCell(cell, english, async (page) => {
      await page.evaluate(() => {
        const button = document.createElement('button')
        button.type = 'button'
        document.body.append(button)
        const text = document.createElement('p')
        text.textContent = 'Move this booking'
        const root = globalThis.getComputedStyle(document.documentElement)
        text.style.color = root.getPropertyValue('--color-decor-gold')
        text.style.backgroundColor = root.getPropertyValue('--color-surface-sand')
        document.body.append(text)
      })
      const result = await auditPage(page, {
        page: 'manage-booking (known-bad)',
        viewport: {
          name: cell.viewportName,
          width: cell.width,
          height: cell.height,
          scale: 1,
          why: 'the control',
        },
        theme: cell.theme,
        direction: cell.direction,
      })
      return result.violations
    })
    const ids = violations.map((violation) => violation.id)
    expect(ids, JSON.stringify(violations.map(describeViolation))).toContain('button-name')
    expect(ids, JSON.stringify(violations.map(describeViolation))).toContain('color-contrast')
    expect(blockingViolations(violations).map((violation) => violation.id)).toContain('button-name')
  }, 180_000)

  it('captures 3 viewports x 2 themes x 2 directions with zero pixel diff on a repeat run', async () => {
    mkdirSync(SCREENS, { recursive: true })
    const shots = new Map<string, Uint8Array>()
    for (const cell of CELLS) {
      const label = `manage-booking__${cell.theme}-${cell.viewportName}-${cell.direction}`
      /*
        Through `captureUntilStable` rather than comparing capture one to capture two, because that also
        asserts paint had SETTLED by the first capture — untrue at load 10 on a four-core box. The helper
        throws `[screenshot-never-stabilised]` when no two consecutive captures agree, which is exactly what
        a clock or a generated id reaching the render produces. Nothing in `render.ts` reads either, which is
        what this case is here to keep true.
      */
      const stable = await captureUntilStable(
        () =>
          withCell(cell, documentFor(cell), (page) =>
            page.screenshot({ fullPage: true, type: 'png', animations: 'disabled' }),
          ),
        { label },
      )
      expect(stable.png.byteLength, label).toBeGreaterThan(1000)
      expect(stable.attemptsUsed, `${label} settled in`).toBeLessThanOrEqual(5)
      shots.set(label, stable.png)
      writeFileSync(join(SCREENS, `${label}.png`), stable.png)
    }
    expect(shots.size).toBe(12)

    // The control on the comparison: different cells are not identical. Without it, a screenshot function
    // that returned the same bytes every time would pass every assertion above.
    const differs = (left: string, right: string): number =>
      Buffer.compare(
        Buffer.from(shots.get(left) ?? new Uint8Array()),
        Buffer.from(shots.get(right) ?? new Uint8Array()),
      )
    const first = VIEWPORTS[0]?.name as string
    const last = VIEWPORTS[2]?.name as string
    expect(
      differs(`manage-booking__light-${first}-ltr`, `manage-booking__dark-${first}-ltr`),
    ).not.toBe(0)
    expect(
      differs(`manage-booking__light-${first}-ltr`, `manage-booking__light-${last}-ltr`),
    ).not.toBe(0)
    expect(
      differs(`manage-booking__light-${first}-ltr`, `manage-booking__light-${first}-rtl`),
    ).not.toBe(0)
  }, 600_000)
})
