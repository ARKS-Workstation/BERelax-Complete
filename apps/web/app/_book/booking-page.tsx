/**
 * `/book` — the body, rendered once and served in two locales.
 *
 * Two route files and one component, exactly as `app/_content/pages.tsx` is ten and five: the structure
 * of a page is one thing and the language of it is another, and two copies would be two places the layout
 * could drift — with the RTL half of every assertion then testing a different component from the LTR half.
 *
 * ## What is a server component and what is not
 *
 * Everything here. There are exactly two client boundaries and this file renders both with
 * already-formatted strings: `slot-picker.client.tsx` for the times, and `details.client.tsx` for the four
 * fields on steps 4 and 5 that HTML cannot express on its own. `book.itest.ts` reads the route's own
 * `page_client-reference-manifest.js` — what `next build` actually produced — and asserts that the
 * first-party client modules it names beyond the two the shared root layout contributes are exactly those
 * two files. That is docs/09 §3's requirement — *"the booking flow is the one heavy client island;
 * everything else is a server component"* — asserted against the build rather than against a convention,
 * with `/treatments` as the control that names none.
 *
 * Two modules rather than one is the reading of *"one island"* that costs a reader less: the picker is
 * rendered only when there are times to pick and the fields only on the steps that have them, so a single
 * module would make every reader download the other half. The claim docs/09 §3 makes is about the flow
 * being the only heavy island **on the site**, not about a file count.
 *
 * ## Steps 4 and 5 are POSTs, and they work with JavaScript off
 *
 * Each is a plain `<form method="post">` to `/api/v1/book`, which does the work and answers 303 with the
 * URL of the next state. That is what keeps B-UI-01's property intact rather than breaking it at step 4:
 * the URL is still the state, every step is still restorable, and the island still adds only affordances.
 * `app/api/v1/book/handler.ts` records why 303 and not 302.
 *
 * ## Why the first step cannot show times
 *
 * `booking.same_gender_matching` is strict (B-AVAIL-05, `Y9-gender`), so `queryAvailability` answers
 * `requires_client_gender` until the page knows who the treatment is for. A bare `/book` therefore renders
 * the day strip and a **named state** saying what is needed, and the slot list appears as soon as the
 * treatment and the client have both been stated — all of it server-rendered, with no JavaScript involved
 * at any point. Inventing an answer to make the first render show times would show times a reader may not
 * be able to book, which is the failure docs/09 §3 enumerates as *"therapist became unavailable after
 * selection"* moved one step earlier.
 *
 * ## No therapist is named
 *
 * ADR 0020: a therapist has no display name until an admin sets one and records a photography consent, and
 * none of the nineteen has either. So the therapist a reader arrived with is shown as the unnamed label
 * with its internal reference as the accessible name — the arrangement `TherapistCard` already uses, and
 * the only one that lets a screen-reader user tell two unnamed therapists apart without publishing a
 * handle as a name.
 */

import { formatAmount, grossMoneyFromFils } from '@berelax/core'
import { OTP_CODE_DIGITS } from '@berelax/db'
import { DesignSystemStyles, Grid, GridCell, Measure, Section } from '@berelax/ui/layout'
import { type BookCopy, RESEND_SECONDS_TOKEN } from '../../src/book/copy.ts'
import { type BookingPageData, stepIsPermitted, type TherapistLabel } from '../../src/book/read.ts'
import {
  BOOK_FIELDS,
  BOOK_PATH,
  type BookingParams,
  bookHref,
  groupStarts,
  tradingDateLabel,
  wallClock,
} from '../../src/book/state.ts'
import { type Locale, localisedPath } from '../../src/i18n/locales.ts'
import { RouteNav } from '../_routes/route-nav.tsx'
import { OtpField, PhoneField, ResendButton, SubmitOnce } from './details.client.tsx'
import { SlotPicker } from './slot-picker.client.tsx'
import { BookStyles } from './styles.tsx'

export interface BookingPageProps {
  readonly data: BookingPageData
  readonly params: BookingParams
  readonly copy: BookCopy
  readonly locale: Locale
}

/**
 * What a therapist is called on a public page.
 *
 * The display name when an admin has published one, and the unnamed label otherwise. Never the internal
 * reference as visible text — `packages/db/src/seed/therapists.ts` calls `staff_reference` "the internal
 * handle, never a display name", and it reaches a reader only as an accessible name.
 */
function therapistText(label: TherapistLabel | null, copy: BookCopy): string {
  if (label === null) return copy.choose.anyTherapist
  return label.displayName ?? copy.choose.unnamedTherapist
}

/** A panel with a heading: the shape every designed state on this page takes. */
function NamedState({
  heading,
  children,
  testId,
}: {
  readonly heading: string
  readonly children: React.ReactNode
  readonly testId: string
}) {
  return (
    <div className="be-book__state" data-book-state={testId}>
      <h2 className="be-book__region-heading">{heading}</h2>
      {children}
    </div>
  )
}

