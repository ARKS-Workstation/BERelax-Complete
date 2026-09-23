/**
 * What the home page is made of, as data. Pure, and deliberately not JSX.
 *
 * The same split `src/treatments/content.ts` and `src/cms/content.ts` make, for the same mechanical reason
 * — `apps/web/tsconfig.json` sets `jsx: "preserve"`, so vitest cannot parse a `.tsx` from this application
 * and a unit test cannot import one — plus one that is this unit's own: **three of this unit's acceptance
 * criteria are decidable without a browser**, and each of them is a decision about a value rather than
 * about a rendered pixel:
 *
 *   1. the section order and the anchor ids (`HOME_SECTIONS`);
 *   2. which cards carry a link and which must not (`therapistCardFor`, `treatmentCardFor`);
 *   3. that no testimonial reaches a page without a review record behind it (`reviewSection`).
 *
 * The browser half — the LCP element, first paint, the 2px anchor landing, the sticky bar's geometry and
 * the five byte-and-count budgets — is `apps/web/src/home.itest.ts`, which cannot be decided any other way.
 *
 * ## Why the anchors are a frozen list and not six strings at the call site
 *
 * docs/09 §"Routes versus anchors" is the whole argument for this page: the prototype is one document with
 * anchors, that cannot rank, and the evolution keeps *the anchored feel* while every card links out to a
 * real indexable route. The anchors are therefore part of the contract — `/#services` is a URL somebody has
 * bookmarked and a GBP link may point at — so the six ids live here once, in the prototype's order, and the
 * page renders them by mapping this list. A page that spelled `id="services"` in its JSX could drop one,
 * reorder two, or rename a third without failing anything.
 *
 * docs/13 §6 records seven anchors on the prototype, including `#video`. It is absent here on purpose and
 * the reason is not an oversight: the prototype's `#video` pointed at an embed on somebody else's platform,
 * which is not an asset this business owns (`apps/web/src/seo/graph-input.ts` records the same finding for
 * `VideoObject`), and this unit's acceptance names six. The hero *is* the video surface on this page, and it
 * is above every anchor rather than behind one.
 */
import type { Facts } from '@berelax/shared'

/**
 * The six anchor targets, in the prototype's order.
 *
 * `as const` so the ids are literal types: {@link HomeCopy}'s `sections` is a `Record` over them, which is
 * what makes a seventh section fail to compile in both locales at once rather than render an untranslated
 * heading in one of them.
 */
export const HOME_SECTIONS = ['about', 'services', 'team', 'gallery', 'reviews', 'contact'] as const

export type HomeSectionId = (typeof HOME_SECTIONS)[number]

/**
 * The fragment a link to one section carries.
 *
 * A function rather than string concatenation at the call sites, because the in-page navigation, the
 * section element and the test all have to agree on it, and `#` is easy to leave off exactly once.
 */
export function homeAnchor(id: HomeSectionId): string {
  return `#${id}`
}

/** One card in the treatments overview: a real link to a real indexable route. */
export interface TreatmentCard {
  readonly slug: string
  readonly name: string
  /** The four durations, already formatted by the caller's locale copy. Never a price; see below. */
  readonly durations: readonly string[]
  /** `/treatments/<slug>` in this locale. Always present: the route exists for every published service. */
  readonly href: string
}

/**
 * The treatments overview, from the catalogue.
 *
 * **No figure.** The same decision `TreatmentsIndexBody` records: the price of a treatment is four figures
 * and a "from" price here would be a fifth rendering of a row whose only purpose is to be compared with the
 * four on the page it links to. This page's job is to send a reader to that page, which is what docs/09
 * §"Routes versus anchors" means by "anchors serve homepage navigation; routes earn the rankings".
 *
 * `pathOf` is injected rather than built here so that the one place a locale becomes a URL stays
 * `localisedPath` over the registry's own path — a template literal here would be a second spelling of
 * `/treatments/<slug>`, and the Arabic prefix is exactly what gets forgotten in the second spelling.
 */
export function treatmentCardsFor(
  facts: Facts,
  durationLabel: (minutes: number) => string,
  pathOf: (slug: string) => string,
): readonly TreatmentCard[] {
  return facts.catalogue.services.map((service) => ({
    slug: service.slug,
    name: service.name,
    durations: service.variants.map((variant) => durationLabel(variant.durationMinutes)),
    href: pathOf(service.slug),
  }))
}

