/**
 * What a catalogue-derived page says, as data. Pure, and deliberately not a component.
 *
 * Three things follow from this being a module rather than JSX, and each of them is the reason it is one:
 *
 *   - **the structure is assertable without a browser.** The acceptance criterion is *"every h2 is
 *     question-shaped with a stable slugified id and is immediately followed by a `<p>`"*, which is a claim
 *     about the rendered DOM — but "question-shaped" and "stable id" are claims about this data, and a unit
 *     test can check all eight pages in milliseconds. `treatments.itest.ts` then checks the served markup;
 *     the pair is what makes the criterion a property rather than a convention;
 *   - **`apps/web/tsconfig.json` sets `jsx: "preserve"`,** so vitest cannot parse a `.tsx` from this
 *     application at all (see `src/seo/structured-data.tsx`). Anything a unit test must reach lives in a
 *     `.ts` file;
 *   - **every answer is a row.** Not one figure, name, address or opening time below is written here: they
 *     come from the fact sheet — `readPremisesFacts` composed by `buildFacts` — which is the same payload
 *     the `Offer` JSON-LD and `/api/facts` are built from. That is what makes the page and the schema block
 *     unable to disagree, and it is why `no-price-literals.test.ts` can assert there is no numeric price
 *     literal in any template: there is nowhere for one to hide.
 *
 * ## Why the headings are questions, and why the ids are not derived from them
 *
 * docs/09 §"LLM SEO" asks for "question-shaped `<h2>`s with stable anchor IDs, a direct answer in the first
 * sentence under each". The question shape is what makes a section quotable: an assistant asked "how much
 * is a 90-minute massage at BE RELAX" can lift the paragraph under "How much does it cost?" and cite it.
 *
 * The id is derived from the **key**, never from the question text, and that is the "stable" half of the
 * criterion. An id slugified from the copy moves the day somebody improves the wording — silently breaking
 * every link and every citation that pointed at it — and it would be a *different* id in Arabic, where a
 * slug of the question is either empty (the slugifier drops non-Latin script) or a transliteration nobody
 * can type. One key, one id, both locales: `/ar/treatments/x#how-much-does-it-cost` and its English
 * equivalent are the same anchor on two documents.
 */
import { formatAmount, formatMoney, grossMoneyFromFils, type Money } from '@berelax/core'
import type { Facts, FactsCatalogue } from '@berelax/shared'
import type { Locale } from '../i18n/locales.ts'

/** One service of the fact sheet's catalogue block: the linted name, the slug and the priced durations. */
export type CatalogueService = FactsCatalogue['services'][number]
/** One priced duration. `grossFils` is the authoritative figure; `grossAed` is it, already formatted. */
export type CatalogueVariant = CatalogueService['variants'][number]

/**
 * The questions a treatment page answers, in the order it answers them.
 *
 * A frozen list rather than strings at each call site: the id of every heading on every treatment page in
 * both locales comes from here, so an anchor cannot be renamed by an edit somewhere else, and a question
 * added without copy for both locales fails to compile (`Record<QuestionKey, string>` below).
 *
 * The order is the order a customer asks them in — what is it, how long, how much, where, when, how do I
 * book — which is also the order that puts the two commercial answers above the fold on a phone.
 */
export const TREATMENT_QUESTIONS = [
  'what-is-it',
  'how-long-does-it-take',
  'how-much-does-it-cost',
  'where-is-it-delivered',
  'when-can-i-book-it',
  'how-do-i-book-it',
] as const
export type QuestionKey = (typeof TREATMENT_QUESTIONS)[number]

/** The questions the index and the pricing page answer. Same mechanism, different page. */
export const MENU_QUESTIONS = [
  'what-is-on-the-menu',
  'how-is-a-price-decided',
  'what-is-priced-on-request',
] as const
export type MenuQuestionKey = (typeof MENU_QUESTIONS)[number]

