/**
 * What `/book` reads, and the one rule it injects.
 *
 * `packages/db` may never import `packages/core`, so `queryAvailability` takes the rule that turns rows into
 * offerable starts as an argument — `solveAvailabilityQuery`, from `@berelax/core`. This module is the one
 * place in the application that supplies it, with `satisfies` rather than a cast, exactly as
 * `packages/fixtures/src/availability-query.itest.ts` does: `AvailabilitySolve` (db) and
 * `AvailabilityQueryFacts` (core) are two declarations of one shape, and that one line is what makes a field
 * added to one and not the other a `pnpm typecheck` failure rather than a slot list nobody computed.
 *
 * ## The memo
 *
 * One `AvailabilityCache` per process, at module scope. That is B-AVAIL-07's design rather than a shortcut:
 * the memo is validated against `availability_epoch`, which the database advances on every write that can
 * change an answer, so a stale entry is dropped on the primary-key lookup rather than served. The cache is
 * an optimisation; the database is the authority, and `bookSlot` re-reads the committed rows under the room
 * lock before it writes — which is why a page holding a list that has gone stale receives a named
 * `slot_taken` refusal instead of double-booking a room.
 *
 * ## Why every failure is a state and not a throw
 *
 * This is a public URL anything may link to, including a crawler following a mangled query string. The
 * structural refusals (`not_a_trading_date`, `variant_not_found`, `shape_not_offered`,
 * `no_compatible_room_type`, `requires_client_gender`) already arrive as an *answer* with zero slots and a
 * named reason, because "no availability" is what a booking page renders and a thrown error there is a 500
 * where a sentence belongs. This module keeps that property for the reads around them: an unreachable
 * database renders a named state and a telephone number, not a stack trace.
 */

import {
  type BookingEdgeState,
  decideBookingEdgeState,
  noBookingEdgeFacts,
  solveAvailabilityQuery,
} from '@berelax/core'
import {
  type AlternativeTherapist,
  type AvailabilityAnswer,
  type AvailabilityDeps,
  type AvailabilityRequest,
  type AvailabilitySlot,
  type AvailabilitySolve,
  type BookableVariantRow,
  type BookedAppointmentRow,
  type BookingSessionLookup,
  type ConsentWordingRecord,
  createAvailabilityCache,
  type NearestDay,
  noAvailabilityAlternatives,
  type OtpResendWindow,
  queryAvailability,
  readAvailabilityLimits,
  readBookableVariants,
  readBookingForCustomer,
  readBookingSession,
  readConsentPurposes,
  readCurrentConsentWording,
  readGenderMatching,
  readOpenTradingDays,
  readOtpResendWindow,
  readPublishableTherapists,
  readTherapistLabels,
  type Sql,
  type TherapistLabelRow,
  type TradingDayRow,
  type WaitlistEligibility,
} from '@berelax/db'
import { type Facts, isSendGatingPurpose } from '@berelax/shared'
import { readFactsForPage } from '../facts/page-facts.ts'
import { factsRuntime } from '../facts/runtime.ts'
import { resendCooldownSeconds } from './flow.ts'
import { type BookingParams, DAY_STRIP_DAYS, dayStrip, VERIFIED_STEPS } from './state.ts'

/**
 * Core's rule, as the query's injected solver.
 *
 * `satisfies` and not a cast. See the module header: this is the assignability check that keeps the two
 * sides of the `core`/`db` boundary describing one shape.
 */
const solve = solveAvailabilityQuery satisfies AvailabilitySolve

/**
 * The in-process memo, shared by every request this process serves.
 *
 * Module scope rather than per-request, which is the whole point of it: a day strip is seven days and a
 * reader moving along it asks the same question about the same date twice within seconds. The default TTL
 * is the shorter end of B-AVAIL-07's 30–60 s band, and `createAvailabilityCache` refuses a longer one by
 * name.
 */
const cache = createAvailabilityCache()

