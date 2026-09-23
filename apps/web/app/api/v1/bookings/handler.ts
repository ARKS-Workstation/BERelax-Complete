import {
  ASIA_DUBAI,
  blocklistKeysFor,
  decideBlocklist,
  decideCustomerLifecycle,
  type Fils,
  type Instant,
  type LocalDate,
  localDate,
  localTime,
  normalisePhoneResult,
  type PhoneRejection,
  type PriceListId,
  type PriceListLayer,
  type PromotionId,
  type ResolvedPrice,
  recheckShapeAssignment,
  resolvePrice,
  resolveTradingDate,
  selectEffectivePriceList,
  type TradingHours,
  toLocal,
} from '@berelax/core'
import {
  type Actor,
  applyCustomerLifecycleEvent,
  type BlocklistMatcher,
  type BookingDeliveryInput,
  type BookingRefusal,
  bookingRefusalOf,
  bookSlot,
  type CreatedBooking,
  crmRefusalOf,
  ensureCustomer,
  evaluateBlocklist,
  type LifecycleDecider,
  readGenderMatching,
  type SlotRecheck,
  type Sql,
  withUnitOfWork,
} from '@berelax/db'
import type { ServiceShape } from '@berelax/shared'

/**
 * `POST /api/v1/bookings` — the public booking endpoint.
 *
 * The logic lives here rather than in `route.ts` so it can be called with its dependencies supplied,
 * which is what lets `apps/web/src/bookings-route.itest.ts` drive it against a real PostgreSQL with a
 * frozen clock. `route.ts` builds those dependencies from the environment and does nothing else.
 *
 * ## The idempotency key is a header, and it is required
 *
 * `Idempotency-Key`, the conventional spelling, and **only** there — not also a body field. Two
 * spellings of one key is a retry that presents as a second booking the first time a client fills in
 * the other one. A request without it is refused with `400 idempotency_key_required` before anything is
 * read, because a booking endpoint that cannot tell a retry from a second booking will eventually take
 * two slots for one customer, and the way that is discovered is two therapists rostered for one person.
 *
 * ## What this endpoint decides and what it refuses to decide
 *
 * The **price** is resolved here, from the catalogue, and never taken from the request. A client-supplied
 * figure is a client-supplied discount. `resolvePrice` (B-CAT-04) is the chain and its result is
 * snapshotted onto every appointment row by the transaction, so a later price-list change cannot move it
 * (B-CAT-05).
 *
 * The **trading date** is resolved with `resolveTradingDate` from the hours `business_day` holds, never
 * from the calendar date of the start instant: a trading session runs past midnight, so 01:30 belongs to
 * the PREVIOUS trading date, and `appointment.trading_date` is a foreign key into that calendar. The
 * hours themselves are premises data and are never written down here (W-SITE-02, B-CAT-06).
 *
 * The **tuple** — which therapists, which room — is the caller's, because the caller is the booking flow
 * that offered it and the customer chose from what they were shown. It is re-validated inside the
 * transaction rather than trusted, and a tuple that is no longer deliverable is `409 slot_taken` rather
 * than a room silently swapped underneath the confirmation the customer has already seen.
 *
 * The **gender rule** is not re-opened. `readGenderMatching` is read once and passed through, so an
 * absent or unreadable setting means strict here exactly as it does in the solver (B-AVAIL-05), and a
 * booking whose client gender was never collected has no eligible therapist rather than a relaxed one.
 */

/** The body this endpoint accepts. Anything else is a 400, before any work is done. */
export interface BookingRequestBody {
  readonly phone?: unknown
  /** Optional. Collected only so the blocklist can be matched on it; nothing stores it (C-CRM-01). */
  readonly email?: unknown
  readonly source?: unknown
  readonly clientGender?: unknown
  readonly notes?: unknown
  readonly deliveries?: unknown
}

export interface BookingEndpointDeps {
  readonly sql: Sql
  /** Injected, so the integration suite can freeze it. Lead time is measured from this and nothing else. */
  readonly now: () => Instant
}

/** Every reason this endpoint refuses, as a value. The UI branches on these, never on prose. */
export const BOOKING_ENDPOINT_ERRORS = [
  'idempotency_key_required',
  'invalid_request',
  'phone_not_eligible',
  'unknown_service_variant',
  'outside_trading_hours',
  'no_applicable_price',
  'requires_client_gender',
  'slot_unavailable',
  'conflict',
] as const
export type BookingEndpointError = (typeof BOOKING_ENDPOINT_ERRORS)[number]

