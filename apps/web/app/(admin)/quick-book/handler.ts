import { createHash } from 'node:crypto'
import {
  ASIA_DUBAI,
  decideRefCapture,
  formatMoney,
  grossMoneyFromFils,
  type Instant,
  localTime,
  normalisePhoneResult,
  type RefCaptureClaim,
  type RefCaptureOutcome,
  refCaptureRate,
  resolveTradingDate,
  solveAvailabilityQuery,
  type TradingHours,
  toLocal,
} from '@berelax/core'
import {
  type Actor,
  type AvailabilitySlot,
  type AvailabilitySolve,
  type BookableVariantRow,
  type ExclusionReason,
  MIN_LEAD_SETTING_KEY,
  matchWhatsappRef,
  queryAvailability,
  readAvailabilityLimits,
  readBookableVariants,
  readFrontDeskMinLeadMinutes,
  readGenderMatching,
  readRefCaptureCounts,
  readTherapistLabels,
  readWhatsappRefExpected,
  recordRefCapture,
  type Sql,
  withUnitOfWork,
} from '@berelax/db'
import {
  FRONT_DESK_MIN_LEAD_SETTING_KEY,
  normaliseWhatsappRefCode,
  WHATSAPP_REF_CODE_HTML_PATTERN,
  WHATSAPP_REF_CODE_LENGTH,
  WHATSAPP_REF_EXPECTED_SETTING_KEY,
  WHATSAPP_REF_OPEN_QUESTION,
} from '@berelax/shared'
import type { AdminChrome } from '../../../src/components/admin/google-reauth-banner.ts'
import { handleBookingRequest } from '../../api/v1/bookings/handler.ts'
import { renderQuickBookHtml } from './render.ts'
import {
  QUICK_BOOK_FIELDS,
  QUICK_BOOK_PATH,
  type QuickBookAssignment,
  type QuickBookBooked,
  type QuickBookExclusion,
  type QuickBookForm,
  type QuickBookRateView,
  type QuickBookRefusal,
  type QuickBookRefused,
  type QuickBookStart,
  type QuickBookTherapist,
  type QuickBookVariant,
  type QuickBookView,
  type RefNotice,
  type RenderDirection,
  type TherapistRefusalReason,
  therapistRefusalSentence,
} from './view.ts'

/**
 * `/quick-book` — the screen the front desk actually uses (B-UI-04).
 *
 * The handler rather than the route binding, so `apps/web/src/quick-book.itest.ts` can drive it directly
 * against a real PostgreSQL with an injected clock. That is not a convenience: every start this screen
 * offers is computed from `now`, and `now` cannot be frozen behind a `next start`. The diary and the
 * pipeline board take the same split for the same reason.
 *
 * ## Two POSTs, and why not one
 *
 * The acceptance line is *"therapist and room are auto-assigned … and displayed before confirm"*, and
 * "before confirm" is only assertable if there is a state between the form and the booking. So `step=check`
 * solves and renders the assignment, and `step=confirm` books the tuple that was shown. One extra round
 * trip, and it buys the property the line asks for: the desk sees which room and which therapist before a
 * row exists, and the endpoint re-validates that exact tuple under a room lock rather than re-assigning
 * silently underneath a confirmation somebody has already read out.
 *
 * Neither step needs JavaScript. Both are plain `<form method="post">`, and the phone number travels in the
 * POST body across the two — never in a URL, because a query string is in every proxy log and a mobile
 * number is the customer's identity in this system (ADR 0014). The client's gender, the treatment and the
 * start travel the same way for consistency rather than for secrecy.
 *
 * ## Nothing here re-implements a rule that already exists
 *
 * `handleBookingRequest` (B-AVAIL-06) is CALLED with a synthesised `Request`, exactly as
 * `app/api/v1/book/handler.ts` calls it and for the same reason: that endpoint owns the price resolution,
 * the trading-date resolution, the blocklist check with its constant refusal body, `ensureCustomer`, the
 * idempotency claim, the room lock, the lifecycle event and the gender rule. A second copy of any of those
 * here would be a second path, and the cheapest way to keep two paths identical is to have one. The cost is
 * a JSON body assembled to be parsed again, which is a real cost and the right one.
 *
 * ## What this screen does NOT do, stated rather than discovered
 *
 * **It takes SOLO bookings only.** A Couple Massage needs two clients' genders and a Four Hands is
 * unassignable against the seeded room inventory at all (B-AVAIL-03's NOTE: every standard room 0012 seeds
 * is capacity 1, and 0024 counts appointment rows against `rooms.capacity`). A ten-second walk-in screen
 * that offered a shape the transaction refuses would be offering a control known to fail. Those go through
 * `/book` or the diary.
 *
 * **It offers the next two hours and not the whole day.** The grid is {@link GRID_STARTS} quarter-hours from
 * the first bookable one. ONE option per instant, each carrying every treatment the instant suits — the cut is
 * per treatment, at the trading day's close less that treatment's own duration, so a late start suits a
 * 45-minute treatment and not a 120-minute one. An instant no treatment suits is absent rather than present
 * and disabled. A booking further out is the diary's (B-UI-03): a different question — "when this week?" —
 * asked with a different instrument, and one option per (treatment, instant) pair would be a select holding
 * eight starts thirty-two times over, which is a control nobody can arrow through and, as this unit found, one
 * nothing can set by value either.
 */

/**
 * The actor every quick-book action is recorded under.
 *
 * `staff` with a label and no id, and the label names the SURFACE rather than a person: there is no admin
 * session until W-SYS-01, exactly as the diary, the pipeline board, the credentials screen, the
 * reassignment queue, the compliance calendar, the Messages inbox and the duplicate queue all record. A
 * plausible receptionist's name here would be indistinguishable from a real one in the audit trail (brief
 * rule 15). W-SYS-01 replaces the label with the signed-in operator.
 */
export const QUICK_BOOK_ACTOR: Actor = { kind: 'staff', label: 'Quick-book (front desk)' }

