/**
 * Everything `/book` decides that is not a read and not a render: the URL, the day strip, the grouping.
 *
 * A `.ts` module rather than part of the page, for the reason `src/routes/nav.ts` gives: `apps/web`'s
 * `tsconfig` sets `jsx: "preserve"`, so vitest cannot parse a `.tsx` from this application at all. Every
 * decision here is therefore checkable in a unit test that needs no browser, no server and no database —
 * which is where a grouping boundary and a validation rule belong, because both are pure functions of their
 * input and both are wrong in ways a screenshot cannot show.
 *
 * ## Why the state is in the URL and not in the island
 *
 * docs/09 §3 requires steps 1–3 to complete with JavaScript off, and the booking flow to be *the one*
 * client island. Those two together decide the shape: every choice a reader makes — treatment, duration,
 * therapist, gender, day, time — is a field submitted by a GET form, so the server renders the next state
 * and the URL is shareable, bookmarkable and restorable after the phone goes into a pocket. The island adds
 * the keyboard behaviour and the live region on top of a page that already works without it.
 *
 * It also makes the render a pure function of the URL plus the database, which is what lets the screenshot
 * matrix pin a date and get byte-identical captures: nothing on the page is derived from the moment it was
 * rendered except the day strip's starting point, and that is a field too.
 */

import { ASIA_DUBAI, type Instant, minutesSinceMidnight, toLocal } from '@berelax/core'
import type { Locale } from '../i18n/locales.ts'

/** The path, in the default locale. `localisedPath` turns it into the Arabic one. */
export const BOOK_PATH = '/book'

/**
 * How many trading dates the day strip offers at once.
 *
 * Seven, which is a week of the business's own days rather than a calendar week — a closed date is absent
 * from `business_day`, so seven rows may span more than seven nights. Seven because the strip has to fit
 * across 390px at 48px per target without becoming a scroller with hidden ends, and because a reader
 * choosing a massage is choosing within the week.
 */
export const DAY_STRIP_DAYS = 7

/**
 * The query fields, named once.
 *
 * Exported because three places spell them: the form inputs, the parser, and the tests that drive the page
 * through its own URL. Three literals is three places one of them becomes `therapistId`.
 */
export const BOOK_FIELDS = {
  variant: 'variant',
  date: 'date',
  therapist: 'therapist',
  gender: 'gender',
  slot: 'slot',
  step: 'step',
  /**
   * The reader-reported problem, when there is one. B-UI-02.
   *
   * Two of the nine edge states docs/09 §3 enumerates cannot be derived from anything the server can
   * see — *"OTP never arrives"* and *"network drop mid-submit"* are both statements about what happened
   * outside this process — so each has a URL that says it. That is what makes them **states with an
   * address** rather than a client-side flash: a reader can reload, share the link with the desk, and the
   * page still says the same thing. See {@link BOOK_ISSUES}.
   */
  issue: 'issue',
  /** The booking a confirmation is about. Only honoured for the booking THIS session produced. */
  booking: 'booking',
  /** Where a verified phone leads: the confirm step, or the waitlist join. See {@link BOOK_AFTER}. */
  after: 'after',
  /**
   * What the last submission did wrong, carried back by the POST endpoint's redirect.
   *
   * In the URL rather than in a flash cookie, so the state a reader is looking at is the state the URL
   * describes — which is what makes a failing step reloadable, shareable with the desk and reproducible
   * in a test with a plain `fetch`. The vocabulary is `BOOK_FLOW_ERRORS` in `./flow.ts`; the page
   * validates against it and renders nothing for a value it does not know, so a crawler following a
   * mangled query string cannot put words on the page.
   */
  error: 'error',
} as const

