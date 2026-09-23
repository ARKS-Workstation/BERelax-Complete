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
} as const

/** The steps this unit renders. B-UI-02 adds `details` and `confirm`. */
export const BOOK_STEPS = ['choose', 'waitlist'] as const
export type BookStep = (typeof BOOK_STEPS)[number]

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
    step: step === 'waitlist' ? 'waitlist' : 'choose',
  }
}

export function isClientGender(value: string | null): value is ClientGender {
  return value !== null && (CLIENT_GENDERS as readonly string[]).includes(value)
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