/**
 * `walk_in`, and it is the honest value for this screen rather than the flattering one.
 *
 * `booking.source` is a different axis from `customer.acquisition_source` (0053, Y9-crm-source): this says
 * how the BOOKING was taken, and a booking taken on the front-desk screen was taken at the front desk. It is
 * deliberately NOT derived from whether a ref code matched — a customer who arrived through WhatsApp and
 * then walked in still walked in, and rewriting the source from an attribution would destroy the one fact
 * this column is certain of in order to guess at another.
 */
export const QUICK_BOOK_SOURCE = 'walk_in' as const

/** How many quarter-hour starts the screen offers per treatment. See the header for why it is not a day. */
export const GRID_STARTS = 8
/** The grid step, in minutes. The diary's quarter-hour drop targets, so the two screens agree. */
export const GRID_STEP_MINUTES = 15

/**
 * Core's rule, injected exactly as `/book` injects it. `satisfies`, not a cast.
 *
 * `packages/db` may never import `packages/core`, so `queryAvailability` takes the rule that turns rows into
 * offerable starts as an argument. This line is what makes a field added to one declaration and not the
 * other a `pnpm typecheck` failure rather than a slot list nobody computed.
 */
const solve = solveAvailabilityQuery satisfies AvailabilitySolve

/**
 * Deliberately **no** availability memo on this screen.
 *
 * `/book` holds one process-wide `AvailabilityCache` and is right to: a public page is read far more often
 * than the rows change, and the memo is validated against `availability_epoch` so a stale entry is dropped
 * rather than served. Here the read immediately precedes a WRITE that a colleague may have raced, and
 * `queryAvailability`'s own header says an absent cache means "every request recomputes, which is correct
 * and slower". Correct-and-slower is the right side of that trade for one check that is about to take a
 * slot. It is also one round trip on a page a person is standing in front of.
 */

export interface QuickBookDeps {
  readonly sql: Sql
  /** Injected, so the suite can freeze it. Every offered start is computed from this and nothing else. */
  readonly now: () => number
}

export interface QuickBookRequest {
  readonly searchParams: URLSearchParams
  readonly chrome: AdminChrome
  /** The POST body, or null for a GET. */
  readonly body: URLSearchParams | null
  /** Passed through to the booking endpoint's audit rows. */
  readonly requestId: string | null
}

/**
 * What the screen says for each refusal, by NAME.
 *
 * A `Record` over the union, so a refusal added without a wording is a `pnpm typecheck` failure rather than
 * a blank panel at a front desk. Each names what to do next, because that is the only part the desk can
 * act on.
 */
const REFUSAL_SENTENCES: Readonly<Record<QuickBookRefusal, string>> = {
  unreadable_request:
    'That is not a booking this screen could have sent. Start again from the form below.',
  phone_not_eligible:
    'That is not a mobile number a booking can be taken against. A UAE mobile on 50, 52, 54, 55, 56 or ' +
    '58 — a landline cannot receive the confirmation.',
  unknown_treatment: 'That treatment is not on the menu. Choose one from the list.',
  start_not_offered:
    'That start is not one this screen offered for that treatment. Choose another.',
  start_has_passed:
    'That start was available when you checked and the time has since passed. Check again — the next ' +
    'start will be a different one, and so may the therapist and the room.',
  not_a_trading_date:
    'The premises does not trade at that time, so there is no business day to book it against.',
  no_assignment:
    'Nothing is free at that time: no therapist, no room, or both. The times still open are in the list.',
  therapist_not_eligible: 'That therapist may not take this treatment.',
  slot_taken:
    'That room and therapist were taken between the check and the confirm. Check again — the assignment ' +
    'will be a different one.',
  requires_client_gender:
    'Say who the treatment is for. Same-gender matching is enforced, so a booking with nobody named has ' +
    'no eligible therapist rather than a relaxed one.',
  booking_refused: 'The booking was refused.',
}

/** A refused view, from a name and whatever specific thing there is to add to its sentence. */
function refused(
  name: QuickBookRefusal,
  options: { readonly detail?: string; readonly therapistReason?: TherapistRefusalReason } = {},
): QuickBookRefused {
  const base = REFUSAL_SENTENCES[name]
  return {
    name,
    sentence: options.detail === undefined ? base : `${base} ${options.detail}`,
    therapistReason: options.therapistReason ?? null,
  }
}

/**
 * The eligibility reasons the read model can report, mapped onto what the screen says.
 *
 * An identity mapping today, and it is written out rather than cast for the reason the port's own header
 * gives: the two unions are declared in two packages that may not import each other, and a reason added to
 * `ExclusionReason` without a wording must be a compile error rather than a therapist excluded for a reason
 * the desk cannot read. `not_free_at_that_start` is absent from this table on purpose — it is not an
 * eligibility reason and the read model cannot produce it.
 */