/** What the roster read returns, reduced to what a card may know. Structural, so the db row satisfies it. */
export interface TherapistRow {
  readonly staffReference: string
  readonly displayName: string | null
  readonly isPublishable: boolean
  readonly skills: readonly string[]
}

/**
 * One therapist card, and the two things that have to be absent from most of them.
 *
 * `displayName` is `undefined` unless the row is publishable, and `href` is `undefined` unless the row is
 * publishable **and** a therapist route exists to point at. Both are `undefined` rather than empty strings
 * so the component's optional props express the absence and a falsy-but-present value cannot render an
 * empty anchor.
 */
export interface TherapistCard {
  readonly reference: string
  readonly displayName?: string
  readonly href?: string
  /** The style skills, as the caller's copy names them. Provisional against `Y8-staff`. */
  readonly qualifications?: string
}

/**
 * Where a therapist's own page is, or null because there is not one.
 *
 * A resolver rather than a path, and it returns null today. `/therapists/[slug]` is W-SITE-06's route and
 * the registry is in exact bijection with the filesystem, so an entry for it would fail a test — and a
 * hand-built `/therapists/<something>` would be a link to a 404, which is the first thing the link-graph
 * invariant refuses (`apps/web/src/content.itest.ts`). There is also no slug to build one from: `employee`
 * has `staff_reference` and a nullable `display_name` and no public slug column at all.
 *
 * It is a parameter rather than a constant `null` so that the decision below — *a card is linked only when
 * the row may be published* — is exercised in both directions by a unit test. A function hard-wired to null
 * would make the guard untestable and therefore unproven, which is ADR 0003's failure mode.
 */
export type TherapistHref = (row: TherapistRow) => string | null

/** No therapist route exists yet, so no therapist card may carry a link. See {@link TherapistHref}. */
export const NO_THERAPIST_ROUTE: TherapistHref = () => null

/**
 * One card per row, in roster order, with the publication guard applied on the surface that has to honour it.
 *
 * ADR 0020 and migration 0050: a therapist page exists only with a display name **and** a recorded
 * photography consent, and `employee.is_publishable` is GENERATED from both so it cannot be set by an admin
 * screen that filled in one of them. docs/13 §8 states the launch state this produces — *"every therapist
 * renders as an unlinked photo card reading Name not yet published"* — and that is what this returns for all
 * nineteen: a reference, a skill, no name and no link.
 *
 * The label for an unnamed card is the component's (`unnamedLabel`), because it is translated copy and copy
 * belongs to the route.
 */
export function therapistCardFor(
  row: TherapistRow,
  href: TherapistHref,
  qualificationLabel: (skills: readonly string[]) => string | undefined,
): TherapistCard {
  const target = row.isPublishable ? href(row) : null
  const name = row.isPublishable && row.displayName !== null ? row.displayName : undefined
  const label = qualificationLabel(row.skills)
  // Spread rather than assigned: `exactOptionalPropertyTypes` is on, so `{ href: undefined }` does not
  // satisfy `href?: string` — an absent property and a property whose value is `undefined` are different
  // things, which is exactly the distinction this card turns on.
  return {
    reference: row.staffReference,
    ...(name === undefined ? {} : { displayName: name }),
    ...(target === null ? {} : { href: target }),
    ...(label === undefined ? {} : { qualifications: label }),
  }
}

export function therapistCardsFor(
  rows: readonly TherapistRow[],
  href: TherapistHref,
  qualificationLabel: (skills: readonly string[]) => string | undefined,
): readonly TherapistCard[] {
  return rows.map((row) => therapistCardFor(row, href, qualificationLabel))
}

/** One quotable review, reduced to what a card renders. Structural, so the db row satisfies it. */
export interface ReviewRow {
  readonly id: string
  readonly googleReviewId: string
  readonly rating: number
  readonly commentText: string
  readonly reviewerDisplayName: string
}

/** A rendered testimonial, and the record it came from. Nothing else may reach the section. */
export interface ReviewCard {
  readonly id: string
  /** Google's own id, so the quote below is traceable to a review anybody can look up. */
  readonly googleReviewId: string
  readonly rating: number
  readonly quote: string
  readonly attribution: string
}