/**
 * The strip is read **anchored at the day asked about**, not at the first open day.
 *
 * `readOpenTradingDays` takes the requested date as its `from`, so the strip's first day is the day the
 * URL names and the next six are the ones after it. A window that always started at today would put any
 * date further out than seven trading days outside the strip — and `dayStrip` would then silently fall
 * back to the first day, so a reader following *"Thursday has six times free"* out of the no-availability
 * state would arrive on a different day's list. That defect reads like a caching bug and is an
 * off-by-window, which is why the anchor is the request rather than the clock.
 *
 * `closes_at > now` still applies, so a bookmark from last week anchors nothing: the read answers with the
 * days it can offer now, which is what a reader arriving on a stale URL should see.
 */
const TRADING_DAYS_READ = DAY_STRIP_DAYS

/** One priced duration, as the page offers it. */
export type BookableVariant = BookableVariantRow

/** A therapist, labelled the only way ADR 0020 allows: a name when one is published, or neither. */
export interface TherapistLabel {
  readonly therapistId: string
  /** `Therapist 07`. An internal handle — never rendered as a display name; see `TherapistCard`. */
  readonly reference: string
  readonly displayName: string | null
}

/** A nearer day with space, plus the therapist labels its own answer needed. */
export interface NoAvailability {
  readonly nearestDays: readonly NearestDay[]
  readonly alternativeTherapists: readonly (AlternativeTherapist & {
    readonly label: TherapistLabel | null
  })[]
  readonly waitlist: WaitlistEligibility
}

/** Everything the page renders from, already read and already solved. */
export interface BookingPageData {
  /** Null when the database could not be read at all. The page then renders a named state. */
  readonly reachable: boolean
  readonly facts: Facts | null
  readonly variants: readonly BookableVariant[]
  /** The open trading dates the strip is cut from, earliest first. */
  readonly tradingDays: readonly TradingDayRow[]
  /** The day strip, and the date it resolved to. */
  readonly days: readonly { readonly tradingDate: string; readonly selected: boolean }[]
  readonly selectedDate: string | null
  readonly variant: BookableVariant | null
  /** The therapist the URL named, labelled. Null when none was named or the id names nobody. */
  readonly therapist: TherapistLabel | null
  /** The therapists a public page may offer by name. Empty until an admin publishes one (ADR 0020). */
  readonly publishable: readonly TherapistLabel[]
  /** Null until a treatment and a client gender have both been stated. */
  readonly answer: AvailabilityAnswer | null
  /** Present exactly when the answer offered nothing. Never a bare empty list. */
  readonly none: NoAvailability | null
  /** `booking.same_gender_matching`, so the page can say why it is asking. */
  readonly strictGenderMatching: boolean

  // ── Steps 4 and 5 (B-UI-02) ───────────────────────────────────────────────────────────────────

  /** The flow session the cookie names. `unknown` when there is no cookie or it names nothing. */
  readonly session: BookingSessionLookup
  /**
   * The chosen start, as the engine currently offers it. Null when nothing is chosen or it is gone.
   *
   * The whole slot and not just the instant: the confirm step needs the room and the therapists the
   * assignment chose, because the booking endpoint takes the tuple the reader was shown and re-validates
   * it inside the transaction rather than re-assigning silently underneath a confirmation.
   */
  readonly chosen: AvailabilitySlot | null
  /**
   * Whether the chosen start is still deliverable, and if not, which of the three reasons it is.
   *
   * Three-valued on purpose. `null` means *not evaluated* — no start chosen, or no named therapist to ask
   * about — and `false` means *checked, and no*. `decideBookingEdgeState` in `@berelax/core` depends on
   * that distinction: a boolean would report `therapist_became_unavailable` on every booking taken with
   * "any available therapist", which is every booking this business currently offers.
   */
  readonly recheck: {
    readonly startStillOffered: boolean | null
    readonly requestedTherapistStillFree: boolean | null
    readonly compatibleRoomStillFree: boolean | null
    /** The selected trading day's close, which is what a duration is measured against. */
    readonly closesAt: number | null
  }
  /** The resend window for the session's number, or null when there is no session. */
  readonly resend: OtpResendWindow | null
  /** The resend cooldown in whole seconds at `now`. Zero when a resend is available. */
  readonly resendInSeconds: number
  /**
   * The consent questions the confirm step asks, one per send-gating purpose with a published wording.
   *
   * Driven by `consent_purpose.is_send_gating` (C-CRM-03) rather than by a list here, which is what that
   * unit's NOTE asked for: `clinical_processing` and `photography` are lawful bases for holding a record
   * and not permission to message anybody, so a booking form that offered them would be collecting a
   * grant nobody could act on. A purpose with no published wording is absent, because
   * `consentRecordSchema` refuses a grant with no wording version and a box that cannot be recorded is a
   * box that lies.
   */
  readonly consentOffers: readonly ConsentOffer[]
  /** The booking this session produced, authorised by customer id in SQL. Empty when there is none. */
  readonly booking: readonly BookedAppointmentRow[]
  /** The variant the booked appointment is for, so the confirmation can price and name it. */
  readonly bookedVariant: BookableVariant | null
  /** Which of docs/09 §3's nine edge states the reader is in, or null. Decided in `@berelax/core`. */
  readonly edge: BookingEdgeState | null
}