const THERAPIST_REASON_FOR: Readonly<Record<ExclusionReason, TherapistRefusalReason>> = {
  not_employed: 'not_employed',
  missing_skill: 'missing_skill',
  credential_missing: 'credential_missing',
  credential_expired: 'credential_expired',
  not_rostered: 'not_rostered',
  on_approved_leave: 'on_approved_leave',
  gender_mismatch: 'gender_mismatch',
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const fieldOf = (source: URLSearchParams | null, name: string): string =>
  (source?.get(name) ?? '').trim()

/** The submitted form, echoed back so no refusal throws away what the desk typed. */
function formOf(body: URLSearchParams | null): QuickBookForm {
  return {
    phone: fieldOf(body, QUICK_BOOK_FIELDS.phone),
    ref: fieldOf(body, QUICK_BOOK_FIELDS.ref),
    variant: fieldOf(body, QUICK_BOOK_FIELDS.variant),
    gender: fieldOf(body, QUICK_BOOK_FIELDS.gender),
    start: fieldOf(body, QUICK_BOOK_FIELDS.start),
    notes: fieldOf(body, QUICK_BOOK_FIELDS.notes),
    therapist: fieldOf(body, QUICK_BOOK_FIELDS.therapist),
  }
}

export function directionFrom(params: URLSearchParams): RenderDirection {
  return params.get('dir') === 'rtl' ? 'rtl' : 'ltr'
}

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * The trading date the URL asked for, or null for "the one in progress".
 *
 * A URL field and not a form field, for the reason B-UI-01 gives for putting every choice in `/book`'s query
 * string: a day is a bookmarkable state of the screen, so the desk can keep a tab open on tomorrow. It is
 * also the only piece of this screen's state that may be in a URL — the mobile number, the ref code and the
 * note travel in the POST body, because a query string is in every proxy log.
 *
 * Shape-checked here rather than handed to Postgres as a date: an unparseable value becomes null, which is
 * the current day, and a well-formed date the premises does not trade on is answered by the window read as a
 * closure. A `22P02` from the driver would be a 503 where a sentence belongs.
 */
export function requestedDateFrom(params: URLSearchParams): string | null {
  const value = (params.get('date') ?? '').trim()
  return LOCAL_DATE.test(value) ? value : null
}

/**
 * Where every form on the page posts: this path, carrying the day and the direction and nothing else.
 *
 * Rebuilt from the two known fields rather than echoed from the request, so a query string somebody appends
 * cannot be reflected into a form's `action` — and so a refusal comes back to the same day the desk was
 * looking at instead of dropping them onto today.
 */
export function quickBookAction(params: URLSearchParams): string {
  const next = new URLSearchParams()
  const date = requestedDateFrom(params)
  if (date !== null) next.set('date', date)
  if (params.get('dir') === 'rtl') next.set('dir', 'rtl')
  const query = next.toString()
  return query === '' ? QUICK_BOOK_PATH : `${QUICK_BOOK_PATH}?${query}`
}

/** `19:45` in the premises' own zone, which is the only clock a front desk reads. */
const clockOf = (instant: number): string =>
  toLocal(instant as Instant, ASIA_DUBAI).time.slice(0, 5)

interface TradingWindow {
  readonly tradingDate: string
  readonly opensAt: number
  readonly closesAt: number
  /** True when `now` is inside `[opensAt, closesAt)`. False means this is the NEXT day that opens. */
  readonly openNow: boolean
}

/**
 * The trading day a walk-in belongs to: the one in progress, or the next one to open.
 *
 * ONE statement, and it answers both questions — which day, and whether the premises is open at this
 * instant — because the alternative is two reads that can disagree about the same row. `closes_at > now`
 * ordered ascending is the whole predicate: the previous day's row has already closed, whatever hour the
 * premises closes at, so the first row left is the current day if `now` is inside it and the next one if it
 * is not.
 *
 * No hour appears in this file, and that is a rule rather than tidiness: the trading hours live in
 * `premises_hours` and reach a surface through a read, so a literal in a rendered file goes on showing the
 * old hours after the owner has changed them — `packages/db/src/seed/premises.test.ts` enforces it, and it
 * caught a closing time typed into this very comment.
 *
 * A closure is an ABSENT row rather than a flag (0018, and B-UI-03's diary records the same), so "no rows"
 * and "not a trading day" are the same query result — which is why this answers `null` and the screen says
 * so by name instead of drawing an empty form.
 */
async function tradingWindowFor(
  sql: Sql,
  now: number,
  requested: string | null,
): Promise<TradingWindow | null> {
  const [row] = await sql<{ trading_date: string; opens_at: Date; closes_at: Date }[]>`
    select to_char(trading_date, 'YYYY-MM-DD') as trading_date, opens_at, closes_at
      from business_day
     where case when ${requested}::text is null then closes_at > ${new Date(now)}
                else trading_date = ${requested}::date end
     order by trading_date
     limit 1
  `
  if (row === undefined) return null
  const opensAt = row.opens_at.getTime()
  const closesAt = row.closes_at.getTime()
  return {
    tradingDate: row.trading_date,
    opensAt,
    closesAt,
    openNow: opensAt <= now && now < closesAt,
  }
}

/** The hours around an instant, as `resolveTradingDate` takes them. Shaped exactly as `/api/v1/bookings`. */
async function hoursAround(sql: Sql, instant: number): Promise<Map<string, TradingHours>> {
  const day = toLocal(instant as Instant, ASIA_DUBAI).date
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

/** One priced duration, labelled for a type-ahead select: style, treatment, duration, price. */
function variantLabel(variant: BookableVariantRow): string {
  const gross = formatMoney(grossMoneyFromFils(variant.grossFils))
  return `${variant.publicDisplayName} — ${variant.durationMinutes} min — ${gross}`
}

/**
 * The first start the desk may book, rounded UP to the grid.
 *
 * `max(opens_at, now + frontDeskLead)` and then up to the next quarter hour. Rounded up and never down,
 * because a start below the lead floor is one the availability engine refuses — so rounding down would
 * offer a control known to fail, and the first thing the desk would learn about the lead setting is that
 * the top option never works.
 */
export function firstGridStart(args: {
  readonly now: number
  readonly opensAt: number
  readonly leadMinutes: number
  readonly stepMinutes?: number
}): number {
  const step = (args.stepMinutes ?? GRID_STEP_MINUTES) * 60_000
  const earliest = Math.max(args.opensAt, args.now + args.leadMinutes * 60_000)
  return Math.ceil(earliest / step) * step
}

/**
 * The grid, per treatment.
 *
 * Cut at `closes_at` less the treatment's own duration, which is why it is per treatment rather than one
 * shared list: a 120-minute treatment starting 30 minutes before close is a start the solver refuses, and
 * offering it would be offering a control known to fail. That cut is also what makes the option's
 * `data-variant` load-bearing rather than decorative — the same clock time is offerable for a 45-minute
 * treatment and not for a 120-minute one.
 */
export function gridStartsFor(args: {
  readonly variants: readonly BookableVariantRow[]
  readonly from: number
  readonly closesAt: number
  readonly count?: number
  readonly stepMinutes?: number
}): readonly QuickBookStart[] {
  const step = (args.stepMinutes ?? GRID_STEP_MINUTES) * 60_000
  const count = args.count ?? GRID_STARTS
  const starts: QuickBookStart[] = []
  for (let index = 0; index < count; index += 1) {
    const instant = args.from + index * step
    const owners = args.variants
      .filter((variant) => instant <= args.closesAt - variant.durationMinutes * 60_000)
      .map((variant) => variant.serviceVariantId)
    // An instant no treatment suits is ABSENT rather than present and disabled: an option no choice of
    // treatment can enable is a control known to fail whatever else the operator does.
    if (owners.length === 0) continue
    starts.push({
      value: new Date(instant).toISOString(),
      label: clockOf(instant),
      serviceVariantIds: owners,
    })
  }
  return starts
}

const therapistOf = (row: {
  readonly therapistId: string
  readonly staffReference: string
}): QuickBookTherapist => ({ therapistId: row.therapistId, reference: row.staffReference })

/** Labels for a set of therapist ids, as a map. Ids the table does not know are simply absent. */
async function labelsFor(
  sql: Sql,
  therapistIds: readonly string[],
): Promise<Map<string, QuickBookTherapist>> {
  const rows = await readTherapistLabels(sql, therapistIds)
  return new Map(rows.map((row) => [row.therapistId, therapistOf(row)]))
}

/** The rooms, by id. Five rows; read once per render rather than joined into the availability statement. */
async function roomLabels(sql: Sql): Promise<Map<string, string>> {
  const rows = await sql<{ id: string; code: string; name: string }[]>`
    select id::text as id, code, name from rooms order by code
  `
  return new Map(rows.map((row) => [row.id, `${row.code} — ${row.name}`]))
}

/** The provisional values this screen stands on, named with their question ids. */
function assumptionsFor(args: {
  readonly frontDeskLeadMinutes: number
  readonly refExpected: boolean
}): readonly { readonly what: string; readonly openQuestionId: string }[] {
  return [
    {
      what:
        `The front desk may book with ${args.frontDeskLeadMinutes} minutes' notice ` +
        `(${FRONT_DESK_MIN_LEAD_SETTING_KEY}). Y9-lead states a minimum for ONLINE booking ` +
        `(${MIN_LEAD_SETTING_KEY}) and says nothing about the counter; a walk-in screen that applied the ` +
        'online figure could not book a walk-in.',
      openQuestionId: 'Y9-lead',
    },
    {
      what:
        'The front desk is ' +
        (args.refExpected ? '' : 'NOT ') +
        `expected to paste the WhatsApp ref code (${WHATSAPP_REF_EXPECTED_SETTING_KEY}). Until somebody ` +
        'says otherwise a low capture rate is reported as an unanswered question rather than as a failure, ' +
        'and a booking with no matched code is recorded as attribution unknown rather than guessed.',
      openQuestionId: WHATSAPP_REF_OPEN_QUESTION,
    },
    {
      what:
        'Same-gender therapist matching is enforced strictly, which is why the client’s gender is a ' +
        'required field on a screen whose acceptance names three.',
      openQuestionId: 'Y9-gender',
    },
  ]
}

/**
 * What each claim says, as a total table over the union.
 *
 * `Record<RefCaptureClaim, string>` and not `Record<string, string>` with a `??` behind it: a fourth claim
 * added to `@berelax/core` without a sentence here has to be a `pnpm typecheck` failure, because the
 * alternative is a fallback that silently prints one claim's wording for another — and the whole point of the
 * claim is that the same percentage means different things.
 */
const RATE_SENTENCES: Readonly<Record<RefCaptureClaim, string>> = {
  no_bookings:
    'No bookings have been taken at the desk yet, so there is no capture rate to report.',
  loop_unconfirmed:
    'Reported, not judged: nobody has said the front desk is expected to paste the ref code, so a low ' +
    'rate here is an unanswered question rather than a failure to capture.',
  measured:
    'The front desk is expected to record the ref code, so this rate is a measurement of how often it ' +
    'happens.',
}

async function rateView(sql: Sql): Promise<QuickBookRateView> {
  const [counts, expected] = await Promise.all([
    readRefCaptureCounts(sql),
    readWhatsappRefExpected(sql),
  ])
  const rate = refCaptureRate(counts, { expected })
  return {
    matched: rate.counts.matched,
    unknownCode: rate.counts.unknownCode,
    notOffered: rate.counts.notOffered,
    total: rate.total,
    claim: rate.claim,
    sentence: RATE_SENTENCES[rate.claim],
    openQuestionId: rate.openQuestionId,
  }
}

const page = (html: string, status = 200): Response =>
  new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // Never cached. A cached quick-book screen is a screen offering times that have gone, and the
      // confirmation is one customer's booking — a CDN with a default policy would serve it to another.
      'cache-control': 'no-store',
    },
    status,
  })

