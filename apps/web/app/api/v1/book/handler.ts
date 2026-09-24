import {
  ASIA_DUBAI,
  buildAppointmentIcs,
  type Instant,
  normalisePhoneResult,
  toLocal,
} from '@berelax/core'
import {
  type Actor,
  attachBookingToSession,
  BOOKING_SESSION_TTL_MINUTES,
  type BookingSessionRow,
  consentRefusalOf,
  ensureCustomer,
  joinWaitlist,
  markPhoneVerified,
  OTP_CODE_DIGITS,
  readBookableVariants,
  readBookingForCustomer,
  readBookingSession,
  recordConsent,
  type Sql,
  startBookingSession,
  verifyBookingSession,
  verifyOtpCode,
  withUnitOfWork,
} from '@berelax/db'
import { type ConsentRecordInput, isSendGatingPurpose } from '@berelax/shared'
import {
  BOOK_SESSION_COOKIE,
  type BookAction,
  bookingIdempotencyKey,
  bookSessionCookie,
  bookSessionTokenFrom,
  isBookAction,
  stepAfterVerification,
} from '../../../../src/book/flow.ts'
import { readFlowAvailability } from '../../../../src/book/read.ts'
import {
  BOOK_FIELDS,
  BOOK_PATH,
  type BookAfter,
  type BookFlowError,
  type BookStep,
  bookHref,
  isBookAfter,
  isClientGender,
} from '../../../../src/book/state.ts'
import { readFactsForPage } from '../../../../src/facts/page-facts.ts'
import { type Locale, localisedPath } from '../../../../src/i18n/locales.ts'
import { handleBookingRequest } from '../bookings/handler.ts'
import { handleOtpRequest, type OtpEndpointDeps } from '../otp/handler.ts'

/**
 * `POST /api/v1/book` — steps 4 and 5 of the public booking flow, and the calendar file.
 *
 * ## Why steps 4 and 5 are a POST to one endpoint, and still work with JavaScript off
 *
 * B-UI-01 put every choice in the URL so steps 1–3 need no JavaScript. Steps 4 and 5 cannot be GET — they
 * send an SMS, verify a code, record a consent and take a slot — but they do not have to be JavaScript
 * either. Each is a plain `<form method="post">` whose answer is **303 See Other** carrying the URL of the
 * next state, which a browser with no JavaScript follows exactly as one with it does. The island adds only
 * what HTML cannot express.
 *
 * 303 and not 302: a 302 on a POST is re-issued as a POST by some clients, so a reader who reloaded the
 * confirmation would submit the booking again. The idempotency key makes that harmless as well, and both
 * are here because *harmless* and *does not happen* are different properties.
 *
 * ## One endpoint, five actions
 *
 * `action` is a field, not a path. One endpoint means one place the session is resolved, one place the
 * redirect is built, one place the locale is read and one place the cookie is set — five routes would be
 * five places to forget the session check, and the one that forgot it would be the one that books.
 *
 * ## Nothing here re-implements a rule that already exists
 *
 * Three handlers are CALLED rather than copied, and each of them owns properties this endpoint must not
 * restate:
 *
 *   - `handleOtpRequest` (B-LIFE-02) owns the per-number and per-IP rate limits, the supersede-on-resend
 *     rule and the enumeration-resistance property that a known and an unknown number produce identical
 *     work. A second copy of `issueOtpChallenge` plus `sendMessage` here would be a second path, and the
 *     cheapest way to make two paths indistinguishable is to have one.
 *   - `handleBookingRequest` (B-AVAIL-06) owns the price resolution, the trading-date resolution, the
 *     blocklist check with its constant refusal body, `ensureCustomer`, the idempotency claim, the room
 *     lock and the lifecycle event. Everything docs/09 §3 calls *"double submission (idempotency key)"* is
 *     already true of it; this endpoint's whole contribution is to send the SAME key twice.
 *   - `verifyOtpCode` (B-LIFE-02) owns single use, the five-minute expiry, five attempts and the
 *     fifteen-minute lock.
 *
 * The adaptation is a synthesised `Request` per call. That is a real cost — a JSON body assembled to be
 * parsed again — and it buys the one thing that matters: there is exactly one implementation of each rule,
 * and `apps/web/src/bookings-route.itest.ts` and `otp-route.itest.ts` are still testing the code this
 * flow runs.
 *
 * ## GET, and why it is on the same route
 *
 * `GET /api/v1/book?ics=<booking id>` serves the add-to-calendar file. On this route rather than its own
 * because it needs exactly what every action here needs — the session cookie, resolved and authorised the
 * same way — and a second route would be a second place that resolution could be written differently. The
 * file itself is `buildAppointmentIcs` in `@berelax/core`, which refuses to emit a file containing the
 * treatment name, the style or the therapist's label (docs/06 D2).
 */