/** One consent question, with the exact wording version a grant would be recorded under. */
export interface ConsentOffer {
  readonly purpose: string
  readonly wordingId: string
  /** Lower-case hex of the wording's SHA-256. Handed back to `recordConsent` unchanged. */
  readonly wordingHashHex: string
  readonly version: number
  /** The text in the reader's own language. Both columns are read; the page picks one. */
  readonly textEn: string
  readonly textAr: string
  /** True while the wording is this build's draft (`Y9-consent-wording`), so the page can say so. */
  readonly isProvisional: boolean
}

const labelOf = (row: TherapistLabelRow): TherapistLabel => ({
  therapistId: row.therapistId,
  reference: row.staffReference,
  // `is_publishable` is GENERATED from `display_name is not null and photo_consent`, so a name set
  // without a recorded consent is deliberately not published here — ADR 0020 requires both.
  displayName: row.isPublishable ? row.displayName : null,
})

/**
 * The page's data, for one URL, at one instant.
 *
 * `now` is an argument rather than a call to the clock, which is what makes the whole render reproducible:
 * the screenshot matrix pins a trading date and the only other thing the page reads the clock for is where
 * the day strip starts. `apps/web/src/book.itest.ts` drives this function directly with a frozen instant as
 * well as through a real server.
 */
