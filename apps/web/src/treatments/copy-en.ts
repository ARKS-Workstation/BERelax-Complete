/**
 * The English copy for the catalogue-derived pages.
 *
 * Copy belongs to the locale and the facts belong to the row: every sentence here is a template, and every
 * value it interpolates comes out of the fact sheet. That split is not tidiness — it is the only reason
 * `no-price-literals.test.ts` can assert that no template in this application contains a numeric price, and
 * the reason a corrected address or a raised price reaches nine pages in two languages by revalidation
 * rather than by an edit.
 *
 * ## What is deliberately not said
 *
 * **Nothing about what a treatment does to a body.** No relief, no relaxation claim, no benefit. The
 * business is licensed as a massage and spa activity, not a health service (ADR 0020), and a sentence
 * claiming a therapeutic effect is the regulatory exposure B-CAT-05's lexicon exists to prevent — the lint
 * covers the public display *name*, and copy is where the same claim arrives without one.
 *
 * **Nothing about who delivers it.** No nationality, no name, no title. The style is a property of the
 * treatment (ADR 0021) and a therapist has no publishable display name at all (0030, ADR 0020).
 *
 * **No WhatsApp number.** There is no confirmed one (Y1-nap); see `bookingPhones`.
 */
import type { Facts } from '@berelax/shared'
import {
  type AnswerInput,
  bookingPhones,
  type MenuCopy,
  priceRangeOf,
  priceSentenceFor,
  type TreatmentCopy,
  tradingWindowOf,
} from './content.ts'

/**
 * The style, as a reader sees it.
 *
 * `service.style` is the enum value (`asian`, `arabic`) and this is its English label. A `Record` over the
 * two rather than a capitalisation of whatever the column holds: a third style would need a decision here
 * rather than producing `Ethiopian` from a row nobody translated.
 */
const STYLE_LABEL: Readonly<Record<string, string>> = { asian: 'Asian', arabic: 'Arabic' }

const styleOf = (style: string): string => STYLE_LABEL[style] ?? style

/** "45, 60, 90 or 120 minutes" — the durations of one service, from the rows. */
function durationList(input: AnswerInput): string {
  const minutes = input.service.variants.map((variant) => variant.durationMinutes)
  const last = minutes[minutes.length - 1]
  if (minutes.length <= 1) return `${last ?? 0} minutes`
  return `${minutes.slice(0, -1).join(', ')} or ${last} minutes`
}

/** How the trading week reads: every day when all seven share one window, else the open days counted. */
function tradingSentence(facts: Facts): string {
  const open = facts.hours.weekly.filter((day) => !day.isClosed)
  const window = tradingWindowOf(facts)
  const uniform = open.length === facts.hours.weekly.length && open.length > 0
  const every = uniform ? 'every day' : `${open.length} days a week`
  const midnight = facts.hours.crossesMidnight
    ? ' The closing time is after midnight, so a booking at 01:30 belongs to the previous day’s trading.'
    : ''
  return `${window}, ${every}, local time in ${facts.hours.timezone}.${midnight}`
}

export const TREATMENT_COPY_EN: TreatmentCopy = {
  home: 'Home',
  index: 'Treatments',
  questions: {
    'what-is-it': 'What is this treatment?',
    'how-long-does-it-take': 'How long does it take?',
    'how-much-does-it-cost': 'How much does it cost?',
    'where-is-it-delivered': 'Where is it delivered?',
    'when-can-i-book-it': 'When can I book it?',
    'how-do-i-book-it': 'How do I book it?',
  },
  answers: {
    'what-is-it': (input) =>
      `${input.service.name} is on the menu at ${input.facts.names.display}, in the ` +
      `${styleOf(input.service.style)} style, at ${input.service.variants.length} durations.`,
    'how-long-does-it-take': (input) =>
      `It is booked at ${durationList(input)}. The duration is the only thing that changes the price: ` +
      'there is one page for the treatment and a row for each length.',
    'how-much-does-it-cost': (input) => {
      const { cheapest, dearest } = priceRangeOf(input.service)
      return (
        `From ${priceSentenceFor(cheapest, input.locale)} for ${cheapest.durationMinutes} minutes to ` +
        `${priceSentenceFor(dearest, input.locale)} for ${dearest.durationMinutes} minutes. Every ` +
        'figure is the gross amount, with VAT included.'
      )
    },
    'where-is-it-delivered': (input) =>
      `At ${input.facts.names.display}, ${input.facts.address.oneLine}. The district is also written ` +
      `${input.facts.address.areaAliases.join(' and ')}.`,
    'when-can-i-book-it': (input) => tradingSentence(input.facts),
    'how-do-i-book-it': (input) => {
      const phones = bookingPhones(input.facts)
      if (phones.length === 0) {
        // Nothing invented: if the row holds no number, the page says there is none to publish rather
        // than printing a plausible one. `premises` is the only NAP source (docs/09 §4).
        return 'No telephone number is recorded for the premises yet.'
      }
      return `Call the desk on ${phones.join(' or ')} and say which duration you would like.`
    },
  },
  table: {
    caption: (name) => `${name} — every duration and its price`,
    duration: 'Duration',
    amount: 'Price (AED, VAT included)',
  },
  durationLabel: (minutes) => `${minutes} minutes`,
  seeTreatment: (name) => `See ${name}`,
  seeAllPrices: 'See every price',
  priceOnRequest: 'Price on request',
}

export const MENU_COPY_EN: MenuCopy = {
  home: 'Home',
  title: 'Treatments',
  lede: 'Every treatment on the menu, with the price of each duration.',
  pricingTitle: 'Prices',
  pricingLede:
    'Every duration of every treatment, gross and VAT-inclusive, as the desk charges it.',
  questions: {
    'what-is-on-the-menu': 'What is on the menu?',
    'how-is-a-price-decided': 'How is a price decided?',
    'what-is-priced-on-request': 'What is priced on request?',
  },
  answers: {
    'what-is-on-the-menu': (facts) =>
      `${facts.catalogue.services.length} treatments, each in one style, with ` +
      `${facts.catalogue.pricePointCount} prices between them: one for every duration of every ` +
      'treatment.',
    'how-is-a-price-decided': (facts) =>
      `The duration decides it. Every price is in ${facts.catalogue.currency}, gross, with VAT ` +
      'included, and it is the amount the desk charges.',
    'what-is-priced-on-request': (facts) =>
      facts.catalogue.onRequest.length === 0
        ? 'Nothing: every treatment on the menu has a price for each duration.'
        : `${facts.catalogue.onRequest.map((offering) => offering.label).join(', ')} — ` +
          'these are arranged at the desk, because the price depends on how they are staffed and no ' +
          'figure has been set for them yet.',
  },
  table: {
    caption: (count) => `${count} prices: every treatment at every duration`,
    duration: 'Duration',
    amount: 'Price (AED, VAT included)',
  },
  durationLabel: (minutes) => `${minutes} minutes`,
  seeTreatment: (name) => `See ${name}`,
  priceOnRequest: 'Price on request',
}