/**
 * Everything the screen needs that does not depend on what was submitted.
 *
 * Assembled in one place so the GET, a refusal and a confirmation are all the same page with the same
 * lists, rather than three renders that could disagree about which treatments exist.
 */
interface QuickBookShell {
  readonly window: TradingWindow | null
  readonly variants: readonly BookableVariantRow[]
  readonly starts: readonly QuickBookStart[]
  readonly leadMinutes: number
  readonly refExpected: boolean
  readonly dayLabel: string
  readonly lede: string
  readonly startHint: string
}

async function readShell(
  deps: QuickBookDeps,
  now: number,
  requestedDate: string | null,
): Promise<QuickBookShell> {
  const [window, variants, leadMinutes, refExpected] = await Promise.all([
    tradingWindowFor(deps.sql, now, requestedDate),
    readBookableVariants(deps.sql),
    readFrontDeskMinLeadMinutes(deps.sql),
    readWhatsappRefExpected(deps.sql),
  ])
  if (window === null) {
    return {
      window: null,
      variants,
      starts: [],
      leadMinutes,
      refExpected,
      dayLabel:
        requestedDate === null
          ? 'The premises has no open trading day on record.'
          : `The premises does not trade on ${requestedDate}.`,
      lede:
        'A closure is an ABSENT business day rather than a flag (0018), so "no rows" and "not a trading ' +
        'day" are the same query result — which is why this says so by name instead of drawing a form that ' +
        'looks ready and books nothing. Either it is a closed period or the calendar has not been ' +
        'generated that far ahead; the diary will say the same.',
      startHint: 'No trading day, so no start can be offered.',
    }
  }
  const from = firstGridStart({ now, opensAt: window.opensAt, leadMinutes })
  return {
    window,
    variants,
    starts: gridStartsFor({ variants, from, closesAt: window.closesAt }),
    leadMinutes,
    refExpected,
    dayLabel:
      `Trading day ${window.tradingDate}, ${clockOf(window.opensAt)} to ${clockOf(window.closesAt)}` +
      (window.openNow ? ', open now.' : `, not open yet — it opens at ${clockOf(window.opensAt)}.`),
    lede:
      'Phone, treatment, who it is for and a start. The therapist and the room are chosen by the ' +
      'availability solver and shown before anything is booked — there is nothing to pick. A booking for ' +
      'another day, or a Couple or Four Hands, goes through the diary.',
    startHint:
      `The next ${GRID_STARTS} quarter-hours a booking may start, from ${clockOf(from)}` +
      (leadMinutes === 0
        ? ' — the desk books with no minimum notice.'
        : ` — ${leadMinutes} minutes' notice is required at the desk.`),
  }
}