/**
 * Every step of the flow, including the four B-UI-02 adds.
 *
 * `choose` covers steps 1–3 (treatment, therapist, day and time), which are one screen because they are
 * one GET form set — see the module header. `details`, `otp`, `confirm` and `booked` are docs/09 §3's
 * steps 4 and 5 split at the two points a reader waits: for an SMS, and for a booking to commit.
 *
 * `waitlist` and `waitlisted` are the join B-UI-01 deferred here. They are steps rather than a separate
 * route because they need exactly what the confirm step needs — a verified phone — and a second route
 * would be a second place that requirement could be forgotten.
 */
export const BOOK_STEPS = [
  'choose',
  'details',
  'otp',
  'confirm',
  'booked',
  'waitlist',
  'waitlisted',
] as const
export type BookStep = (typeof BOOK_STEPS)[number]

/**
 * The steps that require a verified phone.
 *
 * Declared as data rather than as a condition at each step's render, because the failure of getting it
 * wrong is silent in the direction that matters: a `confirm` step that rendered without checking would
 * take a booking for a number nobody proved, and it would look exactly like a working page.
 */
export const VERIFIED_STEPS: readonly BookStep[] = ['confirm', 'booked', 'waitlist', 'waitlisted']

/**
 * What a reader can tell the page went wrong, as a URL.
 *
 * Closed, and deliberately only two. Everything else on docs/09 §3's list is something the server can
 * work out — the slot, the therapist, the room, the close, the session, the replay — and a field a reader
 * can set for any of those would let a URL assert a state the page has not checked.
 */
export const BOOK_ISSUES = ['code_not_received', 'interrupted'] as const
export type BookIssue = (typeof BOOK_ISSUES)[number]

/**
 * The refusals the POST endpoint reports back through the URL.
 *
 * Here rather than in `./flow.ts` because `error` is a QUERY FIELD, and this module is what the URL is. It
 * was in flow.ts first, and `pnpm boundaries` refused the cycle that made: state.ts needed the guard below
 * as a VALUE, and flow.ts needs `BookStep` and `BookAfter` from here. Placement, not a re-export — a
 * re-export would have satisfied the cruiser and left two modules that each need the other.
 *
 * Distinct from the nine edge states, and the distinction is what stops the two vocabularies merging into
 * one list nobody can reason about: an edge state is *the situation a reader is in* and is derived from
 * facts; these are *what this submission did wrong*, and every one of them is answered by the reader
 * typing something different. A wrong code is not an edge state — it is the ordinary second attempt.
 */
export const BOOK_FLOW_ERRORS = [
  /**
   * The submission arrived for an attempt that had already produced a booking.
   *
   * The one member that is not something the reader typed wrong, and it is here rather than in
   * `BOOK_ISSUES` for a reason: docs/09 §3's *"double submission"* is a fact about a SUBMISSION, which is
   * what this vocabulary carries, and `BOOK_ISSUES` is what a reader may assert about themselves. The page
   * turns it into the `double_submission` edge state only when the session really holds a booking, so a
   * URL cannot put a "you are already booked" panel in front of somebody who is not.
   */
  'already_booked',
  'phone_not_eligible',
  'wrong_code',
  'code_expired',
  'no_live_challenge',
  'locked',
  'rate_limited',
  'send_failed',
  'nothing_chosen',
  'not_available',
  'waitlist_unavailable',
  'invalid_request',
] as const
export type BookFlowError = (typeof BOOK_FLOW_ERRORS)[number]

export function isBookFlowError(value: string | null): value is BookFlowError {
  return value !== null && (BOOK_FLOW_ERRORS as readonly string[]).includes(value)
}

/** Where verification leads. Two destinations, both of which need the customer id it produces. */
export const BOOK_AFTER = ['confirm', 'waitlist'] as const
export type BookAfter = (typeof BOOK_AFTER)[number]

/** The client's gender, which strict same-gender matching (B-AVAIL-05) refuses to proceed without. */
export const CLIENT_GENDERS = ['female', 'male'] as const
export type ClientGender = (typeof CLIENT_GENDERS)[number]

