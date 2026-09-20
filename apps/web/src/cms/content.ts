/**
 * What the CMS-driven and premises-driven routes say, as data. Pure, and deliberately not JSX.
 *
 * The same split `src/treatments/content.ts` makes, for the same three reasons — the structure is assertable
 * without a browser, `jsx: "preserve"` means vitest cannot parse a `.tsx` from this application, and every
 * answer is a row rather than a sentence somebody typed — plus a fourth that is this unit's own: **every
 * string a CMS route renders goes through the banned-claims lint**, and a lint can only be applied to copy
 * that exists as a value.
 *
 * ## The word this file may not use
 *
 * `treatment` is on `regulatory_profile.banned_claim_terms` under the seeded profile (0004,
 * `licence_class = unconfirmed`), and the acceptance criterion for this unit is that every CMS route's
 * rendered copy passes that lint. So the copy here says *menu*, *session* and *massage* where the rest of
 * the site says *treatment*: `src/treatments/copy-en.ts` is not linted and this is. The same is true of
 * *medical*, which is why the disclaimer's visible heading is "Health note" rather than the name of the
 * field it comes from. Both are consequences of Y1-licence being open, not style choices — the day a lawyer
 * confirms the licence class, `medical_claims_permitted` flips in a row and the vocabulary widens with no
 * code change.
 *
 * ## What is deliberately not said
 *
 * Nothing about what a massage does to a body; nothing about who delivers it; no room count; no public
 * transport note. The last two are absences with reasons, and the reasons are in the answers themselves
 * rather than in a comment, because a reader who finds no room list deserves to be told why: the room
 * inventory on record is the provisional five-room stub (Y8-rooms — docs/13 §8 lists the room count among
 * the unknowns), and `premises` has no column for public transport or landmarks at all, although docs/09 §4
 * names both. A plausible bus route is worse than a visibly missing one.
 */
import { healthAdjacencyOf, journalPostProse } from '@berelax/cms'
import type { FaqEntry } from '@berelax/core'
import type { Facts } from '@berelax/shared'
import type { Locale } from '../i18n/locales.ts'
import type { NavRouteId } from '../routes/nav.ts'
import {
  bookingPhones,
  type QuestionSection,
  slugifyHeadingKey,
  tradingWindowOf,
} from '../treatments/content.ts'
import type { EditorialPage, JournalPost } from './read.ts'

/**
 * The questions each page answers, in the order it answers them.
 *
 * Frozen key lists rather than strings at the call site, exactly as `TREATMENT_QUESTIONS` is: the anchor id
 * of every heading comes from the key, so it is identical in both locales and cannot be moved by an edit to
 * the wording. `/ar/spa#where-do-i-park` and `/spa#where-do-i-park` are the same anchor on two documents.
 */
export const SPA_QUESTIONS = [
  'where-is-it',
  'how-do-i-get-in',
  'where-do-i-park',
  'how-do-i-get-here-without-a-car',
  'what-are-the-rooms-like',
  'when-is-it-open',
] as const
export type SpaQuestionKey = (typeof SPA_QUESTIONS)[number]

export const CONTACT_QUESTIONS = [
  'how-do-i-reach-the-desk',
  'where-is-it',
  'when-can-i-call',
  'how-do-i-get-directions',
] as const
export type ContactQuestionKey = (typeof CONTACT_QUESTIONS)[number]

export const ABOUT_QUESTIONS = [
  'what-is-this-place',
  'where-is-it',
  'what-is-on-the-menu',
  'how-do-i-know-it-is-the-right-place',
] as const
export type AboutQuestionKey = (typeof ABOUT_QUESTIONS)[number]

export const JOURNAL_QUESTIONS = [
  'what-is-in-the-journal',
  'who-writes-it',
  'where-do-i-start',
] as const
export type JournalQuestionKey = (typeof JOURNAL_QUESTIONS)[number]

/** Everything a fact-derived answer may read. Nothing else is in scope. */
export interface FactsAnswerInput {
  readonly facts: Facts
  readonly locale: Locale
}

/** What a journal answer may read: the facts and the posts that are actually published. */
export interface JournalAnswerInput extends FactsAnswerInput {
  readonly posts: readonly JournalPost[]
}