/** The view, with whatever outcome the step produced. One assembly point, so no state is half-rendered. */
async function viewFor(args: {
  readonly deps: QuickBookDeps
  readonly request: QuickBookRequest
  readonly shell: QuickBookShell
  readonly form: QuickBookForm
  readonly announcement: string
  readonly checked?: QuickBookAssignment | null
  readonly booked?: QuickBookBooked | null
  readonly refusal?: QuickBookRefused | null
  readonly refNotice?: RefNotice | null
}): Promise<QuickBookView> {
  const { shell } = args
  return {
    chrome: args.request.chrome,
    direction: directionFrom(args.request.searchParams),
    action: quickBookAction(args.request.searchParams),
    dayLabel: shell.dayLabel,
    lede: shell.lede,
    announcement: args.announcement,
    phoneHint:
      'Any spelling of a UAE mobile. It is normalised to E.164 and is the customer’s identity.',
    refHint:
      `${WHATSAPP_REF_CODE_LENGTH} characters from A–Z and 2–9. I, O, 0 and 1 are not used, because they ` +
      'are the four a person misreads off a phone screen. A code we do not hold is accepted with a ' +
      'warning and never blocks the booking.',
    refCodePattern: WHATSAPP_REF_CODE_HTML_PATTERN,
    refCodeLength: WHATSAPP_REF_CODE_LENGTH,
    genderWhy:
      'Required, and not this screen’s choice: same-gender matching is enforced, so a booking with nobody ' +
      'named has no eligible therapist rather than a relaxed one (Y9-gender).',
    startHint: shell.startHint,
    variants: shell.variants.map(
      (variant): QuickBookVariant => ({
        serviceVariantId: variant.serviceVariantId,
        label: variantLabel(variant),
      }),
    ),
    starts: shell.starts,
    form: args.form,
    checked: args.checked ?? null,
    booked: args.booked ?? null,
    refusal: args.refusal ?? null,
    refNotice: args.refNotice ?? null,
    rate: await rateView(args.deps.sql),
    assumptions: assumptionsFor({
      frontDeskLeadMinutes: shell.leadMinutes,
      refExpected: shell.refExpected,
    }),
  }
}

/** The screen, with nothing submitted. */
export async function handleQuickBookRead(
  request: QuickBookRequest,
  deps: QuickBookDeps,
): Promise<Response> {
  const now = deps.now()
  const shell = await readShell(deps, now, requestedDateFrom(request.searchParams))
  const view = await viewFor({
    deps,
    request,
    shell,
    form: formOf(null),
    announcement:
      shell.window === null
        ? 'No trading day is open, so nothing can be booked here.'
        : 'Ready. Type the mobile number.',
  })
  return page(renderQuickBookHtml(view))
}

interface ParsedEntry {
  readonly phoneE164: string
  readonly variant: BookableVariantRow
  readonly gender: 'female' | 'male'
  readonly startsAt: number
  readonly notes: string
  readonly ref: string
  readonly therapist: string
}

/**
 * The submitted entry, or the refusal that stops it.
 *
 * Every refusal is returned rather than thrown, and the order is deliberate: the shape errors first, then
 * the ones that need a read. A start that is not one this screen offered is refused BEFORE any availability
 * work, because a hand-crafted POST naming an arbitrary instant is otherwise a way to ask the solver
 * questions about the whole calendar from a screen that offers two hours.
 */
function parseEntry(
  form: QuickBookForm,
  shell: QuickBookShell,
  options: { readonly now: number; readonly requireOffered: boolean },
): ParsedEntry | { readonly refusal: QuickBookRefused } {
  const normalised = normalisePhoneResult(form.phone)
  if (!normalised.ok) return { refusal: refused('phone_not_eligible') }
  const variant = shell.variants.find((row) => row.serviceVariantId === form.variant)
  if (variant === undefined) return { refusal: refused('unknown_treatment') }
  if (form.gender !== 'female' && form.gender !== 'male') {
    return { refusal: refused('requires_client_gender') }
  }
  const startsAt = Date.parse(form.start)
  if (Number.isNaN(startsAt)) return { refusal: refused('start_not_offered') }
  if (options.requireOffered) {
    // The instant AND the pair: an instant this screen offered for a 45-minute treatment is not one it
    // offered for a 120-minute one, because the grid is cut at the close less each treatment's own duration.
    const offered = shell.starts.find(
      (start) =>
        start.value === form.start && start.serviceVariantIds.includes(variant.serviceVariantId),
    )
    if (offered === undefined) return { refusal: refused('start_not_offered') }
  } else {
    /*
      The CONFIRM, and it deliberately does not re-check the grid.

      The grid is an offer list computed from `now`, and `now` has moved since the check: with no minimum
      notice at the counter the first grid option can be one minute away, so a desk that reads an assignment
      out loud and then presses Confirm is the ORDINARY case. Re-checking the grid refuses that with
      `start_not_offered` — "not one this screen offered" about a start it had offered two seconds earlier,
      which is false and sends the operator to the wrong place. It is the defect this branch exists to fix.

      So the confirm checks what is still true: the start is on the grid STEP, it is inside this trading day's
      window, and it has not passed. A start that HAS passed is refused under its own name, because the remedy
      is to check again rather than to choose differently. Everything else is the booking transaction's: it
      re-validates the tuple under a room lock, which is the authority on whether it can still be delivered.
    */
    const window = shell.window
    if (window === null) return { refusal: refused('not_a_trading_date') }
    const step = GRID_STEP_MINUTES * 60_000
    if (startsAt % step !== 0 || startsAt < window.opensAt || startsAt >= window.closesAt) {
      return { refusal: refused('start_not_offered') }
    }
    if (startsAt < options.now) return { refusal: refused('start_has_passed') }
  }
  if (form.therapist !== '' && !UUID.test(form.therapist)) {
    return { refusal: refused('unreadable_request') }
  }
  return {
    phoneE164: normalised.e164,
    variant,
    gender: form.gender,
    startsAt,
    notes: form.notes.slice(0, 2_000),
    ref: form.ref,
    therapist: form.therapist,
  }
}

