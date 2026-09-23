/**
 * The English copy for `/spa`, `/contact`, `/about`, `/faq` and `/journal`.
 *
 * Every sentence is a template and every value it interpolates comes out of the fact sheet or the CMS rows.
 * `src/cms/content.ts` says why the copy avoids the words *treatment* and *medical*, and why the absences
 * state their reasons.
 *
 * ## Why the bare brand does not appear here either
 *
 * `/about` has to answer "is this the airport spa?", which is the one place on the site where writing the
 * bare brand would be tempting — and `apps/web/src/seo/brand.ts` records why it must not be written: the
 * short name identifies the other entity as readily as this one. So the answer names this business by
 * `facts.names.display`, which is the qualified trading name from the row, and refers to the chain as "a
 * similar short name" rather than spelling it. The disambiguation is what a reader needs; repeating the
 * collision is not.
 */
import type { Facts } from '@berelax/shared'
import {
  areaPhrase,
  bookingPhones,
  buildingParts,
  type ContentCopy,
  type FactsAnswerInput,
  tradingWindowOf,
} from './content.ts'

/** How the trading week reads, from the rows: the window, the days, the zone, and the midnight crossing. */
function openingSentence(facts: Facts): string {
  const open = facts.hours.weekly.filter((day) => !day.isClosed)
  const window = tradingWindowOf(facts)
  if (window === '' || open.length === 0) {
    return 'No opening hours are recorded for the premises yet.'
  }
  const every =
    open.length === facts.hours.weekly.length ? 'every day' : `${open.length} days a week`
  const midnight = facts.hours.crossesMidnight
    ? ' The close is after midnight, so a booking at half past one belongs to the previous day.'
    : ''
  return `${window}, ${every}, local time in ${facts.hours.timezone}.${midnight}`
}

/**
 * The address as one sentence.
 *
 * `oneLine` already carries the building and the floor — `addressLines` in
 * `packages/shared/src/premises-links.ts` composes it from every line the row holds — so nothing is appended
 * here. Repeating them read as a stutter on the first render of `/spa`, which is what caught it.
 */
function addressSentence(facts: Facts): string {
  return `${facts.names.display}, ${facts.address.oneLine}.`
}

/** What to look for on arrival: the building and floor from the row, and the owner's note if there is one. */
function arrivalSentence(facts: Facts): string {
  const building = buildingParts(facts)
  const look = building.length === 0 ? '' : `Look for ${building.join(', ')}. `
  const note =
    facts.directionsNotes ??
    'No further arrival note is recorded against the premises yet, so none is published. The map and ' +
      'directions links below open the address the desk works from.'
  return `${look}${note}`
}

function contactSentence(facts: Facts): string {
  const phones = bookingPhones(facts)
  if (phones.length === 0) {
    // Nothing invented: if the row holds no number, the page says so rather than printing a plausible one.
    return 'No telephone number is recorded for the premises yet.'
  }
  const whatsapp =
    facts.contact.whatsapp.status === 'unconfirmed'
      ? ' No WhatsApp number is published: two different numbers appear on the older web properties of ' +
        'this business and neither has been confirmed, so none is served here.'
      : ` WhatsApp: ${facts.contact.whatsapp.display}.`
  const email = facts.contact.email === null ? '' : ` Email: ${facts.contact.email}.`
  return `Call the desk on ${phones.join(' or ')}.${whatsapp}${email}`
}

const NOT_RECORDED =
  'This is not recorded against the premises yet, so nothing is published for it.'