/** One page's copy: the heading, the lede, and a question and answer per key. */
export interface PageCopy<Key extends string, Input> {
  readonly title: string
  readonly lede: string
  readonly questions: Readonly<Record<Key, string>>
  /** Total over the key union, so a question added without copy for both locales fails to compile. */
  readonly answers: Readonly<Record<Key, (input: Input) => string>>
}

/** The copy one locale needs for all five routes, plus the labels they share. */
export interface ContentCopy {
  /** What this locale calls its home page, for the breadcrumb and the trail. */
  readonly home: string
  readonly spa: PageCopy<SpaQuestionKey, FactsAnswerInput>
  readonly contact: PageCopy<ContactQuestionKey, FactsAnswerInput>
  readonly about: PageCopy<AboutQuestionKey, FactsAnswerInput>
  readonly journal: PageCopy<JournalQuestionKey, JournalAnswerInput>
  /** `/faq` has no questions of its own: its headings are the rows. See {@link faqSections}. */
  readonly faq: {
    readonly title: string
    readonly lede: string
    /** Shown instead of the list when nothing is published. Never a fabricated question. */
    readonly empty: string
  }
  readonly labels: {
    /** The link to the catalogue index. Not the word the registry uses; see the header. */
    readonly menu: string
    readonly prices: string
    readonly faq: string
    readonly spa: string
    readonly contact: string
    readonly about: string
    readonly journal: string
    readonly map: string
    readonly directions: string
    /** The accessible name of the site navigation. */
    readonly nav: string
    /** The visible heading of the medical-disclaimer pattern. */
    readonly healthNote: string
    readonly journalEmpty: string
    readonly byline: (name: string) => string
    readonly reviewedBy: (name: string) => string
    readonly publishedOn: (date: string) => string
    /** A value the row does not hold, with what it is waiting on, in this locale. */
    readonly notRecorded: string
  }
}

/**
 * One label per page of the site navigation, in this locale.
 *
 * Total over {@link NavRouteId}: a route added to `NAV_ROUTE_IDS` without copy here is a type error in both
 * locales at once, which is the failure this shape exists to produce. The labels themselves are the ones
 * already written for the links in the page bodies, so a reader meets the same word in the nav and in the
 * sentence that points at the same page.
 */
export function navLabels(copy: ContentCopy): Readonly<Record<NavRouteId, string>> {
  return {
    home: copy.home,
    treatments: copy.labels.menu,
    pricing: copy.labels.prices,
    spa: copy.labels.spa,
    faq: copy.labels.faq,
    journal: copy.labels.journal,
    about: copy.labels.about,
    contact: copy.labels.contact,
  }
}

/** The area and its other names as one phrase, or the area alone when it has no aliases. */
export function areaPhrase(facts: Facts, and: string): string {
  const aliases = facts.address.areaAliases
  if (aliases.length === 0) return facts.address.area
  return `${facts.address.area} (${aliases.join(` ${and} `)})`
}

/** The building, as the row spells it: the floor and the second address line, whichever exist. */
export function buildingParts(facts: Facts): readonly string[] {
  return [facts.address.line2, facts.address.floor].filter(
    (part): part is string => part !== null && part.trim() !== '',
  )
}

/**
 * The sections of one page, from its key list and its copy.
 *
 * Generic over the key and the input so the four fact-derived pages share one builder: four copies of a
 * three-line `map` is four places the id could stop coming from the key.
 */
export function sectionsFor<Key extends string, Input>(
  keys: readonly Key[],
  copy: PageCopy<Key, Input>,
  input: Input,
): readonly QuestionSection[] {
  return keys.map((key) => ({
    id: slugifyHeadingKey(key),
    question: copy.questions[key],
    answer: copy.answers[key](input),
  }))
}

export const spaSections = (
  copy: ContentCopy,
  input: FactsAnswerInput,
): readonly QuestionSection[] => sectionsFor([...SPA_QUESTIONS], copy.spa, input)

export const contactSections = (
  copy: ContentCopy,
  input: FactsAnswerInput,
): readonly QuestionSection[] => sectionsFor([...CONTACT_QUESTIONS], copy.contact, input)