/**
 * The URL's own state, after validation.
 *
 * Every field is nullable and every invalid value becomes null rather than an error, and that is a
 * decision about what this page is: a public URL that anything may link to, including a crawler following
 * a mangled query string. A 500 on `?date=lol` would be a page that a stray link can take off the air, so
 * an unreadable field is dropped and the page renders its own first step — which is also what a reader who
 * arrived with no query string sees.
 */
export interface BookingParams {
  readonly variant: string | null
  readonly date: string | null
  readonly therapist: string | null
  readonly gender: ClientGender | null
  /** The chosen start, as epoch milliseconds. A wall-clock string would carry no date and no zone. */
  readonly slot: number | null
  readonly step: BookStep
  /** What the reader says went wrong, or null. See {@link BOOK_ISSUES}. */
  readonly issue: BookIssue | null
  /**
   * The booking a confirmation is about, or null.
   *
   * Validated as a uuid here and **authorised** in `bookingPageData`, which shows it only when the
   * session that asked for it is the session that produced it. A uuid in a query string is not
   * permission to read a booking, and treating it as one would make every booking on the system
   * readable by anybody who could guess a v7 uuid — which is not as hard as it sounds, because v7 leads
   * with a timestamp.
   */
  readonly booking: string | null
  readonly after: BookAfter | null
  /** What the last submission did wrong, or null. The vocabulary lives in `./flow.ts`. */
  readonly error: BookFlowError | null
}

/** What Next hands a page as `searchParams`. A repeated field arrives as an array. */
export type RawSearchParams = Readonly<Record<string, string | string[] | undefined>>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * The first value of a field, or null.
 *
 * First rather than last, and never joined: `?date=a&date=b` is one field submitted twice, which happens
 * when a form is re-submitted from a stale page, and joining the two would produce `a,b` — a value no
 * validator below accepts, so the page would fall back to its first step instead of honouring the choice
 * that is actually there.
 */
function first(raw: RawSearchParams, field: string): string | null {
  const value = raw[field]
  if (value === undefined) return null
  const single = Array.isArray(value) ? value[0] : value
  return single === undefined || single === '' ? null : single
}

/** The URL's state, with every unreadable field dropped. */
export function parseBookingParams(raw: RawSearchParams): BookingParams {
  const variant = first(raw, BOOK_FIELDS.variant)
  const date = first(raw, BOOK_FIELDS.date)
  const therapist = first(raw, BOOK_FIELDS.therapist)
  const gender = first(raw, BOOK_FIELDS.gender)
  const slot = first(raw, BOOK_FIELDS.slot)
  const step = first(raw, BOOK_FIELDS.step)
  const issue = first(raw, BOOK_FIELDS.issue)
  const booking = first(raw, BOOK_FIELDS.booking)
  const after = first(raw, BOOK_FIELDS.after)
  const error = first(raw, BOOK_FIELDS.error)
  return {
    variant: variant !== null && UUID.test(variant) ? variant : null,
    date: date !== null && ISO_DATE.test(date) ? date : null,
    therapist: therapist !== null && UUID.test(therapist) ? therapist : null,
    gender: isClientGender(gender) ? gender : null,
    // `Number.isSafeInteger` and not `Number.parseInt`: `parseInt('19:45')` is 19, a valid-looking
    // instant in January 1970 that would render a slot list for the Nixon administration.
    slot:
      slot !== null && /^\d{1,15}$/.test(slot) && Number.isSafeInteger(Number(slot))
        ? Number(slot)
        : null,
    // Membership against the declared list rather than a chain of comparisons, so a step added to
    // `BOOK_STEPS` and not to the parser is a step the URL can never reach — which is a bug that
    // presents as "the link from the form goes back to the first screen".
    step: isBookStep(step) ? step : 'choose',
    issue: isBookIssue(issue) ? issue : null,
    booking: booking !== null && UUID.test(booking) ? booking : null,
    after: isBookAfter(after) ? after : null,
    error: isBookFlowError(error) ? error : null,
  }
}

export function isClientGender(value: string | null): value is ClientGender {
  return value !== null && (CLIENT_GENDERS as readonly string[]).includes(value)
}