/** The first step: what, how long, for whom, and with whom. */
function ChooseForm({ data, params, copy, locale }: BookingPageProps) {
  const action = localisedPath(BOOK_PATH, locale)
  return (
    <form method="get" action={action} className="be-book__fields">
      {/* The day survives a change of treatment: a reader who has already picked Thursday and then
          changes the duration is still asking about Thursday. */}
      {data.selectedDate === null ? null : (
        <input type="hidden" name={BOOK_FIELDS.date} value={data.selectedDate} />
      )}
      {params.therapist === null ? null : (
        <input type="hidden" name={BOOK_FIELDS.therapist} value={params.therapist} />
      )}

      <fieldset className="be-book__fieldset">
        <legend className="be-book__legend">{copy.choose.treatmentLegend}</legend>
        <label className="be-book__note" htmlFor="book-variant">
          {copy.choose.treatmentLabel}
        </label>
        <select
          id="book-variant"
          className="be-book__select"
          name={BOOK_FIELDS.variant}
          defaultValue={data.variant?.serviceVariantId ?? ''}
        >
          <option value="">{copy.choose.treatmentPlaceholder}</option>
          {data.variants.map((variant) => (
            <option key={variant.serviceVariantId} value={variant.serviceVariantId}>
              {copy.choose.variantOption(
                variant.publicDisplayName,
                variant.durationMinutes,
                // Through the money helper, from the digits the `bigint` column was read as. A
                // `Number()` at this call site would put the rounding straight back (ADR 0007).
                formatAmount(grossMoneyFromFils(variant.grossFils)),
              )}
            </option>
          ))}
        </select>
      </fieldset>

      <fieldset className="be-book__fieldset">
        <legend className="be-book__legend">{copy.choose.genderLegend}</legend>
        <label className="be-book__note" htmlFor="book-gender">
          {copy.choose.genderLabel}
        </label>
        <select
          id="book-gender"
          className="be-book__select"
          name={BOOK_FIELDS.gender}
          defaultValue={params.gender ?? ''}
        >
          <option value="">{copy.choose.genderPlaceholder}</option>
          <option value="female">{copy.choose.female}</option>
          <option value="male">{copy.choose.male}</option>
        </select>
        {/* Never omitted. An unexplained gender question on a public booking form reads as data
            collection; this says what it is for, which is the only thing that makes it answerable. */}
        <p className="be-book__note">{copy.choose.genderNote}</p>
      </fieldset>

      <fieldset className="be-book__fieldset">
        <legend className="be-book__legend">{copy.choose.therapistLegend}</legend>
        {data.therapist === null ? (
          <p className="be-book__note">
            {data.publishable.length === 0
              ? copy.choose.noPublishedTherapists
              : copy.choose.anyTherapist}
          </p>
        ) : (
          <>
            <p className="be-book__note">
              {copy.choose.chosenTherapist(therapistText(data.therapist, copy))}
              {/* The reference as clipped text rather than as an `aria-label`. An `aria-label` REPLACES
                  an element's content in the accessibility tree, so the sentence would not be read at
                  all — and `staff_reference` is an internal handle that may be read out to tell two
                  unnamed therapists apart, never published as a display name (ADR 0020). */}
              <span className="be-book__hidden">{data.therapist.reference}</span>
            </p>
            {/* A way back out of a deep link. Without it, a reader who arrived from a therapist page
                and found the day full has no control that widens the question — and widening it is
                exactly what the no-availability state is about to suggest. */}
            <a
              className="be-action be-action--quiet"
              href={bookHref(action, {
                [BOOK_FIELDS.variant]: params.variant,
                [BOOK_FIELDS.gender]: params.gender,
                [BOOK_FIELDS.date]: data.selectedDate,
              })}
            >
              {copy.choose.clearTherapist}
            </a>
          </>
        )}
        {data.publishable.length === 0 ? null : (
          <>
            <label className="be-book__note" htmlFor="book-therapist">
              {copy.choose.therapistLegend}
            </label>
            <select
              id="book-therapist"
              className="be-book__select"
              name={BOOK_FIELDS.therapist}
              defaultValue={params.therapist ?? ''}
            >
              <option value="">{copy.choose.anyTherapist}</option>
              {data.publishable.map((therapist) => (
                <option key={therapist.therapistId} value={therapist.therapistId}>
                  {therapistText(therapist, copy)}
                </option>
              ))}
            </select>
          </>
        )}
      </fieldset>

      <p className="be-actions">
        <button className="be-action" type="submit">
          {copy.choose.submit}
        </button>
      </p>
    </form>
  )
}