/**
 * The reviews section: the cards, or the designed empty state.
 *
 * `empty` is a state rather than the absence of cards, which is the difference docs/09 §3 draws for the
 * booking flow and which applies here for a different reason: a section that renders nothing looks like a
 * page that failed to load, and this one has a true thing to say instead — there are no reviews on record
 * in this system yet.
 *
 * **`aggregateRating` is not a field of this type, and that is the decision.** docs/09 §"Schema types" is
 * explicit that Google's rules on self-serving review markup are strict, and
 * `packages/core/src/seo/jsonld/validate.ts` refuses an `aggregateRating` with no `reviewCount` behind it.
 * With no reviews there is nothing to aggregate, so this build emits none — not "emits an empty one", and
 * not "emits one when there are enough". The day reviews are published, a rating is a decision with a
 * review count behind it and it belongs to the unit that publishes them; adding the field now would be a
 * hook whose only possible value today is the invalid one.
 */
export interface ReviewSection {
  readonly cards: readonly ReviewCard[]
  readonly isEmpty: boolean
}

export function reviewSection(rows: readonly ReviewRow[]): ReviewSection {
  const cards = rows.map((row) => ({
    id: row.id,
    googleReviewId: row.googleReviewId,
    rating: row.rating,
    quote: row.commentText.trim(),
    attribution: row.reviewerDisplayName,
  }))
  return { cards, isEmpty: cards.length === 0 }
}

/**
 * The strings that must not appear in anything this site serves, and where each one comes from.
 *
 * The acceptance criterion is *"no prototype placeholder testimonial reaches the build: … the placeholder
 * strings from the prototype appear zero times in the built output"*. The prototype itself is not in this
 * repository — `assets/media/README.md` records that its **images** were extracted and nothing else was —
 * so the one string of its review section that this repository holds verbatim is the note docs/13 §6 quotes
 * from it. That entry is marked `prototype`, and it is the only one that claims to be prototype copy.
 *
 * The rest are marked `placeholder-shape`, and they are not a guess at what the prototype said. They are
 * the forms a placeholder testimonial takes when somebody writes one — lorem ipsum, the two stand-in names
 * every template ships with, a bracketed instruction to the person filling it in — and they are here
 * because the criterion's purpose is that no unsourced quotation reaches a page, not that one particular
 * sentence does not. Brief rule 15 forbids inventing a value the real system will one day hold; a list of
 * strings the system must never hold is the opposite of that, and each entry says which kind it is so that
 * nobody later reads the list as a transcription of the prototype.
 *
 * The structural half of the criterion is stronger than this scan and is where the guarantee actually
 * comes from: {@link reviewSection} maps over review **records**, so a testimonial with no record behind it
 * has no way onto the page. This is the fence that notices one arriving by another route — pasted into a
 * CMS field, typed into a copy module, left in a component by somebody testing a layout.
 */
export interface PlaceholderMarker {
  readonly text: string
  readonly kind: 'prototype' | 'placeholder-shape'
  readonly source: string
}

export const PLACEHOLDER_TESTIMONIAL_MARKERS: readonly PlaceholderMarker[] = [
  {
    text: 'swap in your real Google reviews before publishing',
    kind: 'prototype',
    source:
      'docs/13 §6, quoting berelax.netlify.app: "Reviews are placeholders — swap in your real Google ' +
      'reviews before publishing". The one string of the prototype\'s review section this repository holds.',
  },
  {
    text: 'lorem ipsum',
    kind: 'placeholder-shape',
    source: 'The shape of filler prose. Not prototype copy; see this module’s note.',
  },
  {
    text: 'John Doe',
    kind: 'placeholder-shape',
    source: 'A stand-in attribution. Brief rule 10: this build invents no names of people.',
  },
  {
    text: 'Jane Doe',
    kind: 'placeholder-shape',
    source: 'A stand-in attribution, as above.',
  },
  {
    text: 'your testimonial here',
    kind: 'placeholder-shape',
    source: 'A bracket-style instruction to whoever fills the section in.',
  },
]

/**
 * Every marker found in one document, with its kind, case-insensitively.
 *
 * Case-insensitive because a template's placeholder is as likely to be shouted as written in sentence case,
 * and a scan that missed `LOREM IPSUM` would be a scan somebody trusted.
 *
 * Returns the findings rather than a boolean so a failure names the string it found. A boolean assertion
 * fails with `expected true to be false`, which is the least useful thing a placeholder check can say.
 */