export const CONTENT_COPY_EN: ContentCopy = {
  home: 'Home',
  spa: {
    title: 'The spa',
    lede: 'Where it is, how to get in, and when the doors are open.',
    questions: {
      'where-is-it': 'Where is the spa?',
      'how-do-i-get-in': 'How do I get in?',
      'where-do-i-park': 'Where do I park?',
      'how-do-i-get-here-without-a-car': 'How do I get here without a car?',
      'what-are-the-rooms-like': 'What are the rooms like?',
      'when-is-it-open': 'When is it open?',
    },
    answers: {
      'where-is-it': ({ facts }: FactsAnswerInput) =>
        `${addressSentence(facts)} The district is ${areaPhrase(facts, 'and')}, in ` +
        `${facts.address.emirate}.`,
      'how-do-i-get-in': ({ facts }: FactsAnswerInput) => arrivalSentence(facts),
      'where-do-i-park': ({ facts }: FactsAnswerInput) => facts.parkingNotes ?? NOT_RECORDED,
      'how-do-i-get-here-without-a-car': () =>
        'Nothing is published about buses or the nearest landmarks. The location record has no field ' +
        'for either, and a bus route written from memory is worse than none: a reader would stand at ' +
        'the wrong stop. The address and the map link above are what the desk gives on the telephone.',
      'what-are-the-rooms-like': () =>
        'The rooms are not described here yet. The inventory on record is provisional, and a room count ' +
        'the desk could not keep would be a promise rather than a fact.',
      'when-is-it-open': ({ facts }: FactsAnswerInput) => openingSentence(facts),
    },
  },
  contact: {
    title: 'Contact',
    lede: 'The desk, the address, and the hours somebody is there to answer.',
    questions: {
      'how-do-i-reach-the-desk': 'How do I reach the desk?',
      'where-is-it': 'Where is the spa?',
      'when-can-i-call': 'When can I call?',
      'how-do-i-get-directions': 'How do I get directions?',
    },
    answers: {
      'how-do-i-reach-the-desk': ({ facts }: FactsAnswerInput) => contactSentence(facts),
      'where-is-it': ({ facts }: FactsAnswerInput) =>
        `${addressSentence(facts)} The district is ${areaPhrase(facts, 'and')}.`,
      'when-can-i-call': ({ facts }: FactsAnswerInput) => openingSentence(facts),
      'how-do-i-get-directions': ({ facts }: FactsAnswerInput) =>
        `The two links below open ${facts.address.oneLine} on a map and as a route from where you are. ` +
        'Both are built from the same address record the desk gives on the telephone.',
    },
  },
  about: {
    title: 'About',
    lede: 'What this place is, where it is, and how to tell it apart from the airport spa.',
    questions: {
      'what-is-this-place': 'What is this place?',
      'where-is-it': 'Where is it?',
      'what-is-on-the-menu': 'What is on the menu?',
      'how-do-i-know-it-is-the-right-place': 'How do I know it is the right place?',
    },
    answers: {
      'what-is-this-place': ({ facts }: FactsAnswerInput) =>
        `${facts.names.display} is a massage centre and spa in ${areaPhrase(facts, 'and')}, ` +
        `${facts.address.emirate}. It trades as ${facts.names.trading} and the registered entity is ` +
        `${facts.names.legal}.`,
      'where-is-it': ({ facts }: FactsAnswerInput) => addressSentence(facts),
      'what-is-on-the-menu': ({ facts }: FactsAnswerInput) =>
        `${facts.catalogue.services.length} massages, each at several lengths: ` +
        `${facts.catalogue.pricePointCount} prices between them, all in ${facts.catalogue.currency} ` +
        'and all inclusive of VAT. The menu and the full price list are linked below.',
      'how-do-i-know-it-is-the-right-place': ({ facts }: FactsAnswerInput) =>
        `By the full name and the address: ${facts.names.display}, ${facts.address.oneLine}. An ` +
        'international airport-spa chain trades under a similar short name and has an outlet at the ' +
        'airport in this city, so the short name on its own identifies neither of us. Every page here ' +
        'carries the full name, and the machine-readable fact sheet carries the address it belongs to.',
    },
  },
  journal: {
    title: 'Journal',
    lede: 'Notes on visiting, booking and what happens in the room.',
    questions: {
      'what-is-in-the-journal': 'What is in the journal?',
      'who-writes-it': 'Who writes it?',
      'where-do-i-start': 'Where do I start?',
    },
    answers: {
      'what-is-in-the-journal': ({ posts }) =>
        posts.length === 0
          ? 'Nothing yet. No post has been published, and an empty list is the honest state of it rather ' +
            'than a page filled with copy nobody has signed.'
          : `${posts.length} post${posts.length === 1 ? '' : 's'}, newest first.`,
      'who-writes-it': () =>
        'Every post carries the name of the person who wrote it, the name of the person who checked it ' +
        'and the date it went out. A post missing any of the three is not published — the check refuses ' +
        'it by name — and a byline naming somebody who does not exist would be worse than a missing one.',
      'where-do-i-start': ({ facts }) =>
        `The menu is the place to start: ${facts.catalogue.services.length} massages with every length ` +
        'and every price. It is linked below.',
    },
  },
  faq: {
    title: 'Questions and answers',
    lede: 'The questions the desk is asked most often.',
    empty:
      'No questions have been published yet. They are written in the admin and appear here, and in the ' +
      'machine-readable answer set, at the same moment — so an answer a reader sees and an answer an ' +
      'assistant quotes cannot differ.',
  },
  labels: {
    menu: 'The menu',
    prices: 'Prices',
    book: 'Book a treatment',
    faq: 'Questions and answers',
    spa: 'The spa',
    contact: 'Contact',
    about: 'About',
    journal: 'Journal',
    map: 'Open the address on a map',
    directions: 'Get directions to the door',
    nav: 'Pages',
    healthNote: 'Health note',
    journalEmpty: 'No post has been published yet.',
    byline: (name) => `Written by ${name}`,
    reviewedBy: (name) => `Checked by ${name}`,
    publishedOn: (date) => `Published ${date}`,
    notRecorded: NOT_RECORDED,
  },
}