/** The three regions of the no-availability state. Never an empty container; see docs/09 §3. */
function NoAvailability({ data, params, copy, locale }: BookingPageProps) {
  const none = data.none
  const day = data.selectedDate === null ? '' : tradingDateLabel(data.selectedDate, locale, 'long')
  if (none === null) return null
  const carry = (date: string) => ({
    [BOOK_FIELDS.variant]: params.variant,
    [BOOK_FIELDS.gender]: params.gender,
    [BOOK_FIELDS.therapist]: params.therapist,
    [BOOK_FIELDS.date]: date,
  })
  return (
    <NamedState heading={copy.none.heading(day)} testId="no-availability">
      <p className="be-book__note">{copy.none.lede}</p>

      <section className="be-book__region" data-book-region="nearest-days">
        <h3 className="be-book__region-heading">{copy.none.nearestHeading}</h3>
        {none.nearestDays.length === 0 ? (
          <p className="be-book__note">{copy.none.nearestEmpty}</p>
        ) : (
          <ul className="be-book__list">
            {none.nearestDays.map((nearest) => (
              <li key={nearest.tradingDate}>
                <a
                  className="be-action be-action--quiet"
                  href={bookHref(localisedPath(BOOK_PATH, locale), carry(nearest.tradingDate))}
                >
                  {copy.none.nearestDay(
                    tradingDateLabel(nearest.tradingDate, locale, 'long'),
                    nearest.slotCount,
                    wallClock(nearest.firstStartsAt),
                  )}
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="be-book__region" data-book-region="other-therapists">
        <h3 className="be-book__region-heading">{copy.none.therapistsHeading}</h3>
        {none.alternativeTherapists.length === 0 ? (
          <p className="be-book__note">{copy.none.therapistsEmpty}</p>
        ) : (
          <ul className="be-book__list">
            {none.alternativeTherapists.map((alternative) => (
              <li
                key={alternative.therapistId}
                className="be-book__row"
                data-therapist={alternative.therapistId}
              >
                {copy.none.therapistOption(
                  therapistText(alternative.label, copy),
                  alternative.slotCount,
                  wallClock(alternative.firstStartsAt),
                )}
                {/* Appended, not an `aria-label`: a label replaces the row's content, so the count and
                    the time would stop being read. Two unnamed therapists are otherwise
                    indistinguishable in a list read aloud — the same problem `TherapistCard` solves. */}
                {alternative.label === null ? null : (
                  <span className="be-book__hidden">{alternative.label.reference}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="be-book__region" data-book-region="waitlist">
        <h3 className="be-book__region-heading">{copy.none.waitlistHeading}</h3>
        {none.waitlist.eligible ? (
          <>
            <p className="be-book__note">{copy.none.waitlistLede}</p>
            <p className="be-actions">
              <a
                className="be-action"
                href={bookHref(localisedPath(BOOK_PATH, locale), {
                  ...carry(none.waitlist.tradingDate),
                  [BOOK_FIELDS.step]: 'waitlist',
                })}
              >
                {copy.none.waitlistCta}
              </a>
            </p>
          </>
        ) : (
          <p className="be-book__note">
            {/* The reason by name, carried through from the availability answer rather than collapsed
                into "you cannot join" — which is not something a reader can act on. */}
            {none.waitlist.reason === null
              ? copy.none.waitlistLede
              : copy.none.waitlistReasons[none.waitlist.reason]}
          </p>
        )}
        {none.waitlist.alreadyWaiting ? (
          <p className="be-book__note">{copy.none.waitlistAlready}</p>
        ) : null}
      </section>
    </NamedState>
  )
}

/** The telephone number, from the premises row. Never a literal: `premises.test.ts` greps for one. */
function DeskPhone({ data, copy }: { readonly data: BookingPageData; readonly copy: BookCopy }) {
  const phone = data.facts?.contact.landline ?? data.facts?.contact.mobile ?? null
  if (phone === null) return null
  return (
    <p className="be-actions">
      <a className="be-action be-action--quiet" href={`tel:${phone.e164}`}>
        {copy.chosen.callInstead(phone.display)}
      </a>
    </p>
  )
}

/** Step 3's result: what was chosen, and what has NOT happened as a consequence. */
function ChosenSlot({ data, params, copy, locale }: BookingPageProps) {
  const answer = data.answer
  if (answer === null || params.slot === null || data.selectedDate === null) return null
  const chosen = answer.slots.find((slot) => slot.startsAt === params.slot)
  if (chosen === undefined) return null
  return (
    <NamedState heading={copy.chosen.heading} testId="chosen">
      <p className="be-book__note">
        {copy.chosen.summary(
          wallClock(chosen.startsAt),
          tradingDateLabel(data.selectedDate, locale, 'long'),
          data.variant?.publicDisplayName ?? '',
        )}
      </p>
      {/* Said rather than implied: nothing is reserved by choosing a time, and the next step says what it
          does before it asks for anything. B-UI-01 left this as a named state with no control because the
          step it leads to did not exist; it exists now, and the control is a plain link because moving to
          the phone form writes nothing. */}
      <p className="be-book__note">{copy.chosen.next}</p>
      <p className="be-actions">
        <a
          className="be-action"
          data-book-continue="details"
          href={bookHref(localisedPath(BOOK_PATH, locale), {
            [BOOK_FIELDS.variant]: params.variant,
            [BOOK_FIELDS.gender]: params.gender,
            [BOOK_FIELDS.therapist]: params.therapist,
            [BOOK_FIELDS.date]: data.selectedDate,
            [BOOK_FIELDS.slot]: params.slot,
            [BOOK_FIELDS.step]: 'details',
          })}
        >
          {copy.details.submit}
        </a>
      </p>
      <DeskPhone data={data} copy={copy} />
    </NamedState>
  )
}

/**
 * The day strip: the open trading dates, as submit buttons.
 *
 * A **server component**, and that is the acceptance criterion rather than an optimisation: the initial
 * HTML for `/book` has to carry the strip, and the picker beside it cannot exist until a treatment and a
 * client have been stated (strict same-gender matching refuses before that — see the header). A strip
 * inside the island would therefore be absent from the very first render, which is the state most readers
 * arrive in.
 *
 * Its own form, with no hidden `date` field: the buttons carry `date` themselves, and a hidden one beside
 * them would arrive first and win, so choosing a day would keep the previous one. Dropping the chosen time
 * is deliberate and comes for free — a time from another day means nothing.
 */
function DayStrip({ data, params, copy, locale }: BookingPageProps) {
  if (data.days.length === 0) return null
  const carried = [
    [BOOK_FIELDS.variant, params.variant],
    [BOOK_FIELDS.gender, params.gender],
    [BOOK_FIELDS.therapist, params.therapist],
  ] as const
  return (
    <form method="get" action={localisedPath(BOOK_PATH, locale)}>
      {carried.map(([name, value]) =>
        value === null ? null : <input key={name} type="hidden" name={name} value={value} />,
      )}
      <nav aria-label={copy.picker.daysLabel}>
        <ul className="be-book__days">
          {data.days.map((day) => (
            <li key={day.tradingDate}>
              <button
                className="be-book__day"
                type="submit"
                name={BOOK_FIELDS.date}
                value={day.tradingDate}
                // `aria-current="date"` and not `aria-pressed`: the strip is a set of days of which one
                // is the one being looked at, which is what `current` means.
                aria-current={day.selected ? 'date' : undefined}
                aria-label={tradingDateLabel(day.tradingDate, locale, 'long')}
              >
                {tradingDateLabel(day.tradingDate, locale, 'short')}
              </button>
            </li>
          ))}
        </ul>
      </nav>
    </form>
  )
}

/**
 * The fields that travel with every submission the picker makes.
 *
 * Written as a loop over an explicit record rather than a filtered tuple list: the fields are
 * `string | null` and the island takes `Record<string, string>`, and a `filter` narrows the array's
 * *element* type without narrowing the record's value type — which is a type error several lines away
 * from its cause.
 */
function carriedFields(
  serviceVariantId: string,
  params: BookingParams,
): Readonly<Record<string, string>> {
  const carried: Record<string, string> = { [BOOK_FIELDS.variant]: serviceVariantId }
  if (params.gender !== null) carried[BOOK_FIELDS.gender] = params.gender
  if (params.therapist !== null) carried[BOOK_FIELDS.therapist] = params.therapist
  return carried
}

/** The picker, or the named state that says what is missing before it can exist. */
function Availability(props: BookingPageProps) {
  const { data, params, copy, locale } = props
  if (!data.reachable || data.selectedDate === null) {
    return (
      <NamedState heading={copy.title} testId="no-trading-days">
        <p className="be-book__note">{copy.needs.noTradingDays}</p>
        <DeskPhone data={data} copy={copy} />
      </NamedState>
    )
  }
  if (data.variants.length === 0) {
    return (
      <NamedState heading={copy.title} testId="no-treatments">
        <p className="be-book__note">{copy.needs.noTreatments}</p>
        <DeskPhone data={data} copy={copy} />
      </NamedState>
    )
  }
  if (data.variant === null) {
    return (
      <NamedState heading={copy.choose.treatmentLegend} testId="needs-treatment">
        <p className="be-book__note">{copy.needs.treatment}</p>
      </NamedState>
    )
  }
  if (params.gender === null && data.strictGenderMatching) {
    return (
      <NamedState heading={copy.choose.genderLegend} testId="needs-gender">
        <p className="be-book__note">{copy.needs.gender}</p>
      </NamedState>
    )
  }
  if (data.answer === null || data.answer.slots.length === 0) {
    return data.none === null ? (
      <NamedState heading={copy.title} testId="no-trading-days">
        <p className="be-book__note">{copy.needs.noTradingDays}</p>
        <DeskPhone data={data} copy={copy} />
      </NamedState>
    ) : (
      <NoAvailability {...props} />
    )
  }

  const dayLong = tradingDateLabel(data.selectedDate, locale, 'long')
  const sections = groupStarts(data.answer.slots.map((slot) => slot.startsAt))
  const minutes = data.variant.durationMinutes
  return (
    <SlotPicker
      action={localisedPath(BOOK_PATH, locale)}
      carried={carriedFields(data.variant.serviceVariantId, params)}
      fields={{ date: BOOK_FIELDS.date, slot: BOOK_FIELDS.slot }}
      selectedDate={data.selectedDate}
      groups={sections.map((section) => ({
        group: section.group,
        heading: copy.picker.groups[section.group],
        ariaLabel: copy.picker.groupLabel(copy.picker.groups[section.group], dayLong),
        slots: section.starts.map((start) => ({
          startsAt: start.startsAt,
          label: start.label,
          ariaLabel: copy.picker.slotLabel(start.label, dayLong, minutes),
          selected: params.slot === start.startsAt,
        })),
      }))}
      copy={{
        heading: copy.picker.heading(dayLong),
        count: copy.picker.count(data.answer.slots.length),
        timesLabel: copy.picker.timesLabel(dayLong),
        announceDay: copy.picker.announceDay(dayLong),
      }}
    />
  )
}

// ── Steps 4 and 5 (B-UI-02) ────────────────────────────────────────────────────────────────────────

/**
 * The fields that travel with a POST.
 *
 * The same six the GET forms carry, plus the locale — because the endpoint is outside both locale groups
 * (one endpoint, one URL) and the 303's `Location` has to be built in the document's own language. A
 * hidden field rather than a `Referer` read: a referrer is optional, strippable and wrong behind some
 * proxies, and the consequence of guessing would be an Arabic reader landed on the English page.
 */
function CarriedInputs({
  data,
  params,
  locale,
  after,
}: BookingPageProps & { readonly after?: 'confirm' | 'waitlist' }) {
  const carried: Readonly<Record<string, string | null>> = {
    [BOOK_FIELDS.variant]: params.variant,
    [BOOK_FIELDS.date]: data.selectedDate,
    [BOOK_FIELDS.therapist]: params.therapist,
    [BOOK_FIELDS.gender]: params.gender,
    [BOOK_FIELDS.slot]: params.slot === null ? null : String(params.slot),
    // The override is how the waitlist path says where verification leads. One field, set once, rather
    // than a second hidden input beside it: `form.get` returns the FIRST value, so two would be decided
    // by DOM order — which is exactly the defect `parseBookingParams`' `first()` helper documents.
    [BOOK_FIELDS.after]: after ?? params.after,
    locale,
  }
  return (
    <>
      {Object.entries(carried).map(([name, value]) =>
        value === null ? null : <input key={name} type="hidden" name={name} value={value} />,
      )}
    </>
  )
}

/** Where the flow's POSTs go. One endpoint; see `app/api/v1/book/route.ts`. */
const FLOW_ACTION = '/api/v1/book'

/** The refusal the last submission carried back, as a sentence. Absent when there was none. */
function FlowError({ params, copy }: BookingPageProps) {
  if (params.error === null) return null
  return (
    <p className="be-book__error" role="alert" data-book-error={params.error}>
      {copy.flowErrors[params.error]}
    </p>
  )
}

/**
 * One of docs/09 §3's nine enumerated edge states, as a designed panel.
 *
 * The state is decided in `@berelax/core` (`decideBookingEdgeState`) and the words and the control are the
 * locale's. `action` is `null` for the two states whose only honest answer is *nothing to do* — a booking
 * that already exists — and a "try again" button there would be an invitation to take a second slot.
 */
function EdgeState(props: BookingPageProps) {
  const { data, copy } = props
  if (data.edge === null) return null
  const words = copy.edge[data.edge]
  return (
    <div className="be-book__state be-book__state--edge" data-book-edge={data.edge}>
      <h2 className="be-book__region-heading">{words.heading}</h2>
      <p className="be-book__note">{words.body}</p>
      {words.action === null ? null : <EdgeAction {...props} label={words.action} />}
      <DeskPhone data={data} copy={copy} />
    </div>
  )
}

/**
 * The control an edge state offers, which differs per state because the remedies differ.
 *
 * This is the whole point of the nine being NAMED rather than collapsed into one "that did not work"
 * panel: `therapist_became_unavailable` sends the reader to the same time with the therapist filter
 * dropped, `session_expired` sends them back to the phone step with their slot intact, and
 * `network_drop` sends them to a check that writes nothing. A single "start again" link would be correct
 * for none of them.
 */
function EdgeAction({ data, params, locale, label }: BookingPageProps & { label: string }) {
  const path = localisedPath(BOOK_PATH, locale)
  const carry = {
    [BOOK_FIELDS.variant]: params.variant,
    [BOOK_FIELDS.gender]: params.gender,
    [BOOK_FIELDS.date]: data.selectedDate,
  }
  const href = (() => {
    switch (data.edge) {
      case 'therapist_became_unavailable':
        // The same day and the same time, with the therapist dropped. Keeping the slot is the point: the
        // page then either offers it with somebody else or says it has gone, which is the next question.
        return bookHref(path, { ...carry, [BOOK_FIELDS.slot]: params.slot })
      case 'session_expired':
        return bookHref(path, {
          ...carry,
          [BOOK_FIELDS.therapist]: params.therapist,
          [BOOK_FIELDS.slot]: params.slot,
          [BOOK_FIELDS.step]: 'details',
        })
      case 'network_drop':
        // A GET, and deliberately: checking must write nothing. The confirm step re-reads the session's
        // own booking, so a submission that did commit is reported and one that did not is offered again
        // under the same idempotency key.
        return bookHref(path, {
          ...carry,
          [BOOK_FIELDS.therapist]: params.therapist,
          [BOOK_FIELDS.slot]: params.slot,
          [BOOK_FIELDS.step]: 'confirm',
        })
      case 'otp_not_arrived':
        return bookHref(path, {
          ...carry,
          [BOOK_FIELDS.therapist]: params.therapist,
          [BOOK_FIELDS.slot]: params.slot,
          [BOOK_FIELDS.step]: 'details',
        })
      default:
        // `slot_taken`, `required_room_taken` and `duration_no_longer_fits` all mean "choose again on this
        // day", and the chosen time is dropped because it is the thing that is gone.
        return bookHref(path, { ...carry, [BOOK_FIELDS.therapist]: params.therapist })
    }
  })()
  return (
    <p className="be-actions">
      <a className="be-action" href={href} data-book-edge-action={data.edge}>
        {label}
      </a>
    </p>
  )
}

/**
 * What a reader with JavaScript switched off is told.
 *
 * Not an apology for a blank screen: every step here is a POST the server answers, so the flow works.
 * docs/09 §3 asks for a visible path when something does not arrive, and this is that path for a browser
 * that will not run the cooldown timer — plus the desk number, which is the fallback the acceptance line
 * asks for by name.
 */
function NoScriptNote({ data, copy }: BookingPageProps) {
  return (
    <noscript>
      <div className="be-book__state" data-book-state="no-javascript">
        <h2 className="be-book__region-heading">{copy.noJs.heading}</h2>
        <p className="be-book__note">{copy.noJs.body}</p>
        <DeskPhone data={data} copy={copy} />
      </div>
    </noscript>
  )
}

/**
 * Step 4a: the number.
 *
 * `testId`, `heading`, `lede` and `after` are props because this step serves two destinations. A reader on
 * their way to a booking and one on their way to the waiting list need the identical form and different
 * words, and the alternative — a second component — would be a second place the phone field, the
 * explanation and the carried fields could drift. The waitlist path keeps B-UI-01's
 * `data-book-state="waitlist-step"` marker, which is what that unit's test follows its CTA to.
 */
function DetailsStep(
  props: BookingPageProps & {
    readonly testId?: string
    readonly heading?: string
    readonly lede?: string
    readonly after?: 'confirm' | 'waitlist'
  },
) {
  const { data, params, copy, locale, testId, heading, lede, after } = props
  const dial = data.facts?.contact.landline?.e164.slice(0, 4) ?? '+971'
  return (
    <div className="be-book__state" data-book-state={testId ?? 'details'}>
      <h2 className="be-book__region-heading">{heading ?? copy.details.heading}</h2>
      <p className="be-book__note">{lede ?? copy.details.lede}</p>
      <FlowError {...props} />
      <form method="post" action={FLOW_ACTION} className="be-book__fields">
        <CarriedInputs {...props} {...(after === undefined ? {} : { after })} />
        <fieldset className="be-book__fieldset">
          <legend className="be-book__legend">{copy.details.heading}</legend>
          <PhoneField
            id="book-phone"
            name="phone"
            label={copy.details.phoneLabel}
            hint={copy.details.phoneHint}
            defaultValue={data.session.kind === 'unknown' ? '' : data.session.session.phoneE164}
            dialCode={dial}
            countryLabel={copy.details.countryLabel}
          />
        </fieldset>
        {/* Said before the number is asked for rather than after it is given. An unexplained phone field
            on a public form reads as data collection, which is the same argument the gender note makes. */}
        <p className="be-book__note">{copy.details.why}</p>
        <p className="be-actions">
          <SubmitOnce
            action="send_code"
            label={copy.details.submit}
            busyLabel={copy.details.submit}
          />
        </p>
      </form>
      <p className="be-actions">
        <a
          className="be-action be-action--quiet"
          href={bookHref(localisedPath(BOOK_PATH, locale), {
            [BOOK_FIELDS.variant]: params.variant,
            [BOOK_FIELDS.gender]: params.gender,
            [BOOK_FIELDS.therapist]: params.therapist,
            [BOOK_FIELDS.date]: data.selectedDate,
            [BOOK_FIELDS.slot]: params.slot,
          })}
        >
          {copy.details.back}
        </a>
      </p>
      <DeskPhone data={data} copy={copy} />
      <NoScriptNote {...props} />
    </div>
  )
}

/** Step 4b: the code, its cooldown, and the way out when it does not arrive. */
function OtpStep(props: BookingPageProps) {
  const { data, params, copy, locale } = props
  const phone = data.session.kind === 'unknown' ? '' : data.session.session.phoneE164
  return (
    <div className="be-book__state" data-book-state="otp">
      <h2 className="be-book__region-heading">{copy.otp.heading}</h2>
      {/* `<bdi>` around the number: an E.164 value is a Latin run inside an Arabic sentence, and without
          isolation the `+` migrates to the wrong end of it (ADR 0011). */}
      <p className="be-book__note">
        {copy.otp.lede('')}
        <bdi>{phone}</bdi>
      </p>
      <FlowError {...props} />
      <form method="post" action={FLOW_ACTION} className="be-book__fields">
        <CarriedInputs {...props} />
        <fieldset className="be-book__fieldset">
          <legend className="be-book__legend">{copy.otp.codeLabel}</legend>
          <OtpField
            id="book-code"
            name="code"
            label={copy.otp.codeLabel}
            hint={copy.otp.codeHint(OTP_CODE_DIGITS)}
            digits={OTP_CODE_DIGITS}
          />
        </fieldset>
        <p className="be-actions">
          <SubmitOnce action="verify_code" label={copy.otp.submit} busyLabel={copy.otp.submit} />
          {/* The resend is a submit button in the SAME form, so it carries the same hidden fields. Its
              own `name="action"` wins over the other button's, which is how one form serves two actions
              without JavaScript. */}
          <ResendButton
            label={copy.otp.resend}
            waiting={{
              one: copy.otp.resendIn('1'),
              many: copy.otp.resendIn(RESEND_SECONDS_TOKEN),
            }}
            initialSeconds={data.resendInSeconds}
          />
        </p>
      </form>
      <p className="be-actions">
        {/* docs/09 §3: "a visible path when the message does not arrive". A link and not a button,
            because it changes nothing — it puts the reader in the named state that offers the three
            things that help. */}
        <a
          className="be-action be-action--quiet"
          href={bookHref(localisedPath(BOOK_PATH, locale), {
            [BOOK_FIELDS.variant]: params.variant,
            [BOOK_FIELDS.gender]: params.gender,
            [BOOK_FIELDS.therapist]: params.therapist,
            [BOOK_FIELDS.date]: data.selectedDate,
            [BOOK_FIELDS.slot]: params.slot,
            [BOOK_FIELDS.after]: params.after,
            [BOOK_FIELDS.step]: 'otp',
            [BOOK_FIELDS.issue]: 'code_not_received',
          })}
          data-book-issue-link="code_not_received"
        >
          {copy.otp.notArrived}
        </a>
        {/* A separate way out for the reader who mistyped a digit rather than missed a message: the code
            will never arrive for the wrong number, and resending it four times is what happens without
            this control. */}
        <a
          className="be-action be-action--quiet"
          href={bookHref(localisedPath(BOOK_PATH, locale), {
            [BOOK_FIELDS.variant]: params.variant,
            [BOOK_FIELDS.gender]: params.gender,
            [BOOK_FIELDS.therapist]: params.therapist,
            [BOOK_FIELDS.date]: data.selectedDate,
            [BOOK_FIELDS.slot]: params.slot,
            [BOOK_FIELDS.after]: params.after,
            [BOOK_FIELDS.step]: 'details',
          })}
          data-book-change-number="true"
        >
          {copy.otp.changeNumber}
        </a>
      </p>
      <NoScriptNote {...props} />
    </div>
  )
}

/** The consent questions, one per send-gating purpose that has a published wording. */
function ConsentFieldset({ data, copy, locale }: BookingPageProps) {
  if (data.consentOffers.length === 0) {
    return (
      <fieldset className="be-book__fieldset" data-book-consent="unavailable">
        <legend className="be-book__legend">{copy.confirm.consentHeading}</legend>
        <p className="be-book__note">{copy.confirm.consentUnavailable}</p>
      </fieldset>
    )
  }
  return (
    <fieldset className="be-book__fieldset" data-book-consent="offered">
      <legend className="be-book__legend">{copy.confirm.consentHeading}</legend>
      <p className="be-book__note">{copy.confirm.consentLede}</p>
      {data.consentOffers.map((offer) => (
        <div key={offer.purpose} className="be-book__consent" data-consent-purpose={offer.purpose}>
          {/* The purpose, the version and the hash travel with the submission. The hash is what makes the
              record a claim about the words THIS reader saw: `recordConsent` refuses it when it does not
              match the stored version, so a wording published between this render and the submit is a
              named refusal rather than a silent substitution. */}
          <input type="hidden" name="consent_purpose" value={offer.purpose} />
          <input type="hidden" name={`consent_wording_${offer.purpose}`} value={offer.wordingId} />
          <input
            type="hidden"
            name={`consent_hash_${offer.purpose}`}
            value={offer.wordingHashHex}
          />
          <label className="be-book__check" htmlFor={`consent-${offer.purpose}`}>
            {/* Unchecked, and there is no `defaultChecked` anywhere near this element. A pre-ticked
                marketing box is not an opt-in under TDRA (docs/04 §5) and the record would say it was. */}
            <input
              id={`consent-${offer.purpose}`}
              className="be-book__checkbox"
              type="checkbox"
              name={`consent_grant_${offer.purpose}`}
            />
            <span>{locale === 'ar' ? offer.textAr : offer.textEn}</span>
          </label>
          <p className="be-book__note">
            {copy.confirm.consentVersion(offer.purpose, offer.version)}
          </p>
        </div>
      ))}
    </fieldset>
  )
}

/** Step 5: what is about to be booked, the consent question, and one button. */
function ConfirmStep(props: BookingPageProps) {
  const { data, params, copy, locale } = props
  const chosen = data.chosen
  const day = data.selectedDate === null ? '' : tradingDateLabel(data.selectedDate, locale, 'long')
  return (
    <div className="be-book__state" data-book-state="confirm">
      <h2 className="be-book__region-heading">{copy.confirm.heading}</h2>
      <FlowError {...props} />
      {chosen === null || data.variant === null ? (
        <p className="be-book__note">{copy.needs.treatment}</p>
      ) : (
        <>
          <p className="be-book__note">
            {copy.confirm.summary(
              wallClock(chosen.startsAt),
              day,
              data.variant.publicDisplayName,
              data.variant.durationMinutes,
            )}
          </p>
          <p className="be-book__note">
            {copy.confirm.priceLine(formatAmount(grossMoneyFromFils(data.variant.grossFils)))}
          </p>
          <p className="be-book__note">
            {copy.confirm.phoneLine('')}
            <bdi>{data.session.kind === 'unknown' ? '' : data.session.session.phoneE164}</bdi>
          </p>
          <form method="post" action={FLOW_ACTION} className="be-book__fields">
            <CarriedInputs {...props} />
            <ConsentFieldset {...props} />
            <p className="be-actions">
              <SubmitOnce
                action="confirm"
                label={copy.confirm.submit}
                busyLabel={copy.confirm.submit}
              />
            </p>
          </form>
        </>
      )}
      <p className="be-actions">
        <a
          className="be-action be-action--quiet"
          href={bookHref(localisedPath(BOOK_PATH, locale), {
            [BOOK_FIELDS.variant]: params.variant,
            [BOOK_FIELDS.gender]: params.gender,
            [BOOK_FIELDS.therapist]: params.therapist,
            [BOOK_FIELDS.date]: data.selectedDate,
          })}
        >
          {copy.confirm.back}
        </a>
        {/* The recovery for a submission whose outcome the browser never learned, and it is on the page
            rather than only inside the `network_drop` panel — a reader whose connection dropped may never
            have received that page at all. A GET, so checking writes nothing; the confirm step re-reads
            this session's own booking and reports it if the submission did commit. */}
        <a
          className="be-action be-action--quiet"
          href={bookHref(localisedPath(BOOK_PATH, locale), {
            [BOOK_FIELDS.variant]: params.variant,
            [BOOK_FIELDS.gender]: params.gender,
            [BOOK_FIELDS.therapist]: params.therapist,
            [BOOK_FIELDS.date]: data.selectedDate,
            [BOOK_FIELDS.slot]: params.slot,
            [BOOK_FIELDS.step]: 'confirm',
            [BOOK_FIELDS.issue]: 'interrupted',
          })}
          data-book-issue-link="interrupted"
        >
          {copy.confirm.checkInstead}
        </a>
      </p>
      <NoScriptNote {...props} />
    </div>
  )
}

/** The confirmation: what was booked, the calendar file, and how a change is made today. */
function BookedStep(props: BookingPageProps) {
  const { data, params, copy, locale } = props
  const first = data.booking[0]
  if (first === undefined) {
    // The booking id in the URL is not this session's — or there is none. The same answer either way,
    // because distinguishing them tells a caller whether a guessed uuid exists.
    return (
      <div className="be-book__state" data-book-state="no-booking">
        <h2 className="be-book__region-heading">{copy.booked.heading}</h2>
        <p className="be-book__note">{copy.booked.manageLede}</p>
        <DeskPhone data={data} copy={copy} />
      </div>
    )
  }
  return (
    <div className="be-book__state" data-book-state="booked">
      <h2 className="be-book__region-heading">{copy.booked.heading}</h2>
      <p className="be-book__note">{copy.booked.lede}</p>
      <p className="be-book__note" data-booking-reference={first.bookingId}>
        {copy.booked.reference('')}
        <bdi>{first.bookingId}</bdi>
      </p>
      <p className="be-book__note">
        {copy.booked.summary(
          wallClock(first.startsAt),
          tradingDateLabel(first.tradingDate, locale, 'long'),
        )}
      </p>
      <p className="be-actions">
        {/* A plain GET with `download`. The endpoint authorises it against the session's own customer id
            in SQL, so a booking id in the query string is not permission to download somebody's
            appointment. */}
        <a
          className="be-action"
          href={`${FLOW_ACTION}?ics=${first.bookingId}`}
          download={`berelax-${first.bookingId}.ics`}
          data-book-ics={first.bookingId}
        >
          {copy.booked.addToCalendar}
        </a>
      </p>
      {/* Said rather than left to look like a bug. docs/06 D2: the entry carries the time and the place,
          because a calendar line is read by whoever is holding the phone and it persists. */}
      <p className="be-book__note">{copy.booked.calendarNote}</p>

      <section className="be-book__region" data-book-region="manage">
        <h3 className="be-book__region-heading">{copy.booked.manageHeading}</h3>
        {/* Where the magic link goes once B-UI-05 mints one. A named state and the desk number rather
            than a link to a page that does not exist: a link to a 404 in a confirmation is a customer who
            thinks the salon has lost their booking, which is the reason B-MSG-03 ships a reminder that
            skips rather than one that carries an invented URL. */}
        <p className="be-book__note">{copy.booked.manageLede}</p>
        <DeskPhone data={data} copy={copy} />
      </section>

      <p className="be-actions">
        <a
          className="be-action be-action--quiet"
          href={bookHref(localisedPath(BOOK_PATH, locale), {
            [BOOK_FIELDS.variant]: params.variant,
            [BOOK_FIELDS.gender]: params.gender,
          })}
        >
          {copy.booked.bookAnother}
        </a>
      </p>
    </div>
  )
}

/** The waitlist join, once a phone is verified. */
function WaitlistJoinStep(props: BookingPageProps) {
  const { data, params, copy, locale } = props
  const day = data.selectedDate === null ? '' : tradingDateLabel(data.selectedDate, locale, 'long')
  return (
    <div className="be-book__state" data-book-state="waitlist-join">
      <h2 className="be-book__region-heading">{copy.waitlistJoin.heading}</h2>
      <p className="be-book__note">{copy.waitlistJoin.lede(day)}</p>
      <FlowError {...props} />
      <form method="post" action={FLOW_ACTION} className="be-book__fields">
        <CarriedInputs {...props} />
        <p className="be-actions">
          <SubmitOnce
            action="join_waitlist"
            label={copy.waitlistJoin.submit}
            busyLabel={copy.waitlistJoin.submit}
          />
        </p>
      </form>
      <p className="be-actions">
        <a
          className="be-action be-action--quiet"
          href={bookHref(localisedPath(BOOK_PATH, locale), {
            [BOOK_FIELDS.variant]: params.variant,
            [BOOK_FIELDS.gender]: params.gender,
            [BOOK_FIELDS.therapist]: params.therapist,
            [BOOK_FIELDS.date]: data.selectedDate,
          })}
        >
          {copy.waitlistJoin.back}
        </a>
      </p>
      <NoScriptNote {...props} />
    </div>
  )
}

/** The waitlist confirmation. */
function WaitlistedStep({ data, params, copy, locale }: BookingPageProps) {
  const day = data.selectedDate === null ? '' : tradingDateLabel(data.selectedDate, locale, 'long')
  return (
    <div className="be-book__state" data-book-state="waitlisted">
      <h2 className="be-book__region-heading">{copy.waitlisted.heading}</h2>
      <p className="be-book__note">{copy.waitlisted.lede(day)}</p>
      <p className="be-actions">
        <a
          className="be-action be-action--quiet"
          href={bookHref(localisedPath(BOOK_PATH, locale), {
            [BOOK_FIELDS.variant]: params.variant,
            [BOOK_FIELDS.gender]: params.gender,
            [BOOK_FIELDS.therapist]: params.therapist,
            [BOOK_FIELDS.date]: data.selectedDate,
          })}
        >
          {copy.waitlisted.back}
        </a>
      </p>
    </div>
  )
}

/**
 * The step the URL asks for, or the one it is allowed to have.
 *
 * A step on `VERIFIED_STEPS` with no verified session renders the **phone step** rather than an error, and
 * `after` carries where the reader was going. That is the useful answer to a bookmarked `?step=confirm`
 * from yesterday: the URL still means "I want to book this", and the one thing missing is a number.
 */
function FlowStep(props: BookingPageProps) {
  const { data, params, copy } = props
  if (!stepIsPermitted(data, params.step)) {
    // The waitlist keeps its own heading and its own marker, because the reader asked for the waiting
    // list and not for a booking — and because B-UI-01's test follows that CTA to this state by name.
    return params.step === 'waitlist' ? (
      <DetailsStep
        {...props}
        testId="waitlist-step"
        heading={copy.waitlistStep.heading}
        lede={copy.waitlistStep.lede}
        after="waitlist"
      />
    ) : (
      <DetailsStep {...props} />
    )
  }
  switch (params.step) {
    case 'details':
      return <DetailsStep {...props} />
    // A code cannot be typed for a number nobody has submitted, so a bare `?step=otp` is the phone form.
    case 'otp':
      return data.session.kind === 'live' ? <OtpStep {...props} /> : <DetailsStep {...props} />
    case 'confirm':
      return <ConfirmStep {...props} />
    case 'booked':
      return <BookedStep {...props} />
    case 'waitlist':
      return <WaitlistJoinStep {...props} />
    case 'waitlisted':
      return <WaitlistedStep {...props} />
    default:
      return null
  }
}

export function BookingPageBody(props: BookingPageProps) {
  const { copy, locale, params } = props
  return (
    <main>
      <DesignSystemStyles />
      <BookStyles />

      {/*
        `RouteNav` and not `Breadcrumb`, and the reason is a rule this page is audited against and the
        others are not. Every control on `/book` has to clear 48x48px at 390px; the breadcrumb's steps
        are bare anchors inside `.be-actions`, so their boxes are a line box high. `RouteNav`'s links
        carry `.be-action`, which states the floor. Giving the breadcrumb that class would change five
        pages and their screenshots, which is not this unit's to do.
      */}
      <RouteNav id="book" locale={locale} />

      <Section as="header">
        <Grid>
          <GridCell span="wide">
            <Measure cap="h1" as="h1" className="text-3xl">
              {copy.title}
            </Measure>
            <Measure cap="lede">{copy.lede}</Measure>
          </GridCell>
        </Grid>
      </Section>

      <Section>
        <Grid>
          <GridCell span="wide">
            {/* `.be-book` carries the containment and `.be-book__flow` responds to it — see
                `styles.tsx`, where the reason is that a container query cannot ask about the element it
                is applied to, and the whole slot-grid column count depends on which of the two it is. */}
            <div className="be-book" data-book-flow="true">
              <div className="be-book__flow">
                <ChooseForm {...props} />
                <div className="be-book__column">
                  {/* Always, and above everything else in the column: the strip is the one part of the
                      flow that is readable before any question has been answered. */}
                  <DayStrip {...props} />
                  {/* The edge state ABOVE the step, always, and never instead of it. A panel that
                      replaced the step would leave a reader who has been told their session expired with
                      no field to do anything about it — and `decideBookingEdgeState` deliberately reports
                      `double_submission` and `back_after_confirm` as good news, which belongs beside the
                      confirmation rather than in place of it. */}
                  <EdgeState {...props} />
                  {params.step === 'choose' ? (
                    <>
                      <Availability {...props} />
                      <ChosenSlot {...props} />
                    </>
                  ) : (
                    <FlowStep {...props} />
                  )}
                </div>
              </div>
            </div>
          </GridCell>
        </Grid>
      </Section>
    </main>
  )
}