export function placeholderMarkersIn(text: string): readonly PlaceholderMarker[] {
  const haystack = text.toLowerCase()
  return PLACEHOLDER_TESTIMONIAL_MARKERS.filter((marker) =>
    haystack.includes(marker.text.toLowerCase()),
  )
}

/**
 * The rating spellings a page must not carry.
 *
 * Three rather than one: JSON-LD writes `"@type": "AggregateRating"`, microdata writes
 * `itemprop="aggregateRating"`, and both carry `ratingValue` — so a page that had dropped the type and kept
 * the value would still be publishing a rating. `ratingValue` is the one that would survive a partial edit.
 */
export const AGGREGATE_RATING_MARKERS: readonly string[] = [
  'AggregateRating',
  'aggregateRating',
  'ratingValue',
]

/** Every rating marker in one document. Empty is the only acceptable answer while there are no reviews. */
export function aggregateRatingMarkersIn(text: string): readonly string[] {
  return AGGREGATE_RATING_MARKERS.filter((marker) => text.includes(marker))
}

/**
 * The one sentence the `#about` section owes docs/09, built from the rows.
 *
 * docs/09 §"The brand collision" requires the **full** name paired with the **locality** on every citation,
 * because `berelax.com` is an international airport-spa chain with an outlet in this city and a bare brand
 * is unwinnable. `app/(en)/(public)/page.tsx` recorded that this page could not do it while it was
 * `rendering: 'static'` — a static build has no database by design — and named this unit as the one that
 * would, under ISR, from the premises row. This is that sentence, and every part of it is a column:
 * `legal_entity.trading_name`, `premises.display_name`, `premises.area` and its aliases, `premises.emirate`.
 *
 * `and` is the locale's conjunction, passed in, because the aliases are joined with a word.
 */
export function brandAndLocality(facts: Facts, and: string): string {
  const aliases = facts.address.areaAliases
  const area =
    aliases.length === 0
      ? facts.address.area
      : `${facts.address.area} (${aliases.join(` ${and} `)})`
  return `${facts.names.display}, ${area}, ${facts.address.emirate}`
}

/**
 * The trading name and the legal name, in the order docs/09 asks for them.
 *
 * Both, because they answer two different questions and the second one is the entity question: a reader
 * deciding whether this is the business they were recommended needs the name on the licence, and an
 * assistant disambiguating two businesses of the same short name needs it more.
 */
export function businessNames(facts: Facts): readonly string[] {
  return facts.names.trading === facts.names.legal
    ? [facts.names.trading]
    : [facts.names.trading, facts.names.legal]
}

/** How many treatments and how many price points the menu holds. Counted from the payload, never stated. */
export function menuSize(facts: Facts): {
  readonly services: number
  readonly pricePoints: number
} {
  return {
    services: facts.catalogue.services.length,
    pricePoints: facts.catalogue.pricePointCount,
  }
}

/**
 * Where the sticky book bar sends a reader, today.
 *
 * `/book` is the booking flow (docs/09 §1) and it does not exist: it is another unit's route, and a link to
 * it from this page would be an internal link that is not a 200 — the first rule
 * `apps/web/src/content.itest.ts`'s link-graph invariant refuses. So the bar dials, which is not a
 * placeholder for the flow: WhatsApp and the telephone are how this business actually takes bookings today
 * (docs/13 §6: *"Booking is WhatsApp only"* on the live site), and the numbers are the premises row's.
 *
 * `tel:` rather than an anchor to `#contact`, because a sticky bar in the thumb zone exists to complete an
 * action rather than to scroll. The E.164 value is what a dialler needs; the display form is the label.
 *
 * Returns null when the row holds no telephone number at all, so the bar is absent rather than rendering a
 * dead target. `premises` has both a landline and a mobile today.
 */
export interface BookAction {
  readonly href: string
  readonly telephone: string
}

export function bookActionFor(facts: Facts): BookAction | null {
  const phone = facts.contact.landline ?? facts.contact.mobile
  if (phone === null) return null
  return { href: `tel:${phone.e164}`, telephone: phone.display }
}

