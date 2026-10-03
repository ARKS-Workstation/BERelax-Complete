/**
 * The decisions the two therapist pages make, separated from the components that render them.
 *
 * A `.ts` module rather than part of `app/_therapists/pages.tsx` for the reason `src/routes/nav.ts` gives:
 * `apps/web/tsconfig.json` sets `jsx: "preserve"`, so vitest cannot parse a `.tsx` from this application
 * and a unit test cannot import one. Everything that has to be PROVEN lives here — and on these two pages
 * what has to be proven is which cards carry an anchor and which must not.
 */
import { isTherapistPublishable, type TherapistDisposition } from '@berelax/core'
import { type TherapistPageRow, therapistPathFor } from '@berelax/db'
import { BOOK_FIELDS, BOOK_PATH, bookHref } from '../book/state.ts'
import { type Locale, localisedPath } from '../i18n/locales.ts'
import { candidateFor, dispositionOf } from './read.ts'

/** The path of the therapist index in one locale. `localisedPath` is the one place a locale becomes a URL. */
export const therapistsIndexPath = (locale: Locale): string => localisedPath('/therapists', locale)

/** The path of one therapist page in one locale. */
export const therapistPath = (locale: Locale, slug: string): string =>
  localisedPath(therapistPathFor(slug), locale)

/**
 * One card on the index, and the two things that have to be absent from eighteen of nineteen of them.
 *
 * `displayName` and `href` are both `undefined` unless the row passes the guard, and both are `undefined`
 * rather than empty strings so the component's optional props express the absence — `exactOptionalPropertyTypes`
 * is on, so `{ href: undefined }` does not satisfy `href?: string`, which is exactly the distinction this
 * card turns on. A falsy-but-present `href` renders an anchor with no destination, and
 * `TherapistCardProps.href` records why that is worse than no anchor at all.
 */
export interface TherapistIndexCard {
  readonly reference: string
  readonly displayName?: string
  readonly href?: string
  readonly qualifications?: string
}

/**
 * One card per row, in roster order, with the guard applied on the surface that has to honour it.
 *
 * A **retired** therapist gets no card at all, and that is the one case worth stating: their page still
 * answers (a 301 to this index), because the URL has inbound links and rankings — but a card for somebody
 * who no longer works here would be an offer to book them. docs/09 §2 separates the two in so many words:
 * the page survives, *"their bookable availability disappears"*.
 */
export function therapistIndexCards(
  rows: readonly TherapistPageRow[],
  locale: Locale,
  qualificationLabel: (skills: readonly string[]) => string | undefined,
): readonly TherapistIndexCard[] {
  const cards: TherapistIndexCard[] = []
  for (const row of rows) {
    const disposition: TherapistDisposition = dispositionOf(row)
    if (disposition.kind === 'retired') continue
    const label = qualificationLabel(row.skills)
    const publishable = disposition.kind === 'published'
    cards.push({
      reference: row.staffReference,
      ...(publishable && row.displayName !== null ? { displayName: row.displayName } : {}),
      ...(publishable && row.publicSlug !== null
        ? { href: therapistPath(locale, row.publicSlug) }
        : {}),
      ...(label === undefined ? {} : { qualifications: label }),
    })
  }
  return cards
}

/**
 * The "Book with [name]" action, or null.
 *
 * `/book?therapist=<id>` — the employee id, which is what the booking flow filters the solver on. Null for
 * a therapist who may not be published, and the null is the whole point: an action naming somebody the
 * site may not name is an action that names them. `therapists.itest.ts` asserts no "Book with" action
 * exists anywhere for an unpublishable or a retired therapist.
 */
export function bookWithHref(row: TherapistPageRow, locale: Locale): string | null {
  if (!isTherapistPublishable(candidateFor(row))) return null
  return bookHref(localisedPath(BOOK_PATH, locale), { [BOOK_FIELDS.therapist]: row.id })
}

/**
 * The skills of one therapist as a phrase, or undefined when there are none.
 *
 * The labels are the caller's, because they are translated copy and copy belongs to the route. Sorted by
 * the row order the read already imposed, so two cards with the same pair of skills read identically.
 */
export function qualificationPhrase(
  skills: readonly string[],
  labels: Readonly<Record<string, string>>,
  join: string,
): string | undefined {
  const named = skills.flatMap((skill) => {
    const label = labels[skill]
    // A skill with no label is dropped rather than printed raw: `asian_style` is a database enum, and
    // publishing it would put a column value on a public page in whichever language the enum happens to
    // be in. `therapists/content.test.ts` asserts the labels are total over the enum.
    return label === undefined ? [] : [label]
  })
  return named.length === 0 ? undefined : named.join(join)
}