interface SolvedCheck {
  readonly slot: AvailabilitySlot
  readonly excluded: readonly QuickBookExclusion[]
  readonly alternatives: readonly QuickBookTherapist[]
}

/**
 * The assignment at one start, and everyone the read model removed.
 *
 * ONE `queryAvailability` per check, narrowed to the requested therapist when there is one — which is what
 * makes the override's refusal reason free rather than a second query: a therapist the read model excluded
 * appears in `answer.excluded` with the reason it gave, and a therapist it kept who simply has work appears
 * in neither list at that start. The two are different conversations with the front desk and this is where
 * they are told apart.
 */
async function solveCheck(
  deps: QuickBookDeps,
  entry: ParsedEntry,
  tradingDate: string,
): Promise<SolvedCheck | { readonly refusal: QuickBookRefused }> {
  const [leadMinutes, limits, genderMatching] = await Promise.all([
    readFrontDeskMinLeadMinutes(deps.sql),
    readAvailabilityLimits(deps.sql),
    readGenderMatching(deps.sql),
  ])
  const advanceDays = limits.maxAdvanceDays
  const answer = await queryAvailability(
    deps.sql,
    {
      tradingDate,
      serviceVariantId: entry.variant.serviceVariantId,
      minLeadMinutes: leadMinutes,
      /*
        The advance horizon is Y9-lead's ONLINE figure, used unchanged, and that asymmetry with the lead time
        is deliberate rather than an oversight. The argument for a separate desk LEAD is concrete — a walk-in
        is standing at the counter and two hours' notice would make this screen useless — and there is no
        equivalent argument for the far end: "how far ahead may a booking be made" is the same question
        whichever side of the counter asks it, and a second figure nobody could distinguish the effect of
        would be a setting that lies about what it controls.
      */
      maxAdvanceDays: advanceDays,
      clientGender: entry.gender,
      genderMatching,
      ...(entry.therapist === '' ? {} : { therapistIds: [entry.therapist] }),
      stepMinutes: GRID_STEP_MINUTES,
    },
    { solve, now: deps.now() },
  )
  if (answer.refusal === 'requires_client_gender') {
    return { refusal: refused('requires_client_gender') }
  }
  const excludedRows = answer.excluded
  const labels = await labelsFor(deps.sql, [
    ...excludedRows.map((row) => row.therapistId),
    ...answer.slots.flatMap((slot) => slot.availableTherapistIds),
  ])
  const unknown = (therapistId: string): QuickBookTherapist => ({
    therapistId,
    // A therapist the label table does not know is shown by the id it was asked about rather than by a
    // stand-in name. Unreachable in practice — the ids come from `employee` — and the alternative is a
    // label nobody set (brief rule 15).
    reference: `Therapist id ${therapistId}`,
  })
  const excluded: readonly QuickBookExclusion[] = excludedRows.map((row) => {
    // Never a fall back onto a REAL reason: an unrecognised value mapped onto `not_rostered` would send the
    // desk to fix a rota that is correct. `reason_not_recognised` says what happened instead.
    const reason = THERAPIST_REASON_FOR[row.reason as ExclusionReason] ?? 'reason_not_recognised'
    const label = labels.get(row.therapistId) ?? unknown(row.therapistId)
    return { ...label, reason, sentence: therapistRefusalSentence(reason) }
  })

  const slot = answer.slots.find((candidate) => candidate.startsAt === entry.startsAt)
  if (slot === undefined) {
    if (entry.therapist !== '') {
      // The override's refusal, and the whole point of narrowing the query: an excluded therapist gets the
      // reason the read model gave, and one it kept gets `not_free_at_that_start` — which is NOT an
      // eligibility reason, because telling the desk to fix a rota that is correct is worse than saying
      // nothing.
      const named = excludedRows.find((row) => row.therapistId === entry.therapist)
      const reason: TherapistRefusalReason =
        named === undefined
          ? 'not_free_at_that_start'
          : (THERAPIST_REASON_FOR[named.reason as ExclusionReason] ?? 'reason_not_recognised')
      return { refusal: refused('therapist_not_eligible', { therapistReason: reason }) }
    }
    const open = answer.slots
      .map((candidate) => clockOf(candidate.startsAt))
      .slice(0, 4)
      .join(', ')
    return {
      refusal: refused('no_assignment', {
        ...(open === '' ? {} : { detail: `Still open for this treatment: ${open}.` }),
      }),
    }
  }
  const alternatives = slot.availableTherapistIds
    .filter((therapistId) => !slot.therapistIds.includes(therapistId))
    .map((therapistId) => labels.get(therapistId) ?? unknown(therapistId))
  return { slot, excluded, alternatives }
}

/** The idempotency key. A pure function of the booking's identity — see `bookingIdempotencyKey`. */
export function quickBookIdempotencyKey(args: {
  readonly phoneE164: string
  readonly serviceVariantId: string
  readonly startsAt: number
}): string {
  const canonical = [args.phoneE164, args.serviceVariantId, String(args.startsAt)].join('|')
  return `quickbook:${createHash('sha256').update(canonical).digest('hex').slice(0, 32)}`
}

/**
 * What each capture outcome means in words, as a total table over the union.
 *
 * Total for the reason {@link RATE_SENTENCES} is: a fourth outcome would otherwise reach the confirmation as
 * another outcome's wording, and the only outcome anybody would notice is `matched`.
 */
const captureLabels: Readonly<Record<RefCaptureOutcome, string>> = {
  matched: 'WhatsApp conversation, matched by ref code',
  // `unknown` printed, never blank: a blank cell reads as a field nobody filled rather than as a fact
  // nobody has. This is Y9-crm-source's argument for `unknown` being the default, on a screen.
  unknown_code: 'Unknown — a code was typed and we hold no such code',
  not_offered: 'Unknown — no ref code was recorded',
}