/** The actor on a public booking-flow request. A label, never a name: this system invents none. */
const CALLER: Actor = { kind: 'customer', label: 'Public booking flow (unauthenticated)' }

export interface BookFlowDeps {
  readonly sql: Sql
  /** Injected, so the integration suite can freeze it. */
  readonly now: () => number
  /** `handleOtpRequest`'s dependencies, so the code request goes through the one handler that owns it. */
  readonly otp: OtpEndpointDeps
  /** Whether the session cookie carries `Secure`. False on the loopback origin the suite drives. */
  readonly secureCookies: boolean
}

/** The carried booking state, as the flow's forms submit it back. */
interface CarriedFields {
  readonly variant: string | null
  readonly date: string | null
  readonly therapist: string | null
  readonly gender: 'female' | 'male' | null
  readonly slot: number | null
  readonly locale: Locale
  readonly after: BookAfter | null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function field(form: FormData, name: string): string | null {
  const value = form.get(name)
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * Reads the fields that travel with every step, dropping anything unreadable.
 *
 * Dropped rather than refused, for the same reason `parseBookingParams` drops an unreadable query field: a
 * public form can be submitted from a stale page, and a 400 on a malformed `date` would be a dead end
 * where the first step belongs. What is NOT dropped is anything the booking depends on — the confirm
 * action checks the variant and the slot itself and refuses with `nothing_chosen`.
 */
function readCarried(form: FormData): CarriedFields {
  const variant = field(form, BOOK_FIELDS.variant)
  const date = field(form, BOOK_FIELDS.date)
  const therapist = field(form, BOOK_FIELDS.therapist)
  const gender = field(form, BOOK_FIELDS.gender)
  const slot = field(form, BOOK_FIELDS.slot)
  const after = field(form, BOOK_FIELDS.after)
  const locale = field(form, 'locale')
  return {
    variant: variant !== null && UUID.test(variant) ? variant : null,
    date: date !== null && ISO_DATE.test(date) ? date : null,
    therapist: therapist !== null && UUID.test(therapist) ? therapist : null,
    gender: isClientGender(gender) ? gender : null,
    slot:
      slot !== null && /^\d{1,15}$/.test(slot) && Number.isSafeInteger(Number(slot))
        ? Number(slot)
        : null,
    locale: locale === 'ar' ? 'ar' : 'en',
    after: isBookAfter(after) ? after : null,
  }
}

/** The URL of one state of `/book`, in the submitting document's own locale. */
function bookUrl(
  carried: CarriedFields,
  step: BookStep,
  extra: Readonly<Record<string, string | number | null>> = {},
): string {
  return bookHref(localisedPath(BOOK_PATH, carried.locale), {
    [BOOK_FIELDS.variant]: carried.variant,
    [BOOK_FIELDS.date]: carried.date,
    [BOOK_FIELDS.therapist]: carried.therapist,
    [BOOK_FIELDS.gender]: carried.gender,
    [BOOK_FIELDS.slot]: carried.slot,
    [BOOK_FIELDS.after]: carried.after,
    [BOOK_FIELDS.step]: step,
    ...extra,
  })
}

/**
 * The 303 every action answers with.
 *
 * `Location` is a relative URL on purpose: the origin is whatever the reader reached us on, and an
 * absolute one built from a configured host would send a reader on a preview deployment to production.
 * `cache-control: no-store` because every one of these responses is about one reader's own attempt.
 */
function seeOther(location: string, cookie?: string): Response {
  const headers = new Headers({ location, 'cache-control': 'no-store' })
  if (cookie !== undefined) headers.append('set-cookie', cookie)
  return new Response(null, { status: 303, headers })
}

/** A 303 back to a step, carrying the named refusal so the page can say what happened. */
function refuse(
  carried: CarriedFields,
  step: BookStep,
  error: BookFlowError,
  cookie?: string,
): Response {
  return seeOther(bookUrl(carried, step, { [BOOK_FIELDS.error]: error }), cookie)
}

/** The cookie header for a freshly minted session. */
function sessionCookie(deps: BookFlowDeps, token: string): string {
  return bookSessionCookie({
    token,
    maxAgeSeconds: BOOKING_SESSION_TTL_MINUTES * 60,
    secure: deps.secureCookies,
  })
}

/**
 * The live, verified session a step needs, or null.
 *
 * One function, used by every action that writes. The alternative — each action resolving the cookie for
 * itself — is four places the `verifiedAtIso !== null` half could be missing, and the one that was missing
 * it would be the one that books for a number nobody proved.
 */
async function verifiedSession(
  deps: BookFlowDeps,
  request: Request,
  nowIso: string,
): Promise<BookingSessionRow | null> {
  const token = bookSessionTokenFrom(request.headers.get('cookie'))
  if (token === null) return null
  const lookup = await readBookingSession(deps.sql, { token, nowIso })
  if (lookup.kind !== 'live') return null
  return lookup.session.verifiedAtIso === null ? null : lookup.session
}

/** Any live session, verified or not — what the code step needs before a code has been checked. */
async function liveSession(
  deps: BookFlowDeps,
  request: Request,
  nowIso: string,
): Promise<BookingSessionRow | null> {
  const token = bookSessionTokenFrom(request.headers.get('cookie'))
  if (token === null) return null
  const lookup = await readBookingSession(deps.sql, { token, nowIso })
  return lookup.kind === 'live' ? lookup.session : null
}

/**
 * Sends a code, through `handleOtpRequest`.
 *
 * The response is read for its shape rather than its prose: 202 is sent, 422 is a number that cannot
 * receive an SMS, 429 is a limit, anything else is a failure to send. Branching on the status and the
 * `error` field rather than on the message is the same discipline that endpoint applies to its own callers.
 */
async function sendCode(
  deps: BookFlowDeps,
  request: Request,
  phone: string,
  locale: Locale,
): Promise<BookFlowError | null> {
  const headers = new Headers({ 'content-type': 'application/json' })
  // Carried through so the per-IP limit and the audit trail see the real caller rather than this process.
  for (const name of ['x-forwarded-for', 'x-real-ip', 'x-request-id']) {
    const value = request.headers.get(name)
    if (value !== null) headers.set(name, value)
  }
  const response = await handleOtpRequest(
    deps.otp,
    new Request('https://internal/api/v1/otp', {
      method: 'POST',
      headers,
      body: JSON.stringify({ phone, purpose: 'booking_verify', locale }),
    }),
  )
  if (response.status === 202) return null
  if (response.status === 422) return 'phone_not_eligible'
  if (response.status === 429) return 'rate_limited'
  return 'send_failed'
}

/** Step 4a: the number. Mints a session, sends a code, and lands on the code step. */
async function actionSendCode(
  deps: BookFlowDeps,
  request: Request,
  form: FormData,
  carried: CarriedFields,
): Promise<Response> {
  const raw = field(form, 'phone')
  if (raw === null) return refuse(carried, 'details', 'invalid_request')
  const normalised = normalisePhoneResult(raw)
  // The one normaliser, from `@berelax/core`. `phone_not_eligible` covers a landline and a short code,
  // which cannot receive an SMS at all — so the code would never arrive and the reader would wait.
  if (!normalised.ok) return refuse(carried, 'details', 'phone_not_eligible')

  const nowIso = new Date(deps.now()).toISOString()
  const started = await withUnitOfWork(deps.sql, CALLER, (uow) =>
    startBookingSession(uow, { phoneE164: normalised.e164, nowIso }),
  )
  // The send happens AFTER the session row has committed, exactly as `handleOtpRequest` sends after its
  // own challenge commits: an SMS for a session that rolled back is a code nobody can use.
  const failure = await sendCode(deps, request, normalised.e164, carried.locale)
  const cookie = sessionCookie(deps, started.token)
  if (failure !== null) return refuse(carried, 'details', failure, cookie)
  return seeOther(bookUrl(carried, 'otp'), cookie)
}

/**
 * Another code for the session already in hand.
 *
 * Deliberately NOT a fresh session: the cookie stays, so the idempotency key derived from it stays, so a
 * reader who resends a code and then double-taps confirm still produces one booking. Minting a new session
 * per resend would silently make the key a per-resend value, which is the bug that looks like more care.
 */
async function actionResendCode(
  deps: BookFlowDeps,
  request: Request,
  carried: CarriedFields,
): Promise<Response> {
  const nowIso = new Date(deps.now()).toISOString()
  const session = await liveSession(deps, request, nowIso)
  if (session === null) return seeOther(bookUrl(carried, 'details'))
  const failure = await sendCode(deps, request, session.phoneE164, carried.locale)
  return failure === null ? seeOther(bookUrl(carried, 'otp')) : refuse(carried, 'otp', failure)
}

const VERIFY_ERRORS: Readonly<Record<string, BookFlowError>> = {
  wrong_code: 'wrong_code',
  expired: 'code_expired',
  no_live_challenge: 'no_live_challenge',
  locked: 'locked',
}

/**
 * Step 4b: the code.
 *
 * On success three things happen in one unit of work and they have to: the customer row is ensured, the
 * number is stamped verified, and the session is marked. Two of the three without the first is a session
 * pointing at a customer that does not exist.
 */
async function actionVerifyCode(
  deps: BookFlowDeps,
  request: Request,
  form: FormData,
  carried: CarriedFields,
): Promise<Response> {
  const code = field(form, 'code')?.replace(/\D/g, '') ?? ''
  const nowIso = new Date(deps.now()).toISOString()
  const session = await liveSession(deps, request, nowIso)
  if (session === null) return seeOther(bookUrl(carried, 'details'))
  if (code.length !== OTP_CODE_DIGITS) return refuse(carried, 'otp', 'wrong_code')

  const outcome = await withUnitOfWork(deps.sql, CALLER, (uow) =>
    verifyOtpCode(uow, {
      phoneE164: session.phoneE164,
      purpose: 'booking_verify',
      code,
      nowIso,
    }),
  )
  if (outcome.kind !== 'verified') {
    return refuse(carried, 'otp', VERIFY_ERRORS[outcome.reason] ?? 'wrong_code')
  }

  await withUnitOfWork(deps.sql, CALLER, async (uow) => {
    // `created_via: 'otp_verification'` when the row is new, which is what 0019's vocabulary is for: a
    // customer whose first contact with this business was proving a phone number did not arrive through a
    // guest booking, and the column is read by the CRM's reconstruction reporting.
    const customer = await ensureCustomer(uow, {
      phoneE164: session.phoneE164,
      displayName: null,
      nameMatchKey: null,
      locale: carried.locale,
      createdVia: 'otp_verification',
    })
    await markPhoneVerified(uow, session.phoneE164, nowIso)
    await verifyBookingSession(uow, {
      sessionId: session.id,
      customerId: customer.customer.id,
      nowIso,
    })
  })

  return seeOther(bookUrl(carried, stepAfterVerification(carried.after)))
}

/**
 * The consent rows a ticked box produces.
 *
 * One row per ticked purpose, with the wording version and its hash exactly as the form was rendered with
 * — and **nothing at all** for an unticked one. C-CRM-03: *"never asked is the absence of a row and is
 * never stored"*, so an unticked box writes no record rather than a `granted: false`. A boolean column
 * would make "asked and declined" and "never asked" the same value, which is the distinction
 * `resolveConsent` fails closed on.
 *
 * The hash comes back from the form rather than being re-read, and `recordConsent` refuses it if it does
 * not match the stored version (`consent_wording_hash_mismatch`). That is what makes the record a claim
 * about the words this reader was SHOWN rather than about whatever is current at write time — a new
 * version published between the render and the submit is a refusal, not a silent substitution.
 */
function consentRecordsFrom(
  form: FormData,
  customerId: string,
  nowIso: string,
  locale: Locale,
): readonly ConsentRecordInput[] {
  const records: ConsentRecordInput[] = []
  for (const purpose of form.getAll('consent_purpose')) {
    if (typeof purpose !== 'string') continue
    // Only a purpose this form is allowed to ask about. `consentRecordSchema` would accept any of the four
    // in the vocabulary, and two of them — `clinical_processing` and `photography` — are lawful bases for
    // holding a record rather than permission to message anybody, so this page never shows them. A
    // hand-made POST naming one would otherwise write a consent record for something the reader was never
    // shown, and a consent record is a legal artefact: it has to be a claim about what this form displayed.
    if (!isSendGatingPurpose(purpose)) continue
    if (form.get(`consent_grant_${purpose}`) !== 'on') continue
    const wordingId = field(form, `consent_wording_${purpose}`)
    const wordingHashHex = field(form, `consent_hash_${purpose}`)
    if (wordingId === null || wordingHashHex === null) continue
    records.push({
      contactCustomerId: customerId,
      channel: 'sms',
      purpose: purpose as ConsentRecordInput['purpose'],
      kind: 'granted',
      recordedAtIso: nowIso,
      wordingId,
      wordingHashHex,
      capture: {
        source: 'booking_form',
        actorKind: 'customer',
        // A label and never a name: nobody has given one, and this system invents none (brief rule 10).
        // `is_placeholder_text` (0026) refuses "TBC" here, so the label has to say something true.
        actorLabel: 'Public booking form',
        locale,
      },
    })
  }
  return records
}

/**
 * Step 5: the booking.
 *
 * The delivery tuple is re-read from the availability engine rather than taken from the form, and that is
 * the one decision in this function. A form could carry the room and the therapists it was rendered with —
 * and then a reader who left the page open for ten minutes would post a room that is now occupied, and the
 * booking transaction would refuse it with `slot_taken` even though the start is still perfectly
 * deliverable in the room next door. Re-reading means the refusal happens only when the START is gone,
 * which is the failure docs/09 §3 enumerates rather than an artefact of a stale form.
 */
async function actionConfirm(
  deps: BookFlowDeps,
  request: Request,
  form: FormData,
  carried: CarriedFields,
): Promise<Response> {
  const now = deps.now()
  const nowIso = new Date(now).toISOString()
  const session = await verifiedSession(deps, request, nowIso)
  if (session === null || session.customerId === null) return seeOther(bookUrl(carried, 'details'))
  if (carried.variant === null || carried.slot === null || carried.date === null) {
    return refuse(carried, 'choose', 'nothing_chosen')
  }

  // Already booked, and the reader submitted again. Answered from the row rather than re-posted: the
  // booking endpoint would replay the key harmlessly, but a reader who is booked should be told so
  // without a second write. docs/09 §3's "browser back after confirm".
  if (session.bookingId !== null) {
    return seeOther(
      bookUrl(carried, 'booked', {
        [BOOK_FIELDS.booking]: session.bookingId,
        [BOOK_FIELDS.error]: 'already_booked' satisfies BookFlowError,
      }),
    )
  }

  const slot = await offeredSlot(deps, carried, now)
  if (slot === null) return refuse(carried, 'confirm', 'not_available')

  const idempotencyKey = bookingIdempotencyKey({
    sessionId: session.id,
    serviceVariantId: carried.variant,
    startsAt: carried.slot,
  })
  const response = await handleBookingRequest(
    { sql: deps.sql, now: () => now as Instant },
    new Request('https://internal/api/v1/bookings', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
        ...requestIdOf(request),
      },
      body: JSON.stringify({
        phone: session.phoneE164,
        source: 'online',
        ...(carried.gender === null ? {} : { clientGender: carried.gender }),
        deliveries: [
          {
            serviceVariantId: carried.variant,
            shape: 'solo',
            roomId: slot.roomId,
            therapistIds: [...slot.therapistIds],
            startsAt: new Date(slot.startsAt).toISOString(),
          },
        ],
      }),
    }),
  )