export async function bookingPageData(
  params: BookingParams,
  options: {
    readonly now: number
    /**
     * The flow session cookie's value, or null.
     *
     * An argument rather than a `cookies()` call here, for the reason `now` is one: this function is
     * driven directly by `apps/web/src/book-flow.itest.ts` with a token it minted itself, and a module
     * that read the request context could only be exercised through a browser.
     */
    readonly sessionToken?: string | null
  },
): Promise<BookingPageData> {
  const facts = await readFactsForPage()
  const empty: BookingPageData = {
    reachable: false,
    facts,
    variants: [],
    tradingDays: [],
    days: [],
    selectedDate: null,
    variant: null,
    therapist: null,
    publishable: [],
    answer: null,
    none: null,
    strictGenderMatching: true,
    session: { kind: 'unknown' },
    chosen: null,
    recheck: {
      startStillOffered: null,
      requestedTherapistStillFree: null,
      compatibleRoomStillFree: null,
      closesAt: null,
    },
    resend: null,
    resendInSeconds: 0,
    consentOffers: [],
    booking: [],
    bookedVariant: null,
    edge: null,
  }
  try {
    const sql = factsRuntime().sql
    const nowIso = new Date(options.now).toISOString()
    const token = options.sessionToken ?? null
    const session: BookingSessionLookup =
      token === null ? { kind: 'unknown' } : await readBookingSession(sql, { token, nowIso })
    const [variants, tradingDays, limits, genderMatching] = await Promise.all([
      readBookableVariants(sql),
      readOpenTradingDays(sql, {
        now: options.now,
        from: params.date,
        limit: TRADING_DAYS_READ,
      }),
      readAvailabilityLimits(sql),
      readGenderMatching(sql),
    ])

    // The strip starts at the day asked for when that day is open, and at the first open day otherwise —
    // and it is cut from the read rather than generated, so a closed date is skipped by the database.
    const strip = dayStrip(
      tradingDays.map((day) => day.tradingDate),
      params.date,
    )

    const variant = variants.find((row) => row.serviceVariantId === params.variant) ?? null
    const [therapistRows, publishableRows] = await Promise.all([
      params.therapist === null
        ? Promise.resolve([])
        : readTherapistLabels(sql, [params.therapist]),
      // Scoped to the selected day so a therapist who leaves stops being offered, and to *today* when no
      // day is selected — the same employment predicate either way.
      readPublishableTherapists(sql, {
        onDate: strip.selected ?? new Date(options.now).toISOString().slice(0, 10),
      }),
    ])

    const context = await readSessionContext(sql, session, nowIso, variants)

    const base: BookingPageData = {
      ...empty,
      reachable: true,
      variants,
      tradingDays,
      days: strip.days,
      selectedDate: strip.selected,
      variant,
      therapist: therapistRows[0] === undefined ? null : labelOf(therapistRows[0]),
      publishable: publishableRows.map(labelOf),
      strictGenderMatching: genderMatching === 'strict',
      session,
      resend: context.resend,
      resendInSeconds: resendCooldownSeconds({
        resendAvailableAtIso: context.resend?.resendAvailableAtIso ?? null,
        now: options.now,
      }),
      consentOffers: context.consentOffers,
      booking: context.booking,
      bookedVariant: context.bookedVariant,
      recheck: {
        startStillOffered: null,
        requestedTherapistStillFree: null,
        compatibleRoomStillFree: null,
        closesAt: tradingDays.find((day) => day.tradingDate === strip.selected)?.closesAt ?? null,
      },
    }

    // Nothing is asked of the availability engine until the request can be formed. A query with no
    // variant has nothing to be about, and one with no client gender is answered with
    // `requires_client_gender` under the strict default — the page says what it needs instead.
    if (variant === null || strip.selected === null) return withEdge(base, params, options.now)
    if (params.gender === null && base.strictGenderMatching)
      return withEdge(base, params, options.now)

    const request: AvailabilityRequest = {
      tradingDate: strip.selected,
      serviceVariantId: variant.serviceVariantId,
      minLeadMinutes: limits.minLeadMinutes,
      maxAdvanceDays: limits.maxAdvanceDays,
      ...(params.gender === null ? {} : { clientGender: params.gender }),
      ...(params.therapist === null ? {} : { therapistIds: [params.therapist] }),
      genderMatching,
    }
    const deps: AvailabilityDeps = { solve, cache, now: options.now }
    const answer = await queryAvailability(sql, request, deps)
    if (answer.slots.length > 0) {
      return withEdge(
        { ...base, answer, ...(await recheckChosen(sql, request, deps, answer, params, base)) },
        params,
        options.now,
      )
    }

    // The cold path, and deliberately more round trips than the warm one: it runs only when a day came
    // back empty. Each nearby date is its own request under its own cache tag.
    const alternatives = await noAvailabilityAlternatives(sql, request, deps)
    const labels = await readTherapistLabels(
      sql,
      alternatives.alternativeTherapists.map((row) => row.therapistId),
    )
    const byId = new Map(labels.map((row) => [row.therapistId, labelOf(row)]))
    return withEdge(
      {
        ...base,
        answer,
        ...(await recheckChosen(sql, request, deps, answer, params, base)),
        none: {
          nearestDays: alternatives.nearestDays,
          alternativeTherapists: alternatives.alternativeTherapists.map((row) => ({
            ...row,
            label: byId.get(row.therapistId) ?? null,
          })),
          waitlist: alternatives.waitlistEligible,
        },
      },
      params,
      options.now,
    )
  } catch {
    // Fail-soft, for the reason `readPageFacts` gives: a page has other content, and a 500 on the one
    // route that takes a booking is worse than a page that says to call the desk. The error is not logged
    // here — the connection layer already does, and a rendered page is not the place to decide.
    return empty
  }
}