/**
 * The assignment, displayed. Nothing is written.
 *
 * The ref is looked up HERE as well as at the confirm, and the two lookups answer two different questions:
 * this one is "what will the record say", so the desk can retype before committing, and the confirm's is
 * "what does the record say", at the instant the row is written. A single lookup at check time carried
 * forward in a hidden field would let a stale answer be recorded — and a code A-FIRST issues in between is
 * exactly the case this screen exists to catch.
 */
async function handleCheck(
  request: QuickBookRequest,
  deps: QuickBookDeps,
  shell: QuickBookShell,
  form: QuickBookForm,
): Promise<Response> {
  const parsed = parseEntry(form, shell, { now: deps.now(), requireOffered: true })
  if ('refusal' in parsed) {
    return page(
      renderQuickBookHtml(
        await viewFor({
          deps,
          request,
          shell,
          form,
          announcement: parsed.refusal.sentence,
          refusal: parsed.refusal,
        }),
      ),
      400,
    )
  }

  const hours = await hoursAround(deps.sql, parsed.startsAt)
  const resolution = resolveTradingDate(
    parsed.startsAt as Instant,
    (date) => hours.get(date),
    ASIA_DUBAI,
  )
  if (resolution.kind !== 'trading') {
    const refusal = refused('not_a_trading_date')
    return page(
      renderQuickBookHtml(
        await viewFor({ deps, request, shell, form, announcement: refusal.sentence, refusal }),
      ),
      409,
    )
  }

  const solved = await solveCheck(deps, parsed, resolution.date)
  const normalisedRef = normaliseWhatsappRefCode(parsed.ref)
  const matched = normalisedRef === null ? null : await matchWhatsappRef(deps.sql, normalisedRef)
  const decision = decideRefCapture({
    entered: parsed.ref,
    matchedRefCode: matched?.refCode ?? null,
  })
  const refNotice: RefNotice | null =
    decision.outcome === 'matched'
      ? 'matched'
      : decision.outcome === 'unknown_code'
        ? 'unknown_code'
        : null

  if ('refusal' in solved) {
    return page(
      renderQuickBookHtml(
        await viewFor({
          deps,
          request,
          shell,
          form,
          announcement: solved.refusal.sentence,
          refusal: solved.refusal,
          refNotice,
        }),
      ),
      409,
    )
  }

  const rooms = await roomLabels(deps.sql)
  const therapists = await labelsFor(deps.sql, solved.slot.therapistIds)
  const assignment: QuickBookAssignment = {
    treatmentLabel: variantLabel(parsed.variant),
    startLabel: `${clockOf(solved.slot.startsAt)} on ${resolution.date}`,
    roomId: solved.slot.roomId,
    roomLabel: rooms.get(solved.slot.roomId) ?? `Room id ${solved.slot.roomId}`,
    therapists: solved.slot.therapistIds.map(
      (therapistId) =>
        therapists.get(therapistId) ?? { therapistId, reference: `Therapist id ${therapistId}` },
    ),
    priceLabel: formatMoney(grossMoneyFromFils(parsed.variant.grossFils)),
    alternatives: solved.alternatives,
    excluded: solved.excluded,
  }
  return page(
    renderQuickBookHtml(
      await viewFor({
        deps,
        request,
        shell,
        form,
        announcement:
          `Assigned ${assignment.roomLabel} with ` +
          `${assignment.therapists.map((therapist) => therapist.reference).join(', ')} at ` +
          `${clockOf(solved.slot.startsAt)}. Nothing is booked yet.`,
        checked: assignment,
        refNotice,
      }),
    ),
  )
}

interface BookingAnswer {
  readonly bookingId: string
  readonly roomId: string
  readonly therapistIds: readonly string[]
}

/**
 * The booking, through the ONE endpoint that owns it.
 *
 * A synthesised `Request` for the reason `app/api/v1/book/handler.ts` gives: there is exactly one
 * implementation of the price resolution, the blocklist, `ensureCustomer`, the idempotency claim, the room
 * lock, the lifecycle event and the gender rule, and this screen's whole contribution is the body and the
 * key. The refusal is mapped back onto this screen's own vocabulary so the desk reads a sentence rather
 * than a JSON error.
 */