  if (response.status !== 200 && response.status !== 201) {
    // Every refusal this endpoint can produce for a well-formed request is about the slot, and the page
    // diagnoses which of the three it is by re-reading availability — see `recheckChosen` in
    // `src/book/read.ts`. `not_available` is what puts the reader on that path.
    return refuse(carried, 'confirm', 'not_available')
  }
  const body = (await response.json()) as { bookingId?: unknown; replayed?: unknown }
  const bookingId = typeof body.bookingId === 'string' ? body.bookingId : null
  if (bookingId === null) return refuse(carried, 'confirm', 'not_available')

  const customerId = session.customerId
  await withUnitOfWork(deps.sql, CALLER, (uow) =>
    attachBookingToSession(uow, { sessionId: session.id, bookingId }),
  )

  // The consent rows in their OWN unit of work, after the booking is durable, and with a consent refusal
  // swallowed by name. The same direction `handleBookingRequest` takes with the lifecycle event, and for a
  // stronger version of the same reason: the booking is the fact the customer is waiting for and an opt-in
  // is a preference, so a consent row that cannot be written must not take the booking down with it.
  //
  // It is reachable, which is why it is handled rather than reasoned about. `recordConsent` refuses a
  // wording hash that does not match the stored version (a new version published between the render and
  // the submit) and a wording id that names no row (a hand-made POST) — and inside one transaction with
  // the attachment either of those would abort it, leave `booking_session.booking_id` null, and answer a
  // COMMITTED booking with a 500. The reader would see an error for a booking that exists.
  //
  // Swallowed for a CONSENT refusal only: anything else is rethrown, because a database that cannot write
  // a row for an unknown reason is not something this endpoint should paper over.
  const records = consentRecordsFrom(form, customerId, nowIso, carried.locale)
  if (records.length > 0) {
    try {
      await withUnitOfWork(deps.sql, CALLER, async (uow) => {
        for (const record of records) await recordConsent(uow, record)
      })
    } catch (err) {
      if (consentRefusalOf(err) === null) throw err
    }
  }