/**
 * A heading with the paragraph that answers it, and the id the heading carries.
 *
 * `answer` is one paragraph and is rendered as the `<p>` immediately after the `<h2>` — the structural half
 * of the criterion. `extra` is everything that comes after it: the price table, a list, nothing. Keeping
 * them separate is what makes "immediately followed by a `<p>`" a property of the data rather than a rule a
 * template has to remember.
 */
export interface QuestionSection {
  /** The stable anchor. Slugified from the key, identical in every locale. */
  readonly id: string
  /** Question-shaped: it ends in a question mark, asserted over every section of every page. */
  readonly question: string
  /** The direct answer, first sentence first. Rendered as the `<p>` right after the heading. */
  readonly answer: string
}

/**
 * A key as an anchor id.
 *
 * The keys above are already slugs, so this is a guard rather than a transformation: it normalises and then
 * refuses anything that is not `a-z0-9` joined by single hyphens, because an id is published in a URL and a
 * heading id with a space in it is a fragment no browser will resolve.
 */
export function slugifyHeadingKey(key: string): string {
  const slug = key
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) {
    throw new Error(
      `'${key}' does not reduce to a usable anchor id ('${slug}'). A heading id is published in a URL: a ` +
        'fragment with a space, an empty id or a leading hyphen is a link that silently resolves to the ' +
        'top of the page.',
    )
  }
  return slug
}

/** The copy a treatment page needs, in one locale. Every value is a sentence template, never a fact. */
export interface TreatmentCopy {
  /** What this locale calls the home page, for the breadcrumb. */
  readonly home: string
  /** What this locale calls the treatments index. */
  readonly index: string
  /** The `<h2>` for each question. Total over the key union: a new question needs copy to compile. */
  readonly questions: Readonly<Record<QuestionKey, string>>
  /** The answers, as functions of the facts. Total, for the same reason. */
  readonly answers: Readonly<Record<QuestionKey, (input: AnswerInput) => string>>
  /** The price table's caption and two column headings. */
  readonly table: {
    readonly caption: (name: string) => string
    readonly duration: string
    /** States the currency once, which is why no cell repeats it. */
    readonly amount: string
  }
  /** "45 minutes", in this locale. Minutes are a row label, not a route. */
  readonly durationLabel: (minutes: number) => string
  /** The link to one treatment, from the index. */
  readonly seeTreatment: (name: string) => string
  /** The link to the pricing page. */
  readonly seeAllPrices: string
  /** What a price-on-request offering shows instead of a figure. */
  readonly priceOnRequest: string
}

/** Everything an answer may read. Nothing else is in scope, which is the point. */
export interface AnswerInput {
  readonly facts: Facts
  readonly service: CatalogueService
  readonly locale: Locale
}

/** The gross of one duration, as `Money`, through the one runtime door that refuses a float. */
export function variantMoney(variant: CatalogueVariant): Money {
  return grossMoneyFromFils(variant.grossFils)
}

/**
 * The price string a page renders: the figure, grouped, two decimals, no symbol.
 *
 * `formatAmount` rather than `formatMoney` because every figure on these pages is in a table column whose
 * header states `AED` once — which is what `formatAmount` is documented for, and what makes the English and
 * Arabic documents publish byte-identical figures (docs/08 §7: Latin numerals in both).
 */
export function priceCellFor(variant: CatalogueVariant): string {
  return formatAmount(variantMoney(variant))
}

/**
 * The same amount with its currency, for a sentence rather than a column.
 *
 * Used in the answer paragraph, where nothing else states the currency. `formatMoney`'s locale argument is
 * passed through: `ar-AE-u-nu-latn` places the currency after the figure, which is how a reader of the
 * Arabic document expects it.
 */
export function priceSentenceFor(variant: CatalogueVariant, locale: Locale): string {
  return formatMoney(variantMoney(variant), locale)
}

/** The durations of a service, ascending. The catalogue's order, asserted rather than assumed. */
export function durationsOf(service: CatalogueService): readonly number[] {
  return [...service.variants].map((variant) => variant.durationMinutes).sort((a, b) => a - b)
}