/** The header the key is read from. One spelling, named once. */
export const IDEMPOTENCY_HEADER = 'idempotency-key'

/**
 * The actor on a public booking request.
 *
 * `customer` with no id, and a label rather than a name: the request is made on a customer's behalf and
 * the audit trail should say so, but a guest booking has proved nothing about who they are (ADR 0014).
 * This system invents no names for people.
 */
const CALLER: Actor = { kind: 'customer', label: 'Public booking (unauthenticated)' }

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // A booking response is never cacheable and never shared. Said explicitly because a CDN with a
      // default policy would serve one customer's confirmation to another.
      'cache-control': 'no-store',
    },
  })

interface ParsedDelivery {
  readonly serviceVariantId: string
  readonly shape: ServiceShape
  readonly roomId: string
  readonly therapistIds: readonly string[]
  readonly startsAt: Instant
}

interface ParsedRequest {
  readonly phone: string
  readonly email?: string
  readonly source: 'online' | 'phone' | 'front_desk' | 'walk_in'
  readonly clientGender?: 'female' | 'male'
  readonly notes?: string
  readonly deliveries: readonly ParsedDelivery[]
}

const SHAPES: readonly string[] = ['solo', 'four_hands', 'couple']
const SOURCES: readonly string[] = ['online', 'phone', 'front_desk', 'walk_in']
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * One delivery of the request body, or `null`.
 *
 * Ids are checked against the uuid form here so a malformed one is a 400 rather than a `22P02` from the
 * driver three statements into a transaction.
 */
function readDelivery(raw: unknown): ParsedDelivery | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { serviceVariantId, shape, roomId, therapistIds, startsAt } = raw as Record<string, unknown>
  if (typeof serviceVariantId !== 'string' || !UUID.test(serviceVariantId)) return null
  if (typeof shape !== 'string' || !SHAPES.includes(shape)) return null
  if (typeof roomId !== 'string' || !UUID.test(roomId)) return null
  if (!Array.isArray(therapistIds) || therapistIds.length === 0 || therapistIds.length > 4) {
    return null
  }
  if (!therapistIds.every((id) => typeof id === 'string' && UUID.test(id))) return null
  if (typeof startsAt !== 'string') return null
  const instant = Date.parse(startsAt)
  if (Number.isNaN(instant)) return null
  return {
    serviceVariantId,
    shape: shape as ServiceShape,
    roomId,
    therapistIds: therapistIds as string[],
    startsAt: instant as Instant,
  }
}

/**
 * Reads the body, refusing anything unexpected rather than defaulting it.
 *
 * An unrecognised `shape` is a 400 and not a silent fall back to `solo`: the shape decides how many
 * therapists are rostered and which room is held, and a typo that quietly became the cheapest footprint
 * is the wrong direction for that to fail in.
 */
export function readBookingBody(body: unknown): ParsedRequest | null {
  if (typeof body !== 'object' || body === null) return null
  const { phone, email, source, clientGender, notes, deliveries } = body as BookingRequestBody
  if (typeof phone !== 'string' || phone.length === 0 || phone.length > 32) return null
  // 254 is the RFC 5321 forward-path limit, the same bound `normaliseEmail` applies. A malformed
  // address is NOT a 400: the field is optional and the only thing this endpoint does with it is check
  // the blocklist, so refusing the booking over a typo in a field nobody has to fill in would make the
  // blocklist visible by its side effects.
  if (email !== undefined && (typeof email !== 'string' || email.length > 254)) return null
  if (source !== undefined && !SOURCES.includes(String(source))) return null
  if (clientGender !== undefined && clientGender !== 'female' && clientGender !== 'male')
    return null
  if (notes !== undefined && (typeof notes !== 'string' || notes.length > 2_000)) return null
  if (!Array.isArray(deliveries) || deliveries.length === 0 || deliveries.length > 8) return null

  const parsed: ParsedDelivery[] = []
  for (const raw of deliveries) {
    const entry = readDelivery(raw)
    if (entry === null) return null
    parsed.push(entry)
  }
  return {
    phone,
    source: source === undefined ? 'online' : (source as ParsedRequest['source']),
    deliveries: parsed,
    ...(email === undefined ? {} : { email }),
    ...(clientGender === undefined ? {} : { clientGender }),
    ...(notes === undefined ? {} : { notes }),
  }
}