/**
 * One locale's home copy.
 *
 * `sections` is total over {@link HomeSectionId}, so the seventh anchor cannot be added without a heading
 * and a lede in both languages — the failure `navLabels` in `src/cms/content.ts` prevents for the site
 * navigation, applied to the page that has the anchors.
 *
 * Every field here is a **label or a sentence about the page**, never a fact. Facts arrive from the
 * premises row and the catalogue and are interpolated by the component, which is what
 * `packages/db/src/seed/premises.test.ts` asserts from the other direction.
 */
export interface HomeSectionCopy {
  readonly heading: string
  readonly lede: string
}

export interface HomeCopy {
  /** What this locale calls its home page, for the in-page navigation's accessible name. */
  readonly home: string
  /** The eyebrow, the H1 and the sentence under it. Above the fold; nothing here is a fact. */
  readonly eyebrow: string
  readonly heading: string
  readonly lede: string
  /** The hero photograph's alt text, and the pause control's labels. */
  readonly hero: {
    readonly alt: string
    readonly play: string
    readonly pause: string
  }
  readonly onThisPage: string
  readonly sections: Readonly<Record<HomeSectionId, HomeSectionCopy>>
  readonly labels: {
    /** The conjunction the district's aliases are joined with. */
    readonly and: string
    /** The link on a treatment card. Takes the treatment's own name. */
    readonly seeTreatment: (name: string) => string
    readonly durationSeparator: string
    /** What a card says where a name has not been published. Never a placeholder to fill in later. */
    readonly unnamedTherapist: string
    /** The style skills, named for a reader. Keyed by the enum value the row holds. */
    readonly skills: Readonly<Record<string, string>>
    readonly skillSeparator: string
    /** Shown in the reviews section when no review record exists. A true statement, not an apology. */
    readonly noReviews: string
    /** The attribution line under a quote. Takes Google's own display name, verbatim. */
    readonly reviewBy: (name: string) => string
    /** The sticky bar's label and its accessible name. */
    readonly bookBar: string
    readonly bookBarLabel: (telephone: string) => string
    /** The gallery's images, which are of the premises rather than of a person. */
    readonly galleryAlt: (index: number) => string
    /** The menu size, as a sentence. Takes the two counted figures. */
    readonly menuSize: (services: number, pricePoints: number) => string
    /** The roster size, as a sentence. Takes the counted figure. */
    readonly rosterSize: (therapists: number) => string
  }
}

/**
 * Every string this page is about to render, for the banned-claims lint.
 *
 * The same shape `renderedStrings` in `src/cms/content.ts` has and the same rule: a string the page does not
 * render must not be passed, because a lint that judged an unrendered branch would refuse pages for copy
 * nobody can read. So the review copy here is the empty-state sentence — the quotations themselves are a
 * reviewer's words, not this business's, and linting a customer's review would refuse to publish it for
 * using a word the licence does not permit *the business* to use.
 *
 * The catalogue names are included on purpose. They are linted when they are written
 * (`setPublicDisplayName` and `seedCatalogue` both refuse an unlinted one), so a non-compliant one can only
 * have arrived through a path that bypassed the repository — and this page is one of the places such a row
 * becomes published copy.
 */
export function homeRenderedStrings(
  facts: Facts,
  copy: HomeCopy,
  therapistCount: number,
): readonly string[] {
  const size = menuSize(facts)
  const book = bookActionFor(facts)
  return [
    copy.eyebrow,
    copy.heading,
    copy.lede,
    copy.hero.alt,
    copy.hero.play,
    copy.hero.pause,
    copy.onThisPage,
    ...HOME_SECTIONS.flatMap((id) => [copy.sections[id].heading, copy.sections[id].lede]),
    brandAndLocality(facts, copy.labels.and),
    ...businessNames(facts),
    copy.labels.menuSize(size.services, size.pricePoints),
    copy.labels.rosterSize(therapistCount),
    copy.labels.unnamedTherapist,
    copy.labels.noReviews,
    copy.labels.bookBar,
    // The sticky bar's accessible name, which is rendered copy even though nothing draws it: a screen reader
    // reads it out, so the lint has to see it.
    ...(book === null ? [] : [copy.labels.bookBarLabel(book.telephone)]),
    ...Object.values(copy.labels.skills),
    ...facts.catalogue.services.map((service) => copy.labels.seeTreatment(service.name)),
    ...facts.catalogue.services.flatMap((service) =>
      service.variants.map((variant) => String(variant.durationMinutes)),
    ),
    copy.labels.galleryAlt(1),
  ].filter((value) => value.trim() !== '')
}