/**
 * The consent questions the confirm step may ask.
 *
 * Driven by `consent_purpose.is_send_gating`, which C-CRM-03's NOTE names as *"already decides which
 * purposes gate a send"*, and narrowed again by `isSendGatingPurpose` in `@berelax/shared` — two readings
 * of one rule, on purpose: the table is the authority and the constant is what the type system knows, and
 * `packages/fixtures/src/consent.itest.ts` already asserts they agree. Asking for a purpose that does not
 * gate a send would collect a grant no send path reads.
 *
 * A purpose whose wording has never been published is **absent** rather than shown with no words.
 * `consentRecordSchema` refuses a grant with no wording version (*"consent with no record of the words
 * shown is not an opt-in proof"*), so a box for such a purpose is a box whose tick cannot be recorded.
 */
async function readConsentOffers(sql: Sql): Promise<readonly ConsentOffer[]> {
  const purposes = await readConsentPurposes(sql)
  const gating = purposes.filter(
    (purpose) => purpose.isSendGating && isSendGatingPurpose(purpose.purpose),
  )
  const wordings = await Promise.all(
    gating.map(async (purpose) => ({
      purpose: purpose.purpose,
      wording: await readCurrentConsentWording(sql, purpose.purpose),
    })),
  )
  const offers: ConsentOffer[] = []
  for (const entry of wordings) {
    const wording: ConsentWordingRecord | null = entry.wording
    if (wording === null) continue
    offers.push({
      purpose: entry.purpose,
      wordingId: wording.id,
      wordingHashHex: wording.contentHashHex,
      version: wording.version,
      textEn: wording.textEn,
      textAr: wording.textAr,
      isProvisional: wording.isProvisional,
    })
  }
  return offers
}

/**
 * Whether the chosen start is still deliverable, and which of the three reasons it is not.
 *
 * The expensive half runs only when the chosen start has **gone**, which is the same shape as
 * `noAvailabilityAlternatives`: a reader whose time is still there pays for nothing.
 *
 * The widening is the part worth reading twice. When a reader arrived with `?therapist=<id>`, the answer
 * they were shown is narrowed to that therapist — so a therapist whose shift changed makes the start
 * disappear, and so does a room being taken, and so does the close moving. Narrowed, all three look
 * identical. Widening the *same* request with the therapist filter removed separates them:
 *
 *   - the start comes back and the therapist is absent from its `availableTherapistIds` → it is the
 *     therapist, and widening to any therapist is the remedy the page can offer;
 *   - the start does not come back and the day's `rejected` list names `no_room_available` for it → it is
 *     the room, and another therapist would not help;
 *   - neither → `slot_taken`, the general case, which is deliberately the LAST thing this reports.
 *
 * `requestedTherapistStillFree` stays `null` when the start is gone for everybody, because the therapist
 * is then not the reason and blaming them would send the reader to a control that changes nothing.
 */
async function recheckChosen(
  sql: Sql,
  request: AvailabilityRequest,
  deps: AvailabilityDeps,
  answer: AvailabilityAnswer,
  params: BookingParams,
  base: BookingPageData,
): Promise<Pick<BookingPageData, 'chosen' | 'recheck'>> {
  if (params.slot === null) return { chosen: null, recheck: base.recheck }
  const chosen = answer.slots.find((slot) => slot.startsAt === params.slot) ?? null
  if (chosen !== null) {
    return {
      chosen,
      recheck: {
        ...base.recheck,
        startStillOffered: true,
        requestedTherapistStillFree:
          params.therapist === null
            ? null
            : chosen.availableTherapistIds.includes(params.therapist),
        compatibleRoomStillFree: chosen.availableRoomIds.length > 0,
      },
    }
  }

  // The cold path. One extra query, and only when a chosen start has gone.
  const widened =
    params.therapist === null ? answer : await queryAvailability(sql, widenedRequest(request), deps)
  const wideSlot = widened.slots.find((slot) => slot.startsAt === params.slot) ?? null
  const rejection = widened.rejected.find((entry) => entry.startsAt === params.slot)?.reason ?? null
  return {
    chosen: null,
    recheck: {
      ...base.recheck,
      startStillOffered: false,
      requestedTherapistStillFree:
        params.therapist === null || wideSlot === null
          ? null
          : wideSlot.availableTherapistIds.includes(params.therapist),
      compatibleRoomStillFree:
        wideSlot !== null
          ? wideSlot.availableRoomIds.length > 0
          : rejection === 'no_room_available'
            ? false
            : null,
    },
  }
}