export function isBookStep(value: string | null): value is BookStep {
  return value !== null && (BOOK_STEPS as readonly string[]).includes(value)
}

export function isBookIssue(value: string | null): value is BookIssue {
  return value !== null && (BOOK_ISSUES as readonly string[]).includes(value)
}

export function isBookAfter(value: string | null): value is BookAfter {
  return value !== null && (BOOK_AFTER as readonly string[]).includes(value)
}

/**
 * A URL for one state of this page, with the empty fields left out.
 *
 * Built from a record rather than by string concatenation so a field can never be spelled twice, and
 * sorted so two states that differ in nothing produce the same URL — which is what keeps the canonical
 * link, the day strip and a test's expectation from disagreeing about the same page.
 */
export function bookHref(
  basePath: string,
  fields: Readonly<Record<string, string | number | null>>,
): string {
  const query = new URLSearchParams()
  for (const key of Object.keys(fields).sort()) {
    const value = fields[key]
    if (value === null || value === undefined || value === '') continue
    query.set(key, String(value))
  }
  const rendered = query.toString()
  return rendered === '' ? basePath : `${basePath}?${rendered}`
}

/**
 * The parts of a day the slot grid is grouped into. docs/09 §3: *"a day strip plus a grouped slot grid
 * (morning / afternoon / evening), not a wall of times."*
 */
export const SLOT_GROUPS = ['morning', 'afternoon', 'evening'] as const
export type SlotGroupName = (typeof SLOT_GROUPS)[number]

/**
 * Which part of the day a start belongs to.
 *
 * The boundaries are 12:00 and 17:00 in the premises' own zone, and there is a third rule that is the
 * whole reason this is a function rather than a comparison at the call site: **a start after midnight
 * belongs to the evening of the trading date it is part of.** Trading here runs from late morning into the
 * small hours, so 00:30 is the late end of the previous day's session (ADR 0007) — and grouping it by its
 * wall-clock hour would file it under "morning" and print it above the 19:45 it follows, on a page whose
 * whole subject is the order of the evening.
 *
 * The cut is 03:00 and not the close itself, for two reasons: the close is exclusive, and it is a value in
 * `premises_hours` that an override may extend. Anything in the small hours is the tail of a night, never
 * the start of a morning — and this module must not spell the trading hours, which live in that row and
 * reach a page through `readPremisesFacts` (`premises.test.ts` fails on a literal here).
 */
export function slotGroupOf(startsAt: number): SlotGroupName {
  const minutes = minutesSinceMidnight(toLocal(startsAt as Instant, ASIA_DUBAI).time)
  if (minutes < 3 * 60) return 'evening'
  if (minutes < 12 * 60) return 'morning'
  if (minutes < 17 * 60) return 'afternoon'
  return 'evening'
}

/** A start, ready to render: its instant, its wall-clock label, and the group it sits in. */
export interface GroupedStart {
  readonly startsAt: number
  /** `19:45`, in the premises' zone. Latin digits in both locales; see {@link wallClock}. */
  readonly label: string
  readonly group: SlotGroupName
}

/**
 * The starts of one day, in the three groups, in time order, with empty groups dropped.
 *
 * Sorted here rather than trusted from the query: `queryAvailability` returns the solver's order, and the
 * one property this page needs of it — that 23:45 is after 19:45 and 00:30 is after both — is a property
 * of the *trading day*, not of an array. Sorting by instant gets the after-midnight tail right for free,
 * which comparing labels would not.
 */
export function groupStarts(startsAt: readonly number[]): readonly {
  readonly group: SlotGroupName
  readonly starts: readonly GroupedStart[]
}[] {
  const ordered = [...new Set(startsAt)].sort((left, right) => left - right)
  const grouped = ordered.map((instant) => ({
    startsAt: instant,
    label: wallClock(instant),
    group: slotGroupOf(instant),
  }))
  return SLOT_GROUPS.map((group) => ({
    group,
    starts: grouped.filter((start) => start.group === group),
  })).filter((section) => section.starts.length > 0)
}