export const aboutSections = (
  copy: ContentCopy,
  input: FactsAnswerInput,
): readonly QuestionSection[] => sectionsFor([...ABOUT_QUESTIONS], copy.about, input)

export const journalSections = (
  copy: ContentCopy,
  input: JournalAnswerInput,
): readonly QuestionSection[] => sectionsFor([...JOURNAL_QUESTIONS], copy.journal, input)

/**
 * The anchor id of one FAQ heading.
 *
 * The one place on the site where a heading id is **derived from the copy** rather than from a key, and the
 * reason is that an FAQ entry has no key: the question is the content, written by an editor in the admin. So
 * the id is the slugified question, with the row's position as the fallback for a question that does not
 * reduce to anything usable — an Arabic-script question slugifies to the empty string, which is a fragment
 * no browser resolves.
 *
 * The cost is stated rather than hidden: rewording a question moves its anchor, and a citation pointing at
 * the old one lands at the top of the page. That is the lesser of the two evils available — the alternative
 * is an opaque document id in a public URL — and it is the reason the treatment pages key theirs instead.
 */
export function faqAnchorId(question: string, index: number): string {
  try {
    return slugifyHeadingKey(question)
  } catch {
    return `faq-${index + 1}`
  }
}

/**
 * The FAQ, as heading sections, from the rows.
 *
 * The same array the `FAQPage` node is built from, mapped once. That is what makes the acceptance criterion
 * — *"/faq and the FAQPage schema derive from the same faq_entries rows: question and answer text and entry
 * count are asserted equal"* — true by construction rather than by two code paths agreeing: there is one
 * read, one array, and this mapping is the only thing between it and the page.
 *
 * An entry with a blank question or answer is dropped, exactly as `faqPageNode` drops it, so the page and
 * the schema cannot differ in count either. A half-finished draft is the shape that produces one.
 */
export function faqSections(entries: readonly FaqEntry[]): readonly QuestionSection[] {
  return entries
    .filter((entry) => entry.question.trim() !== '' && entry.answer.trim() !== '')
    .map((entry, index) => ({
      id: faqAnchorId(entry.question, index),
      question: entry.question.trim(),
      answer: entry.answer.trim(),
    }))
}

/** The FAQ entries that will actually be published, in the order the page renders them. */
export function publishableFaqEntries(entries: readonly FaqEntry[]): readonly FaqEntry[] {
  return entries.filter((entry) => entry.question.trim() !== '' && entry.answer.trim() !== '')
}

/**
 * Is any post on this page health-adjacent?
 *
 * Asked of the copy as well as of the checkbox, through the same function the publication lint uses — so the
 * disclaimer appears on a page carrying a post about pain whose author did not tick the box. Rendering it
 * from the declaration alone would make the pattern optional in practice, and the post that most needs it is
 * the one nobody classified.
 */
export function anyHealthAdjacent(posts: readonly JournalPost[]): boolean {
  return posts.some(
    (post) => healthAdjacencyOf(journalPostProse(post), post.healthTopicDeclared).adjacent,
  )
}

/**
 * The editorial page one route renders, or undefined.
 *
 * `/about` and the legal set are `pages` documents addressed by slug. Undefined is the ordinary state today —
 * the collection holds no rows — and the route renders what it can derive from the business's own records
 * instead, which is why this returns `undefined` rather than throwing.
 */
export function editorialPageFor(
  pages: readonly EditorialPage[],
  slug: string,
): EditorialPage | undefined {
  return pages.find((page) => page.slug === slug)
}

/** Every string a page is about to render, for the lint. Sections, ledes and the editorial body. */
export function renderedStrings(input: {
  readonly title: string
  readonly lede: string
  readonly sections: readonly QuestionSection[]
  readonly extra?: readonly string[]
}): readonly string[] {
  return [
    input.title,
    input.lede,
    ...input.sections.flatMap((section) => [section.question, section.answer]),
    ...(input.extra ?? []),
  ].filter((value) => value.trim() !== '')
}

/** The trading window as one string, from the row. Re-exported so a page needs one import. */
export { bookingPhones, tradingWindowOf }