/**
 * The same request with the therapist narrowing removed.
 *
 * A function rather than a destructuring at the call site, because `exactOptionalPropertyTypes` makes
 * `{ ...request, therapistIds: undefined }` a different type from a request with no such key — and the
 * query would then be narrowed to `undefined` rather than widened.
 */
function widenedRequest(request: AvailabilityRequest): AvailabilityRequest {
  const copy: Record<string, unknown> = { ...request }
  delete copy['therapistIds']
  return copy as unknown as AvailabilityRequest
}

/**
 * The reader's edge state, decided by `@berelax/core` from facts this module has already read.
 *
 * Applied in one place rather than at each return, so a branch added to `bookingPageData` cannot forget
 * it — and the decision itself is a pure function with its own test, which is the half that is wrong in
 * ways a rendered page does not show (`packages/core/src/booking/edge-state.test.ts` proves the
 * precedence against three deciders that get it wrong).
 *
 * `revisitingEarlierStep` is the one fact that is about the URL rather than about the world: a booking
 * exists and the reader is looking at a step before its confirmation. The `booked` and `waitlisted` steps
 * are excluded because they ARE the confirmations — reporting `back_after_confirm` there would put a
 * "this is already made" panel on the page whose whole subject is the booking that was just made.
 */
function withEdge(data: BookingPageData, params: BookingParams, now: number): BookingPageData {
  const session = data.session
  const row = session.kind === 'unknown' ? null : session.session
  const bookingId = row?.bookingId ?? null
  const edge = decideBookingEdgeState({
    ...noBookingEdgeFacts(now),
    sessionExpiresAt: row === null ? null : Date.parse(row.expiresAtIso),
    existingBookingId: bookingId,
    revisitingEarlierStep:
      bookingId !== null && params.step !== 'booked' && params.step !== 'waitlisted',
    // Reported by the endpoint through the URL, and **guarded by a booking this session really holds**.
    // Without that guard `?error=already_booked` would render "you are already booked" to a reader who is
    // not, which is the one panel on this page that must never be wrong in that direction.
    replayed: params.error === 'already_booked' && bookingId !== null,
    // Reported through the URL, because both are facts about something that happened outside this
    // process: a browser that could not finish a submission, and a reader who says no SMS arrived.
    submissionInterrupted: params.issue === 'interrupted',
    codeNotReceived: params.issue === 'code_not_received',
    chosenStart: params.slot,
    treatmentEndsAt:
      params.slot === null || data.variant === null
        ? null
        : params.slot + data.variant.durationMinutes * 60_000,
    closesAt: data.recheck.closesAt,
    startStillOffered: data.recheck.startStillOffered,
    requestedTherapistStillFree: data.recheck.requestedTherapistStillFree,
    compatibleRoomStillFree: data.recheck.compatibleRoomStillFree,
    refusal: params.error === 'not_available' ? 'slot_taken' : null,
  })
  return { ...data, edge }
}

/**
 * Whether this step may be rendered with the session the reader has.
 *
 * Read off `VERIFIED_STEPS` rather than asked per step, for the reason that list states: a confirm step
 * that rendered without checking would take a booking for a number nobody proved, and it would look
 * exactly like a working page.
 */
export function stepIsPermitted(data: BookingPageData, step: BookingParams['step']): boolean {
  if (!VERIFIED_STEPS.includes(step)) return true
  return data.session.kind === 'live' && data.session.session.verifiedAtIso !== null
}

/**
 * The three reads that are about the reader's own session rather than about availability.
 *
 * Extracted from `bookingPageData` rather than inlined, and not only for its complexity score: every one
 * of the three is SKIPPED when there is no session, and that arrangement is easy to lose in a longer
 * function. An anonymous first arrival at /book must not pay for a consent-wording read it has nothing to
 * show, nor for a resend window about a number nobody has given.
 */