/**
 * `recheckShapeAssignment` from `@berelax/core`, as the `SlotRecheck` the booking transaction injects.
 *
 * `satisfies` and not a cast: `packages/db` may not import `packages/core`, so `SlotRecheck` and
 * `ShapeRecheckInput` are two declarations of one shape, and this line is what makes a field added to
 * one and not the other a `pnpm typecheck` failure rather than a booking that re-checked nothing. The
 * adapter itself lives in core beside `assignShape` so there is exactly one of it — this route and
 * `packages/fixtures/src/booking-transaction.itest.ts` pass the same function.
 */
export const coreSlotRecheck = recheckShapeAssignment satisfies SlotRecheck

interface VariantRow {
  readonly id: string
  readonly duration_minutes: number
  readonly gross_price_fils: string
}

/**
 * The hours `business_day` holds around a candidate date, as the `HoursForDate` the resolver takes.
 *
 * Read as *hours* and handed to `resolveTradingDate` rather than answered with a `select` that asks
 * which row's window contains the instant. Both give the same date; only one of them keeps the
 * crosses-midnight rule in the single function that owns it, and a second implementation of "which
 * trading day is this" is the drift this repository keeps paying for.
 */
async function hoursAround(sql: Sql, instant: Instant): Promise<Map<string, TradingHours>> {
  const day = toLocal(instant, ASIA_DUBAI).date
  const rows = await sql<{ trading_date: string; opens: string; closes: string }[]>`
    select to_char(trading_date, 'YYYY-MM-DD') as trading_date,
           to_char(opens_at at time zone 'Asia/Dubai', 'HH24:MI') as opens,
           to_char(closes_at at time zone 'Asia/Dubai', 'HH24:MI') as closes
      from business_day
     where trading_date between ${day}::date - 1 and ${day}::date + 1
  `
  return new Map(
    rows.map((row) => [
      row.trading_date,
      { open: localTime(row.opens), close: localTime(row.closes) },
    ]),
  )
}

/**
 * The price for one variant on one date, through the whole chain.
 *
 * The `base` layer is absent by construction: `service` carries no price and `service_variant` is the
 * only priced row (ADR 0021, duration is the only pricing axis). The promotion layer is absent because
 * no `promotion` table exists and no unit owns one (B-CAT-04's NOTE) — when one arrives, this is the
 * function that gains a fourth lookup, and `appointment.promotion_id` is already there to receive it.
 */
async function priceFor(
  sql: Sql,
  variant: VariantRow,
  on: LocalDate,
): Promise<ResolvedPrice | null> {
  const rows = await sql<
    {
      id: string
      gross_price_fils: string
      valid_from: string
      valid_to: string | null
      label: string
    }[]
  >`
    select id::text as id, gross_price_fils::text as gross_price_fils,
           to_char(valid_from, 'YYYY-MM-DD') as valid_from,
           to_char(valid_to, 'YYYY-MM-DD') as valid_to, label
      from price_list where service_variant_id = ${variant.id}
  `
  const layers: PriceListLayer[] = rows.map((row) => ({
    priceListId: row.id as PriceListId,
    grossFils: Number(row.gross_price_fils) as Fils,
    validFrom: localDate(row.valid_from),
    validTo: row.valid_to === null ? null : localDate(row.valid_to),
    label: row.label,
  }))
  try {
    return resolvePrice(
      {
        variant: {
          grossFils: Number(variant.gross_price_fils) as Fils,
          durationMinutes: Number(variant.duration_minutes),
        },
        priceList: selectEffectivePriceList(layers, on),
      },
      { on },
    )
  } catch {
    // `no_applicable_price` is the only error `resolvePrice` raises for a chain with one absolute layer,
    // and it means the variant has no price at all — a catalogue state (price on request, B-CAT-06), not
    // a number this endpoint may invent. Zero is not available as an answer (B-CAT-03).
    return null
  }
}

/**
 * One parsed delivery turned into a `BookingDeliveryInput`, or the `Response` that refuses it.
 *
 * Three lookups, each with its own refusal: the variant (which carries the duration and the catalogue
 * gross), the trading date, and the resolved price. Returning the `Response` rather than throwing keeps
 * each refusal's own status code and body beside the check that produced it.
 */