async function bookThrough(
  deps: QuickBookDeps,
  request: QuickBookRequest,
  args: {
    readonly entry: ParsedEntry
    readonly roomId: string
    readonly therapistIds: readonly string[]
  },
): Promise<BookingAnswer | { readonly refusal: QuickBookRefused }> {
  const headers = new Headers({
    'content-type': 'application/json',
    'idempotency-key': quickBookIdempotencyKey({
      phoneE164: args.entry.phoneE164,
      serviceVariantId: args.entry.variant.serviceVariantId,
      startsAt: args.entry.startsAt,
    }),
  })
  if (request.requestId !== null) headers.set('x-request-id', request.requestId)
  const response = await handleBookingRequest(
    { sql: deps.sql, now: () => deps.now() as Instant },
    new Request(`https://quick-book.invalid/api/v1/bookings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        phone: args.entry.phoneE164,
        source: QUICK_BOOK_SOURCE,
        clientGender: args.entry.gender,
        ...(args.entry.notes === '' ? {} : { notes: args.entry.notes }),
        deliveries: [
          {
            serviceVariantId: args.entry.variant.serviceVariantId,
            // Solo only. See the header: a Couple needs two clients' genders and a Four Hands is
            // unassignable against the seeded room inventory, so offering either would be offering a
            // control the transaction refuses.
            shape: 'solo',
            roomId: args.roomId,
            therapistIds: [...args.therapistIds],
            startsAt: new Date(args.entry.startsAt).toISOString(),
          },
        ],
      }),
    }),
  )
  const body = (await response.json()) as {
    bookingId?: string
    error?: string
    refusal?: string
    deliveries?: { roomId: string; therapistIds: string[] }[]
  }
  if (response.status !== 200 && response.status !== 201) {
    const name: QuickBookRefusal =
      body.error === 'slot_unavailable'
        ? 'slot_taken'
        : body.error === 'requires_client_gender'
          ? 'requires_client_gender'
          : body.error === 'phone_not_eligible'
            ? 'phone_not_eligible'
            : 'booking_refused'
    return {
      refusal: refused(name, {
        // The endpoint's own refusal name, and never its prose: `NO_AVAILABILITY_BODY` is a frozen constant
        // precisely so a blocked contact and a taken slot are byte-identical, and echoing free text from it
        // onto a screen is how that property gets eroded by somebody making an error message friendlier.
        ...(body.refusal === undefined
          ? {}
          : { detail: `The endpoint refused it: ${body.refusal}.` }),
      }),
    }
  }
  const delivery = body.deliveries?.[0]
  if (body.bookingId === undefined || delivery === undefined) {
    return { refusal: refused('booking_refused') }
  }
  return {
    bookingId: body.bookingId,
    roomId: delivery.roomId,
    therapistIds: delivery.therapistIds,
  }
}

/**
 * The booking, and then the attribution.
 *
 * In that order and in two transactions, which is the ordering C-CRM-01's lifecycle stamp takes and for the
 * same reason: the booking is the fact the customer is waiting for and the attribution is a segmentation, so
 * rolling a committed booking back because an attribution row could not be written would be the wrong way
 * round. It is also the acceptance line — the ref field must never block the booking — made structural: the
 * capture write happens after the booking is durable, so no failure in it can refuse one.
 *
 * `recordRefCapture` is idempotent per booking, so a replayed booking (the endpoint answers 200 with the
 * original) records nothing new and cannot count the same booking twice.
 */
async function handleConfirm(
  request: QuickBookRequest,
  deps: QuickBookDeps,
  shell: QuickBookShell,
  form: QuickBookForm,
): Promise<Response> {
  const parsed = parseEntry(form, shell, { now: deps.now(), requireOffered: false })
  if ('refusal' in parsed) {
    return page(
      renderQuickBookHtml(
        await viewFor({
          deps,
          request,
          shell,
          form,
          announcement: parsed.refusal.sentence,
          refusal: parsed.refusal,
        }),
      ),
      400,
    )
  }
  const roomId = fieldOf(request.body, QUICK_BOOK_FIELDS.room)
  const assigned = (request.body?.getAll(QUICK_BOOK_FIELDS.assigned) ?? []).map((value) =>
    value.trim(),
  )
  if (!UUID.test(roomId) || assigned.length === 0 || !assigned.every((id) => UUID.test(id))) {
    const refusal = refused('unreadable_request')
    return page(
      renderQuickBookHtml(
        await viewFor({ deps, request, shell, form, announcement: refusal.sentence, refusal }),
      ),
      400,
    )
  }

  const booked = await bookThrough(deps, request, { entry: parsed, roomId, therapistIds: assigned })
  if ('refusal' in booked) {
    return page(
      renderQuickBookHtml(
        await viewFor({
          deps,
          request,
          shell,
          form,
          announcement: booked.refusal.sentence,
          refusal: booked.refusal,
        }),
      ),
      409,
    )
  }

  // The attribution, decided at the instant of booking rather than at the check. A code A-FIRST issued in
  // between is a match, and a check-time answer carried in a hidden field would have recorded it as unknown.
  const normalisedRef = normaliseWhatsappRefCode(parsed.ref)
  const matched = normalisedRef === null ? null : await matchWhatsappRef(deps.sql, normalisedRef)
  const decision = decideRefCapture({
    entered: parsed.ref,
    matchedRefCode: matched?.refCode ?? null,
  })
  const capture = await withUnitOfWork(
    deps.sql,
    QUICK_BOOK_ACTOR,
    (uow) =>
      recordRefCapture(uow, {
        bookingId: booked.bookingId,
        outcome: decision.outcome,
        refCode: decision.refCode,
        enteredCode: decision.enteredCode,
      }),
    request.requestId === null ? {} : { requestId: request.requestId },
  )

  const rooms = await roomLabels(deps.sql)
  const therapists = await labelsFor(deps.sql, booked.therapistIds)
  const view = await viewFor({
    deps,
    request,
    shell,
    form,
    announcement:
      `Booked at ${clockOf(parsed.startsAt)}. ` +
      (capture.outcome === 'matched'
        ? 'Attributed to the WhatsApp conversation the ref code names.'
        : 'Attribution unknown — no ref code matched.'),
    booked: {
      bookingId: booked.bookingId,
      treatmentLabel: variantLabel(parsed.variant),
      startLabel: `${clockOf(parsed.startsAt)}`,
      roomId: booked.roomId,
      roomLabel: rooms.get(booked.roomId) ?? `Room id ${booked.roomId}`,
      therapists: booked.therapistIds.map(
        (therapistId) =>
          therapists.get(therapistId) ?? { therapistId, reference: `Therapist id ${therapistId}` },
      ),
      priceLabel: formatMoney(grossMoneyFromFils(parsed.variant.grossFils)),
      captureOutcome: capture.outcome,
      captureLabel: captureLabels[capture.outcome],
    } satisfies QuickBookBooked,
    refNotice: decision.warns ? 'unknown_code' : decision.outcome === 'matched' ? 'matched' : null,
  })
  return page(renderQuickBookHtml(view), 201)
}

/** One POST, two steps. `step` is a field and not a path, so the body is parsed in one place. */
export async function handleQuickBookWrite(
  request: QuickBookRequest,
  deps: QuickBookDeps,
): Promise<Response> {
  const now = deps.now()
  const shell = await readShell(deps, now, requestedDateFrom(request.searchParams))
  const form = formOf(request.body)
  const step = fieldOf(request.body, QUICK_BOOK_FIELDS.step)
  if (shell.window === null) {
    const refusal = refused('not_a_trading_date')
    return page(
      renderQuickBookHtml(
        await viewFor({ deps, request, shell, form, announcement: refusal.sentence, refusal }),
      ),
      409,
    )
  }
  if (step === 'confirm') return await handleConfirm(request, deps, shell, form)
  if (step === 'check') return await handleCheck(request, deps, shell, form)
  const refusal = refused('unreadable_request')
  return page(
    renderQuickBookHtml(
      await viewFor({ deps, request, shell, form, announcement: refusal.sentence, refusal }),
    ),
    400,
  )
}