/**
 * A start as `HH:MM` in the premises' zone.
 *
 * Through `toLocal` from `@berelax/core` rather than `Intl.DateTimeFormat`, and the difference matters on
 * the Arabic document: `DateTimeFormat('ar-AE')` returns Arabic-Indic digits and a 12-hour clock with an
 * Arabic meridiem, and docs/08 §7 requires every number, price and time range to be Latin digits inside a
 * `<bdi>`. One spelling of a time, in both languages, is also one thing for a test to assert.
 */
export function wallClock(startsAt: number): string {
  return toLocal(startsAt as Instant, ASIA_DUBAI).time
}

/**
 * The Intl locale each document formats a date under.
 *
 * `-u-nu-latn` is stated rather than relied on. docs/08 §7 chose Latin numerals for Arabic, which is UAE
 * commercial practice and what `formatAmount` already produces; CLDR's default numbering for `ar-AE`
 * happens to be `latn` too, so the extension changes nothing **today**. It is here for the reason
 * `formatMoney` in `@berelax/core` states it: the decision belongs in the source rather than in a CLDR
 * default a future ICU may revise, and the alternative is an Arabic day strip carrying Arabic-Indic digits
 * beside a Latin-digit price — two numbering systems on one page, neither of which looks wrong alone.
 */
const INTL_LOCALE: Readonly<Record<Locale, string>> = { en: 'en-AE', ar: 'ar-AE-u-nu-latn' }

/** How much of a date is spelled out. The strip wants the short one; a live region wants the long one. */
export type DateLength = 'short' | 'long'

const dateFormatters = new Map<string, Intl.DateTimeFormat>()

function dateFormatter(locale: Locale, length: DateLength): Intl.DateTimeFormat {
  const key = `${locale}|${length}`
  const held = dateFormatters.get(key)
  if (held !== undefined) return held
  const created = new Intl.DateTimeFormat(INTL_LOCALE[locale], {
    weekday: length === 'long' ? 'long' : 'short',
    day: 'numeric',
    month: length === 'long' ? 'long' : 'short',
    // UTC, because the input is already a trading DATE rather than an instant. Formatting
    // `2026-09-26T00:00:00Z` in Asia/Dubai would print the 26th, and formatting it in a negative offset
    // would print the 25th — a day strip whose labels are one day out of step with its own values.
    timeZone: 'UTC',
  })
  dateFormatters.set(key, created)
  return created
}

/**
 * A trading date as a reader's own words: `Sat 26 Sep`, or `Saturday 26 September`.
 *
 * Memoised per locale and length. `Intl.DateTimeFormat`'s constructor is the expensive half and a day strip
 * builds fourteen labels per render; the formatter itself is stateless, so sharing one is safe.
 */
export function tradingDateLabel(
  tradingDate: string,
  locale: Locale,
  length: DateLength = 'short',
): string {
  return dateFormatter(locale, length).format(new Date(`${tradingDate}T00:00:00Z`))
}

/** One cell of the day strip. */
export interface DayStripEntry {
  readonly tradingDate: string
  readonly selected: boolean
}

/**
 * The strip, and which of its days is selected.
 *
 * The selected date is the one asked for when the strip offers it, and **the first day otherwise** — which
 * is what makes "the first day's slot list" the state a bare `/book` renders, and what stops a link to a
 * date the premises does not trade on rendering an empty page. A date outside the strip is not an error: a
 * bookmark from last week is exactly that, and the page answers with the days it can offer now.
 */
export function dayStrip(
  tradingDates: readonly string[],
  requested: string | null,
): { readonly days: readonly DayStripEntry[]; readonly selected: string | null } {
  const offered = tradingDates.slice(0, DAY_STRIP_DAYS)
  const selected =
    requested !== null && offered.includes(requested) ? requested : (offered[0] ?? null)
  return {
    days: offered.map((tradingDate) => ({ tradingDate, selected: tradingDate === selected })),
    selected,
  }
}