async function resolveDelivery(
  sql: Sql,
  delivery: ParsedDelivery,
): Promise<BookingDeliveryInput | Response> {
  const [variant] = await sql<VariantRow[]>`
    select id::text as id, duration_minutes, gross_price_fils::text as gross_price_fils
      from service_variant where id = ${delivery.serviceVariantId}
  `
  if (variant === undefined) {
    return json(404, {
      error: 'unknown_service_variant' satisfies BookingEndpointError,
      serviceVariantId: delivery.serviceVariantId,
    })
  }

  const hours = await hoursAround(sql, delivery.startsAt)
  const resolution = resolveTradingDate(delivery.startsAt, (date) => hours.get(date), ASIA_DUBAI)
  if (resolution.kind !== 'trading') {
    return json(409, {
      error: 'outside_trading_hours' satisfies BookingEndpointError,
      reason: resolution.reason,
      calendarDate: resolution.calendarDate,
    })
  }

  // The CALENDAR date in Asia/Dubai, deliberately not the trading date: a customer looking at the site
  // at 00:01 on the effective date sees the new menu, and pricing their booking from yesterday's trading
  // day would quote a price the site no longer shows (B-CAT-04's NOTE).
  const price = await priceFor(sql, variant, localDate(toLocal(delivery.startsAt).date))
  if (price === null) {
    return json(409, {
      error: 'no_applicable_price' satisfies BookingEndpointError,
      serviceVariantId: delivery.serviceVariantId,
    })
  }

  return {
    tradingDate: resolution.date,
    serviceVariantId: delivery.serviceVariantId,
    shape: delivery.shape,
    roomId: delivery.roomId,
    therapistIds: delivery.therapistIds,
    treatment: {
      startsAt: delivery.startsAt,
      endsAt: delivery.startsAt + Number(variant.duration_minutes) * 60_000,
    },
    price: {
      grossFils: price.gross.fils,
      netFils: price.net.fils,
      vatFils: price.vat.fils,
      vatRateBp: price.vatRateBp,
      priceListId: price.priceListId as string | null,
      promotionId: price.promotionId as PromotionId | null,
    },
  }
}

const REFUSAL_STATUS: Readonly<Record<BookingRefusal, number>> = {
  idempotency_key_required: 400,
  booking_has_no_deliveries: 400,
  therapist_count_wrong: 400,
  therapist_repeated: 400,
  price_split_disagrees: 500,
  // 422 and not 400: the request was understood and refused for a fact it did not carry, which is a
  // different message on screen — "we need to know who the treatment is for" rather than "invalid".
  requires_client_gender: 422,
  room_not_found: 400,
  not_a_trading_date: 400,
  shape_not_offered: 409,
  idempotency_key_reused: 409,
  therapist_not_eligible: 409,
  slot_taken: 409,
  delivery_incoherent: 500,
  slot_not_revalidated: 500,
}

/**
 * The refusals that have a message of their own on screen. Everything else is `conflict`.
 *
 * Two of them, and both because the remedy differs: a taken slot is answered by choosing another time,
 * and an uncollected client gender by asking one question. Collapsing either into `conflict` would leave
 * the UI with nothing to say but "that did not work".
 */
const ENDPOINT_ERROR_FOR: Partial<Record<BookingRefusal, BookingEndpointError>> = {
  slot_taken: 'slot_unavailable',
  requires_client_gender: 'requires_client_gender',
}

/** The status a legitimate no-availability answer carries, and therefore the one a block carries. */
export const NO_AVAILABILITY_STATUS = 409

/**
 * The ONE body served both for a slot that is gone and for a blocklisted contact (C-CRM-01).
 *
 * The acceptance line is that a blocklist refusal "has the same status code and body snapshot as a
 * legitimate no-availability response, so the endpoint leaks no enumeration signal", and that is only
 * achievable if the legitimate response is a CONSTANT. It did not used to be: the `slot_taken` branch
 * put `err.message` into `reason`, and a message that mentions the room, the therapist or the period
 * would differ from a blocked caller's by exactly the amount an attacker needs. So the free text is
 * gone, this object is frozen, and both paths return it byte for byte.
 *
 * `refusal: 'slot_taken'` is therefore stated for a blocked caller too, and that is deliberate rather
 * than sloppy: the field has to be there, it has to be the same value, and the alternative — a
 * `refusal: 'blocked'` nobody else sends — would be the enumeration signal written out in full. The
 * truth is recorded where it belongs, in the `audit_event` row `evaluateBlocklist` writes, which names
 * the matched key kind and the stated reason and never reaches the caller.
 *
 * Exported so a test can snapshot it, and so `apps/web/src/bookings-blocklist.itest.ts` can assert the
 * two responses are equal without restating the expected bytes in the test — a restated expectation is
 * satisfied by editing the test.
 */