/** The cheapest and dearest priced durations, which is what "from X to Y" is built from. */
export function priceRangeOf(service: CatalogueService): {
  readonly cheapest: CatalogueVariant
  readonly dearest: CatalogueVariant
} {
  const sorted = [...service.variants].sort(
    (a, b) => Number(a.grossFils) - Number(b.grossFils) || a.durationMinutes - b.durationMinutes,
  )
  const cheapest = sorted[0]
  const dearest = sorted[sorted.length - 1]
  if (cheapest === undefined || dearest === undefined) {
    // A published service with no priced variant cannot exist: `service_publish_without_priced_variant`
    // (0029) refuses the publication. So this is a fact sheet that was assembled wrongly, not a menu gap.
    throw new Error(
      `'${service.slug}' reached a page with no priced duration. Publication is refused without one ` +
        '(0029), so the fact sheet this came from is not the database.',
    )
  }
  return { cheapest, dearest }
}

/** The `id` of one price cell: the catalogue row it renders, as `<slug>-<minutes>`. */
export function priceRowId(slug: string, minutes: number): string {
  return `${slug}-${minutes}`
}

/**
 * Every section of one treatment page, in order.
 *
 * The answers are the copy's, the facts are the row's, and the ids are the keys'. Nothing here decides
 * what is true.
 */
export function treatmentSections(
  input: AnswerInput,
  copy: TreatmentCopy,
): readonly QuestionSection[] {
  return TREATMENT_QUESTIONS.map((key) => ({
    id: slugifyHeadingKey(key),
    question: copy.questions[key],
    answer: copy.answers[key](input),
  }))
}

/** The copy a menu page (the index, `/pricing`) needs. Same shape, its own question set. */
export interface MenuCopy {
  readonly home: string
  /** The index's `<h1>` and the name of this section in a trail. */
  readonly title: string
  readonly lede: string
  /** The pricing page's `<h1>`. A page with the same heading as its table caption reads as a duplicate. */
  readonly pricingTitle: string
  readonly pricingLede: string
  readonly questions: Readonly<Record<MenuQuestionKey, string>>
  readonly answers: Readonly<Record<MenuQuestionKey, (facts: Facts) => string>>
  readonly table: {
    readonly caption: (count: number) => string
    readonly duration: string
    readonly amount: string
  }
  readonly durationLabel: (minutes: number) => string
  readonly seeTreatment: (name: string) => string
  readonly priceOnRequest: string
}

/** Every section of a menu page, in order. */
export function menuSections(facts: Facts, copy: MenuCopy): readonly QuestionSection[] {
  return MENU_QUESTIONS.map((key) => ({
    id: slugifyHeadingKey(key),
    question: copy.questions[key],
    answer: copy.answers[key](facts),
  }))
}

/**
 * The trading window as one string: the open time, an en dash, the close time — both from the row.
 *
 * The times are deliberately not spelled in this comment. `packages/db/src/seed/premises.test.ts` refuses an
 * opening-hours literal anywhere under `apps/web` or `packages/ui`, with an exemption list that is empty and
 * asserted to stay empty, and it caught this line: a rendered surface with the hours typed into it goes on
 * showing them after an owner has changed the opening time, and a doc comment in a rendered package is one
 * grep away from being indistinguishable from the real thing.
 */
export function tradingWindowOf(facts: Facts): string {
  const open = facts.hours.weekly.find((day) => !day.isClosed)
  if (open === undefined) return ''
  return `${open.opens}–${open.closes}`
}

/**
 * The phone numbers a page may publish, in display form, landline first.
 *
 * WhatsApp is deliberately absent. `premises.phone_whatsapp` holds a placeholder the schema's own
 * `is_placeholder_text()` refuses (Y1-nap: docs/13 §3 records two candidate numbers and asks which is
 * correct), and `factsSchema` models the channel as a discriminated union carrying **no digits** while it
 * is unconfirmed — so there is nothing here to publish and nothing to accidentally publish.
 */
export function bookingPhones(facts: Facts): readonly string[] {
  return [facts.contact.landline, facts.contact.mobile]
    .filter((phone): phone is NonNullable<typeof phone> => phone !== null)
    .map((phone) => phone.display)
}