  return seeOther(
    bookUrl(carried, 'booked', {
      [BOOK_FIELDS.booking]: bookingId,
      // 200 rather than 201 means the key had already produced this booking, which is docs/09 §3's
      // "double submission". Carried in the URL so the state has an address and survives a reload —
      // a flash cookie would show it once and then leave the reader on a page that says nothing.
      ...(response.status === 200
        ? { [BOOK_FIELDS.error]: 'already_booked' satisfies BookFlowError }
        : {}),
    }),
  )
}

const requestIdOf = (request: Request): Record<string, string> => {
  const id = request.headers.get('x-request-id')
  return id === null ? {} : { 'x-request-id': id }
}

/**
 * The chosen start as the engine offers it NOW, or null.
 *
 * Narrowed to the requested therapist when there is one, because that is the request the reader made: a
 * confirm that silently widened would book somebody else's therapist under a page that named one.
 */
async function offeredSlot(
  deps: BookFlowDeps,
  carried: CarriedFields,
  now: number,
): Promise<{ roomId: string; therapistIds: readonly string[]; startsAt: number } | null> {
  if (carried.variant === null || carried.date === null || carried.slot === null) return null
  const answer = await readFlowAvailability(deps.sql, {
    tradingDate: carried.date,
    serviceVariantId: carried.variant,
    clientGender: carried.gender,
    therapistId: carried.therapist,
    now,
  })
  const slot = answer.slots.find((candidate) => candidate.startsAt === carried.slot)
  return slot === undefined
    ? null
    : { roomId: slot.roomId, therapistIds: slot.therapistIds, startsAt: slot.startsAt }
}