export const NO_AVAILABILITY_BODY: Readonly<Record<string, string>> = Object.freeze({
  error: 'slot_unavailable' satisfies BookingEndpointError,
  refusal: 'slot_taken' satisfies BookingRefusal,
  reason:
    'that time is not available. Choose another time, or ask us to let you know when one frees up.',
})

/** The refusal a blocked contact and a taken slot both receive. One function, so they cannot diverge. */
const noAvailability = (): Response => json(NO_AVAILABILITY_STATUS, NO_AVAILABILITY_BODY)

/**
 * `decideBlocklist` and `decideCustomerLifecycle` from `@berelax/core`, as the ports `packages/db`
 * declares.
 *
 * `satisfies` and not casts: `packages/db` may not import `packages/core`, so each of these is two
 * declarations of one shape, and these two lines are what make a field added to one and not the other a
 * `pnpm typecheck` failure rather than a blocklist that evaluated nothing.
 */
export const coreBlocklistMatcher = decideBlocklist satisfies BlocklistMatcher
export const coreLifecycleDecider = decideCustomerLifecycle satisfies LifecycleDecider

export async function handleBookingRequest(
  deps: BookingEndpointDeps,
  request: Request,
): Promise<Response> {
  // First, and before the body is even read. A request that cannot be retried safely must not be
  // half-processed: the refusal has to arrive before anything is written, which is exactly here.
  const idempotencyKey = request.headers.get(IDEMPOTENCY_HEADER)?.trim() ?? ''
  if (idempotencyKey === '') {
    return json(400, {
      error: 'idempotency_key_required' satisfies BookingEndpointError,
      header: 'Idempotency-Key',
      reason:
        'a booking request carries a client-supplied idempotency key, so a retry after a timeout ' +
        'returns the original booking instead of taking a second slot',
    })
  }

  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return json(400, { error: 'invalid_request' satisfies BookingEndpointError })
  }
  const parsed = readBookingBody(raw)
  if (parsed === null) return json(400, { error: 'invalid_request' satisfies BookingEndpointError })

  const normalised = normalisePhoneResult(parsed.phone)
  if (!normalised.ok) {
    return json(422, {
      error: 'phone_not_eligible' satisfies BookingEndpointError,
      reason: normalised.reason satisfies PhoneRejection,
    })
  }

  const requestId = request.headers.get('x-request-id')
  const deliveries: BookingDeliveryInput[] = []
  for (const delivery of parsed.deliveries) {
    const resolved = await resolveDelivery(deps.sql, delivery)
    // A `Response` means the delivery could not be resolved at all, and it is returned rather than
    // collected: a booking is all-or-none, so the first unbookable delivery ends the request before any
    // transaction is opened.
    if (resolved instanceof Response) return resolved
    deliveries.push(resolved)
  }

  // The blocklist, evaluated HERE and not one line earlier (C-CRM-01).
  //
  // Every refusal a malformed request can produce — an unknown variant, a date the premises does not
  // trade, a variant with no price — has already been returned above, and that ordering is the whole
  // point. A blocklisted caller and an ordinary one must receive identical answers to every question
  // except the one a booking answers, so the check cannot run before the validation: a blocked caller
  // who posted a nonsense variant id and got `409 slot_unavailable` where everybody else gets
  // `404 unknown_service_variant` would have learned they are on the list, which is the same leak from
  // the other end.
  //
  // It runs before `ensureCustomer`, so a blocked contact creates no customer row and leaves no trace
  // but the audit row, which is the record that the check happened at all.
  const blocklist = await withUnitOfWork(
    deps.sql,
    CALLER,
    (uow) =>
      evaluateBlocklist(
        uow,
        {
          // Both keys, normalised by core. An email that does not parse is dropped rather than
          // compared raw: an unnormalisable value cannot equal a stored key, and comparing the raw
          // string is the one path on which a match could happen by accident.
          keys: [
            ...blocklistKeysFor({
              phone: normalised.e164,
              ...(parsed.email === undefined ? {} : { email: parsed.email }),
            }),
          ],
          context: 'public_booking',
        },
        { match: coreBlocklistMatcher },
      ),
    requestId === null ? {} : { requestId },
  )
  if (blocklist.blocked) return noAvailability()

  // The guest customer. `ensureCustomer` is the chokepoint (0019, ADR 0014): a guest booking has a
  // customer row with no credential and no account, and the phone is the identity.
  const customer = await withUnitOfWork(deps.sql, CALLER, (uow) =>
    ensureCustomer(uow, {
      phoneE164: normalised.e164,
      displayName: null,
      nameMatchKey: null,
      locale: 'en',
      createdVia: 'guest_booking',
    }),
  )

  // Read once and passed through, never re-decided here. Absent or unreadable is strict.
  const genderMatching = await readGenderMatching(deps.sql)

  let created: CreatedBooking
  try {
    created = await bookSlot(
      deps.sql,
      CALLER,
      {
        idempotencyKey,
        customerId: customer.customer.id,
        source: parsed.source,
        deliveries,
        genderMatching,
        ...(parsed.clientGender === undefined ? {} : { clientGender: parsed.clientGender }),
        ...(parsed.notes === undefined ? {} : { notes: parsed.notes }),
      },
      { recheck: coreSlotRecheck },
      // Spread rather than assigned: `exactOptionalPropertyTypes` makes an explicit `undefined` different
      // from an absent key, and the audit context means "unknown" by absence.
      requestId === null ? {} : { requestId },
    )
  } catch (err) {
    const refusal = bookingRefusalOf(err)
    if (refusal === null) throw err
    // The one refusal that must be a constant. See NO_AVAILABILITY_BODY: a blocked contact receives
    // exactly this, so anything varying here — a room id, a therapist count, the period — would be the
    // enumeration signal the blocklist is arranged to avoid.
    if (refusal === 'slot_taken') return noAvailability()
    return json(REFUSAL_STATUS[refusal], {
      error: ENDPOINT_ERROR_FOR[refusal] ?? ('conflict' satisfies BookingEndpointError),
      refusal,
      reason: err instanceof Error ? err.message : String(err),
    })
  }

  // The lifecycle, advanced once the booking is durable (C-CRM-01).
  //
  // A SEPARATE transaction from the booking, deliberately, and in this direction: the booking is the
  // fact the customer is waiting for and the lifecycle stamp is a segmentation, so rolling a committed
  // booking back because a segmentation column could not be updated would be the wrong way round. A
  // crash between the two leaves the record one event behind and the next booking moves it, which is
  // the failure this ordering chooses.
  //
  // Only on a FRESH booking. A replay is the same booking arriving twice and must move nothing; and the
  // reducer answers `unchanged` for an already-active client, which writes neither the column nor an
  // audit row. `lifecycle_refused` is swallowed for one pair only — a blocked record cannot take a
  // booking — and that pair cannot be reached here, because the blocklist refused above. It is caught
  // rather than propagated so a reducer widened later cannot turn a committed booking into a 500.
  if (!created.replayed) {
    try {
      await withUnitOfWork(
        deps.sql,
        CALLER,
        (uow) =>
          applyCustomerLifecycleEvent(
            uow,
            {
              customerId: customer.customer.id,
              event: 'booking_taken',
              atIso: new Date(deps.now()).toISOString(),
            },
            { decide: coreLifecycleDecider },
          ),
        requestId === null ? {} : { requestId },
      )
    } catch (err) {
      if (crmRefusalOf(err) !== 'lifecycle_refused') throw err
    }
  }

  // 200 on a replay and 201 on a fresh booking, with the same body. The status is the only thing that
  // says which happened, and the body is identical on purpose: a client that retried must be able to
  // treat both as success without branching.
  return json(created.replayed ? 200 : 201, {
    bookingId: created.bookingId,
    replayed: created.replayed,
    deliveries: created.deliveries.map((delivery) => ({
      deliveryId: delivery.deliveryId,
      roomId: delivery.roomId,
      therapistIds: delivery.therapistIds,
      appointmentIds: delivery.appointmentIds,
    })),
  })
}
