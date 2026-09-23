/**
 * `/book` — the body, rendered once and served in two locales.
 *
 * Two route files and one component, exactly as `app/_content/pages.tsx` is ten and five: the structure
 * of a page is one thing and the language of it is another, and two copies would be two places the layout
 * could drift — with the RTL half of every assertion then testing a different component from the LTR half.
 *
 * ## What is a server component and what is not
 *
 * Everything here. The single client boundary is `slot-picker.client.tsx`, which this file renders with
 * already-formatted strings. `book.itest.ts` reads the route's own
 * `page_client-reference-manifest.js` — what `next build` actually produced — and asserts that the only
 * first-party client module it names beyond the two the shared root layout contributes is that one file.
 * That is docs/09 §3's requirement — *"the booking flow is the one heavy client island; everything else is
 * a server component"* — asserted against the build rather than against a convention, with `/treatments`
 * as the control that names none.
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
import { DesignSystemStyles, Grid, GridCell, Measure, Section } from '@berelax/ui/layout'
import type { BookCopy } from '../../src/book/copy.ts'
import type { BookingPageData, TherapistLabel } from '../../src/book/read.ts'
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
      {/* Said rather than implied. A "Continue" button that goes nowhere is the thing docs/09 §3 calls
          an edge state handled by a phone call to the front desk. */}
      <p className="be-book__note">{copy.chosen.next}</p>
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

/** The waitlist step: named, explained, and honest about what it does not do yet. */
function WaitlistStep({ data, params, copy, locale }: BookingPageProps) {
  return (
    <NamedState heading={copy.waitlistStep.heading} testId="waitlist-step">
      <p className="be-book__note">{copy.waitlistStep.lede}</p>
      <DeskPhone data={data} copy={copy} />
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
          {copy.waitlistStep.back}
        </a>
      </p>
    </NamedState>
  )
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
                  {params.step === 'waitlist' ? (
                    <WaitlistStep {...props} />
                  ) : (
                    <>
                      <Availability {...props} />
                      <ChosenSlot {...props} />
                    </>
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