/**
 * The waitlist join B-UI-01 deferred here.
 *
 * *"`joinWaitlist` needs a customer id, which needs the phone/OTP step B-UI-02 owns."* This is that step's
 * other destination: the same verified session, and the window comes from the availability answer's own
 * `waitlistEligible.desiredWindow` rather than being assembled here — those four fields are exactly
 * `joinWaitlist`'s arguments, which is what that read was shaped for.
 */
async function actionJoinWaitlist(
  deps: BookFlowDeps,
  request: Request,
  carried: CarriedFields,
): Promise<Response> {
  const now = deps.now()
  const nowIso = new Date(now).toISOString()
  const session = await verifiedSession(deps, request, nowIso)
  if (session === null || session.customerId === null) return seeOther(bookUrl(carried, 'details'))
  if (carried.variant === null || carried.date === null) {
    return refuse(carried, 'choose', 'nothing_chosen')
  }
  const eligibility = await readFlowAvailability(deps.sql, {
    tradingDate: carried.date,
    serviceVariantId: carried.variant,
    clientGender: carried.gender,
    therapistId: carried.therapist,
    now,
    customerId: session.customerId,
  })
  const waitlist = eligibility.waitlist
  if (waitlist === null || !waitlist.eligible || waitlist.desiredWindow === null) {
    return refuse(carried, 'waitlist', 'waitlist_unavailable')
  }
  await joinWaitlist(deps.sql, {
    customerId: session.customerId,
    serviceVariantId: waitlist.serviceVariantId,
    tradingDate: waitlist.tradingDate,
    window: waitlist.desiredWindow,
    shape: waitlist.shape,
    therapistId: waitlist.therapistId,
  })
  return seeOther(bookUrl(carried, 'waitlisted'))
}