async function readSessionContext(
  sql: Sql,
  session: BookingSessionLookup,
  nowIso: string,
  variants: readonly BookableVariant[],
): Promise<{
  readonly resend: OtpResendWindow | null
  readonly consentOffers: readonly ConsentOffer[]
  readonly booking: readonly BookedAppointmentRow[]
  readonly bookedVariant: BookableVariant | null
}> {
  const row = session.kind === 'unknown' ? null : session.session
  if (row === null) {
    return { resend: null, consentOffers: [], booking: [], bookedVariant: null }
  }
  const [resend, consentOffers, booking] = await Promise.all([
    readOtpResendWindow(sql, { phoneE164: row.phoneE164, purpose: 'booking_verify', nowIso }),
    // Only once verification is done. Before that there is no confirm step to put the boxes on, and the
    // wording read would be two queries per render of the phone form.
    row.verifiedAtIso === null
      ? Promise.resolve([] as readonly ConsentOffer[])
      : readConsentOffers(sql),
    // Authorised in SQL by this session's own customer id — see `readBookingForCustomer`. A booking id in
    // a query string is not permission to read a booking, and this is the one place that is decided.
    row.bookingId === null || row.customerId === null
      ? Promise.resolve([] as readonly BookedAppointmentRow[])
      : readBookingForCustomer(sql, { bookingId: row.bookingId, customerId: row.customerId }),
  ])
  const first = booking[0]
  return {
    resend,
    consentOffers,
    booking,
    bookedVariant:
      first === undefined
        ? null
        : (variants.find((variant) => variant.serviceVariantId === first.serviceVariantId) ?? null),
  }
}

/**
 * What steps 4–5 ask the availability engine, built from the carried fields.
 *
 * Exported so the POST endpoint can ask the SAME question the page answered, through the SAME injected
 * solver and the SAME process-wide memo. The alternative — a second `solveAvailabilityQuery satisfies
 * AvailabilitySolve` line beside the endpoint — would be a second place the `core`/`db` seam is spelled,
 * and this module's header is explicit that there is one.
 *
 * It is a read rather than a claim: the confirm step re-reads availability at the moment of submission,
 * because the tuple a form was rendered with is a tuple from however long ago the reader left the page
 * open. See `actionConfirm` in `app/api/v1/book/handler.ts` for why the tuple is not taken from the form.
 */
export interface FlowAvailabilityQuery {
  readonly tradingDate: string
  readonly serviceVariantId: string
  readonly clientGender: 'female' | 'male' | null
  readonly therapistId: string | null
  readonly now: number
  /** The customer asking, so the waitlist half can answer `alreadyWaiting`. Absent leaves it false. */
  readonly customerId?: string
}

export interface FlowAvailability {
  readonly slots: readonly AvailabilitySlot[]
  /** Present only when the day came back empty, which is the only time a join is on offer. */
  readonly waitlist: WaitlistEligibility | null
}

export async function readFlowAvailability(
  sql: Sql,
  query: FlowAvailabilityQuery,
): Promise<FlowAvailability> {
  const [limits, genderMatching] = await Promise.all([
    readAvailabilityLimits(sql),
    readGenderMatching(sql),
  ])
  const request: AvailabilityRequest = {
    tradingDate: query.tradingDate,
    serviceVariantId: query.serviceVariantId,
    minLeadMinutes: limits.minLeadMinutes,
    maxAdvanceDays: limits.maxAdvanceDays,
    ...(query.clientGender === null ? {} : { clientGender: query.clientGender }),
    ...(query.therapistId === null ? {} : { therapistIds: [query.therapistId] }),
    genderMatching,
  }
  const deps: AvailabilityDeps = { solve, cache, now: query.now }
  const answer = await queryAvailability(sql, request, deps)
  if (answer.slots.length > 0) return { slots: answer.slots, waitlist: null }
  // The cold path, and only for the caller that needs it: `noAvailabilityAlternatives` searches a week
  // either side, which is `searchDays` round trips. A confirm that came back empty does not need them,
  // and asks with no customer id so it never reaches here.
  if (query.customerId === undefined) return { slots: [], waitlist: null }
  const alternatives = await noAvailabilityAlternatives(sql, request, deps, {
    customerId: query.customerId,
  })
  return { slots: [], waitlist: alternatives.waitlistEligible }
}