export async function handleBookFlowRequest(
  deps: BookFlowDeps,
  request: Request,
): Promise<Response> {
  let form: FormData
  try {
    form = await request.formData()
  } catch {
    // A body this endpoint cannot read at all has no carried state either, so there is nowhere to send the
    // reader back to but the first step.
    return seeOther(localisedPath(BOOK_PATH, 'en'))
  }
  const carried = readCarried(form)
  const action = field(form, 'action')
  if (!isBookAction(action)) return refuse(carried, 'choose', 'invalid_request')
  return await dispatch(deps, request, form, carried, action)
}

function dispatch(
  deps: BookFlowDeps,
  request: Request,
  form: FormData,
  carried: CarriedFields,
  action: BookAction,
): Promise<Response> {
  switch (action) {
    case 'send_code':
      return actionSendCode(deps, request, form, carried)
    case 'resend_code':
      return actionResendCode(deps, request, carried)
    case 'verify_code':
      return actionVerifyCode(deps, request, form, carried)
    case 'confirm':
      return actionConfirm(deps, request, form, carried)
    case 'join_waitlist':
      return actionJoinWaitlist(deps, request, carried)
  }
}

/**
 * `GET /api/v1/book?ics=<booking id>` — the add-to-calendar file.
 *
 * Authorised exactly as the confirmation page is: the session's own customer id is a predicate in the SQL
 * (`readBookingForCustomer`), so a booking id in a query string is not permission to download somebody's
 * appointment. A booking that is not this session's produces the same 404 as one that does not exist.
 *
 * The discretion rule is enforced by `buildAppointmentIcs`, which is given the treatment's public name,
 * its style and the therapist's label as values it must not emit and refuses the file if any of them
 * appears (docs/06 D2). A refusal here is a 409 rather than a redacted file: the page renders a named
 * state saying the file is unavailable, which is visible and fixable, where a quietly redacted file would
 * hide a defect in the copy.
 */
export async function handleBookIcsRequest(
  deps: BookFlowDeps,
  request: Request,
): Promise<Response> {
  const bookingId = new URL(request.url).searchParams.get('ics')
  const nowIso = new Date(deps.now()).toISOString()
  const session = await verifiedSession(deps, request, nowIso)
  if (
    bookingId === null ||
    !UUID.test(bookingId) ||
    session === null ||
    session.customerId === null
  ) {
    return new Response('not found', { status: 404, headers: { 'cache-control': 'no-store' } })
  }
  const rows = await readBookingForCustomer(deps.sql, {
    bookingId,
    customerId: session.customerId,
  })
  const first = rows[0]
  if (first === undefined) {
    return new Response('not found', { status: 404, headers: { 'cache-control': 'no-store' } })
  }

  const [facts, variants] = await Promise.all([readFactsForPage(), readBookableVariants(deps.sql)])
  const variant = variants.find((row) => row.serviceVariantId === first.serviceVariantId) ?? null
  const place = facts?.address.oneLine ?? facts?.names.display ?? 'BE RELAX'
  const built = buildAppointmentIcs({
    // The BOOKING id, not the appointment id: a couples booking is one entry in a reader's diary, and a
    // second UID for the same evening is a second reminder.
    uid: `${first.bookingId}@berelax`,
    dtstampAt: deps.now(),
    startsAt: first.startsAt,
    endsAt: rows.reduce((latest, row) => Math.max(latest, row.endsAt), first.endsAt),
    // The discreet line. It names the business and the fact that there is an appointment, which is what
    // docs/06 D2 leaves visible; everything else is behind the booking reference.
    summary: facts?.names.display ?? 'BE RELAX appointment',
    description: `Reference ${first.bookingId}. ${toLocal(first.startsAt as Instant, ASIA_DUBAI).time}.`,
    location: place,
    // Null until B-UI-05's manage-booking page exists. `URL:` with nothing after it is a property some
    // clients render as a broken link, and a link to a 404 is worse than no link (B-MSG-03's NOTE).
    url: null,
    withhold: [
      ...(variant === null ? [] : [variant.publicDisplayName, variant.style, variant.treatmentKey]),
      // The therapist's internal handle is not published as a name anywhere (ADR 0020), and it must not
      // become one here. Withheld by id as well, because an id in a calendar entry is still a join key.
      ...rows.map((row) => row.therapistId),
    ],
  })
  if (!built.ok) {
    // A DEFECT rather than a customer situation, and answered as one. The only way to reach it is a copy
    // string that names the treatment, the style or a therapist — which `packages/core/src/calendar/
    // ics.test.ts` and gate 80r both refuse, and which `book-flow.itest.ts` asserts against the real
    // catalogue values. So there is no designed state and no locale for it: the body names the value that
    // leaked, for whoever is reading the logs. A redacted file served quietly would hide the defect behind
    // something that looked fine, which is the outcome docs/06 D2 is written to prevent.
    return new Response(`discretion: ${built.leaked.join(', ')}`, {
      status: 409,
      headers: { 'cache-control': 'no-store' },
    })
  }
  return new Response(built.ics, {
    status: 200,
    headers: {
      'content-type': 'text/calendar; charset=utf-8',
      'content-disposition': `attachment; filename="berelax-${first.bookingId}.ics"`,
      'cache-control': 'no-store',
    },
  })
}

/** Re-exported so `route.ts` and the suite name one constant rather than two spellings of it. */
export { BOOK_SESSION_COOKIE }
