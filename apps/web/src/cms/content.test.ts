import type { FaqEntry } from '@berelax/core'
import type { Facts } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import { NAV_ROUTE_IDS } from '../routes/nav.ts'
import {
  ABOUT_QUESTIONS,
  aboutSections,
  anyHealthAdjacent,
  areaPhrase,
  buildingParts,
  CONTACT_QUESTIONS,
  contactSections,
  editorialPageFor,
  faqAnchorId,
  faqSections,
  JOURNAL_QUESTIONS,
  journalSections,
  navLabels,
  publishableFaqEntries,
  renderedStrings,
  SPA_QUESTIONS,
  spaSections,
} from './content.ts'
import { CONTENT_COPY_AR } from './copy-ar.ts'
import { CONTENT_COPY_EN } from './copy-en.ts'
import type { JournalPost } from './read.ts'
import { richTextParagraphs, richTextToPlainText } from './rich-text.ts'

/**
 * W-SITE-07 — what the CMS routes say, checked without a browser.
 *
 * The structural half of the acceptance criteria that `content.itest.ts` then checks over the served bytes:
 * the heading ids are identical in both locales, every heading is question-shaped, every answer is one
 * paragraph, and the rich-text flattener — the single most load-bearing function on these routes, because the
 * publication lint reads its output — really does find the text in a nested tree.
 */

/** A fact sheet with only the fields these answers read. Not `premises`: this suite has no database. */
const FACTS = {
  names: {
    legal: 'Fixture Registered Entity LLC',
    trading: 'Fixture Trading Name',
    display: 'Fixture Display Name',
  },
  address: {
    line1: '1 Fixture Street',
    line2: 'Fixture Block',
    floor: 'Fixture Floor',
    area: 'Fixture Area',
    areaAliases: ['Alias One', 'Alias Two'],
    emirate: 'Fixture Emirate',
    countryCode: 'AE',
    poBox: null,
    makaniNumber: null,
    oneLine: '1 Fixture Street, Fixture Block, Fixture Floor, Fixture Area, Fixture Emirate, AE',
  },
  geo: {
    latitude: null,
    longitude: null,
    plusCode: null,
    placeId: null,
    mapUrl: 'https://maps.example.test/place',
    directionsUrl: 'https://maps.example.test/dir',
  },
  contact: {
    landline: { e164: '+9712000000', display: '+971 2 000 0000' },
    mobile: null,
    whatsapp: {
      status: 'unconfirmed',
      provisional: true,
      openQuestionId: 'Y1-nap',
      why: 'two candidates',
      number: null,
    },
    email: null,
  },
  hours: {
    timezone: 'Asia/Dubai',
    weekly: Array.from({ length: 7 }, (_, day) => ({
      dayOfWeek: day,
      opens: '09:00',
      closes: '21:00',
      closesNextDay: false,
      isClosed: false,
    })),
    crossesMidnight: false,
    exceptions: [],
    ramadan: [],
  },
  parkingNotes: 'Fixture parking note',
  directionsNotes: null,
  catalogue: {
    currency: 'AED',
    vatInclusive: true,
    pricePointCount: 32,
    services: Array.from({ length: 8 }, (_, index) => ({
      style: 'asian',
      treatmentKey: `key-${index}`,
      slug: `slug-${index}`,
      name: `Fixture Massage ${index}`,
      variants: [{ durationMinutes: 60, grossFils: '25000', grossAed: '250.00' }],
    })),
    onRequest: [],
  },
  provisional: [],
  unanswered: [],
  schemaVersion: 1,
  generatedAt: '2026-09-19T00:00:00.000Z',
  canonicalUrl: 'https://example.test/',
} as unknown as Facts

const LOCALES = [
  { locale: 'en' as const, copy: CONTENT_COPY_EN },
  { locale: 'ar' as const, copy: CONTENT_COPY_AR },
]

/** A Lexical value with a nested inline node, which is the shape the flattener has to walk. */
const RICH_TEXT = {
  root: {
    type: 'root',
    children: [
      {
        type: 'paragraph',
        children: [
          { type: 'text', text: 'The desk ' },
          { type: 'link', children: [{ type: 'text', text: 'takes your booking' }] },
          { type: 'text', text: '.' },
        ],
      },
      { type: 'paragraph', children: [{ type: 'text', text: 'Second paragraph.' }] },
      { type: 'paragraph', children: [{ type: 'text', text: '   ' }] },
    ],
  },
}

describe('the rich-text flattener finds the text, because the lint reads its output', () => {
  it('walks nested nodes and keeps paragraphs apart', () => {
    expect(richTextParagraphs(RICH_TEXT)).toEqual([
      'The desk takes your booking.',
      'Second paragraph.',
    ])
    // Separated by a blank line, and that matters for one specific reason: `lexiconTokens` splits on every
    // non-alphanumeric character, so joining with nothing would fuse "booking" and "Second" into a token
    // neither of them is — and a banned term spanning the join would be invisible to the lint.
    expect(richTextToPlainText(RICH_TEXT)).toBe('The desk takes your booking.\n\nSecond paragraph.')
  })

  it('returns nothing for a value that is not a tree, rather than throwing inside a page render', () => {
    for (const value of [null, undefined, 'a string', 42, {}, { root: null }, { root: {} }]) {
      expect(richTextParagraphs(value), String(value)).toEqual([])
      expect(richTextToPlainText(value), String(value)).toBe('')
    }
  })

  it('is not vacuous: a value with text really does produce text', () => {
    // The control on every assertion above. A flattener that always returned '' would satisfy the lint on
    // every document ever published, which is the worst available failure in this unit.
    expect(richTextToPlainText(RICH_TEXT).length).toBeGreaterThan(20)
  })
})

describe('acceptance — every heading is question-shaped, stably anchored and identically anchored in both locales', () => {
  const pages = [
    { id: 'spa', keys: SPA_QUESTIONS, of: spaSections },
    { id: 'contact', keys: CONTACT_QUESTIONS, of: contactSections },
    { id: 'about', keys: ABOUT_QUESTIONS, of: aboutSections },
  ] as const

  it('carries one section per declared question, in order, in both locales', () => {
    for (const page of pages) {
      for (const { locale, copy } of LOCALES) {
        const sections = page.of(copy, { facts: FACTS, locale })
        expect(
          sections.map((section) => section.id),
          `${page.id}/${locale}`,
        ).toEqual([...page.keys])
      }
    }
  })

  it('ends every question with a question mark, in either script', () => {
    for (const page of pages) {
      for (const { locale, copy } of LOCALES) {
        for (const section of page.of(copy, { facts: FACTS, locale })) {
          expect(section.question, `${page.id}/${locale}/${section.id}`).toMatch(/[?؟]$/)
          // And the answer is not empty, which is what makes the `<p>` under the heading an answer.
          expect(
            section.answer.trim().length,
            `${page.id}/${locale}/${section.id}`,
          ).toBeGreaterThan(10)
        }
      }
    }
  })

  it('translates the questions but not the anchors', () => {
    // The whole point of deriving the id from the key: `/ar/spa#where-do-i-park` and `/spa#where-do-i-park`
    // are the same anchor on two documents, so a citation survives the language.
    for (const page of pages) {
      const english = page.of(CONTENT_COPY_EN, { facts: FACTS, locale: 'en' })
      const arabic = page.of(CONTENT_COPY_AR, { facts: FACTS, locale: 'ar' })
      expect(arabic.map((section) => section.id)).toEqual(english.map((section) => section.id))
      // The control: the questions themselves differ, or this is one document served twice.
      expect(arabic.map((section) => section.question)).not.toEqual(
        english.map((section) => section.question),
      )
    }
  })

  it('anchors every id as a usable URL fragment', () => {
    for (const page of pages) {
      for (const section of page.of(CONTENT_COPY_EN, { facts: FACTS, locale: 'en' })) {
        expect(section.id, section.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
      }
    }
  })

  it('answers the journal questions from the posts it was given', () => {
    for (const { locale, copy } of LOCALES) {
      const empty = journalSections(copy, { facts: FACTS, locale, posts: [] })
      expect(empty.map((section) => section.id)).toEqual([...JOURNAL_QUESTIONS])
      const withPost = journalSections(copy, {
        facts: FACTS,
        locale,
        posts: [post({ title: 'A post' })],
      })
      // The count is the posts', so the page cannot claim an empty journal while listing one.
      expect(withPost[0]?.answer).not.toBe(empty[0]?.answer)
    }
  })
})

describe('acceptance — the FAQ page and its schema block are built from the same rows', () => {
  const entries: readonly FaqEntry[] = [
    { question: 'Do I need to book ahead?', answer: 'Not always.', topic: 'booking' },
    { question: 'Is there parking?', answer: 'Yes.', topic: 'visiting' },
    // Dropped by both: a blank answer is a half-finished draft, and an `Answer` with no text is the one a
    // consumer quotes as the answer.
    { question: 'Unfinished?', answer: '   ', topic: 'visiting' },
    { question: '   ', answer: 'An answer with no question.', topic: 'visiting' },
  ]

  it('renders one heading per publishable entry, in order, and drops the same ones the node drops', () => {
    const sections = faqSections(entries)
    const publishable = publishableFaqEntries(entries)
    // The questions first, deliberately: a failure here names the entry that drifted ("Unfinished?"), where a
    // length assertion first would report 4 against 2 and leave the reader to work out which two.
    expect(sections.map((section) => section.question)).toEqual(
      publishable.map((entry) => entry.question),
    )
    expect(sections.map((section) => section.answer)).toEqual(
      publishable.map((entry) => entry.answer.trim()),
    )
    // `faqPageNode` applies the same filter, so the page and the schema block cannot differ in count. Both
    // numbers are asserted: the literal, so a fixture that lost an entry cannot pass, and the equality.
    expect(sections).toHaveLength(2)
    expect(sections).toHaveLength(publishable.length)
  })

  it('anchors a question by its slug, and falls back to its position when it has no slug', () => {
    expect(faqAnchorId('Do I need to book ahead?', 0)).toBe('do-i-need-to-book-ahead')
    // An Arabic-script question slugifies to the empty string, which is a fragment no browser resolves. The
    // position is the fallback, and it is stated rather than thrown: an editor writing in Arabic must not be
    // able to make the page fail to render.
    expect(faqAnchorId('هل أحتاج إلى حجز مسبق؟', 3)).toBe('faq-4')
    expect(faqAnchorId('!!!', 0)).toBe('faq-1')
  })

  it('renders nothing for no rows, which is what makes an empty FAQPage node impossible', () => {
    expect(faqSections([])).toEqual([])
    expect(publishableFaqEntries([])).toEqual([])
  })
})

describe('the site navigation has a label for every page it offers', () => {
  it('is total over the nav ids, in both locales', () => {
    for (const { locale, copy } of LOCALES) {
      const labels = navLabels(copy)
      for (const id of NAV_ROUTE_IDS) {
        expect(labels[id], `${locale}/${id}`).toBeDefined()
        expect(labels[id]?.trim().length, `${locale}/${id}`).toBeGreaterThan(0)
      }
      // Distinct, or two pages are offered under one word and a reader cannot tell them apart.
      expect(new Set(Object.values(labels)).size, locale).toBe(NAV_ROUTE_IDS.length)
    }
  })

  it('does not label an Arabic page in English', () => {
    // The control the copy module's own header asks for: a label added to one locale and forgotten in the
    // other renders English on the Arabic document, which no reviewer reading English would notice.
    const english = navLabels(CONTENT_COPY_EN)
    const arabic = navLabels(CONTENT_COPY_AR)
    for (const id of NAV_ROUTE_IDS) expect(arabic[id], id).not.toBe(english[id])
  })
})

describe('the medical-disclaimer pattern is required by the copy, not only by the checkbox', () => {
  it('reports a page health-adjacent when a post mentions pain, undeclared', () => {
    expect(anyHealthAdjacent([post({ bodyText: 'A note on lower back pain.' })])).toBe(true)
    expect(anyHealthAdjacent([post({ healthTopicDeclared: true })])).toBe(true)
    // The control: an ordinary post does not require the disclaimer, or the pattern would appear on every
    // page and mean nothing.
    expect(anyHealthAdjacent([post({})])).toBe(false)
    expect(anyHealthAdjacent([])).toBe(false)
  })
})

describe('the facts helpers read the row and nothing else', () => {
  it('joins the area aliases with the locale’s own conjunction', () => {
    expect(areaPhrase(FACTS, 'and')).toBe('Fixture Area (Alias One and Alias Two)')
    expect(areaPhrase(FACTS, 'و')).toContain('و')
    // No aliases: the area alone, not an empty bracket.
    const bare = { ...FACTS, address: { ...FACTS.address, areaAliases: [] } } as Facts
    expect(areaPhrase(bare, 'and')).toBe('Fixture Area')
  })

  it('lists the building parts the row holds, and none it does not', () => {
    expect(buildingParts(FACTS)).toEqual(['Fixture Block', 'Fixture Floor'])
    const bare = { ...FACTS, address: { ...FACTS.address, line2: null, floor: null } } as Facts
    expect(buildingParts(bare)).toEqual([])
  })

  it('finds an editorial page by slug, and undefined for one nobody has written', () => {
    const page = {
      slug: 'about',
      title: 'About',
      lede: null,
      paragraphs: ['One.'],
      bodyText: 'One.',
      seoTitle: null,
      seoDescription: null,
    }
    expect(editorialPageFor([page], 'about')).toBe(page)
    expect(editorialPageFor([page], 'terms')).toBeUndefined()
    expect(editorialPageFor([], 'about')).toBeUndefined()
  })

  it('collects every string a page renders, and drops the blanks', () => {
    const strings = renderedStrings({
      title: 'Title',
      lede: 'Lede',
      sections: spaSections(CONTENT_COPY_EN, { facts: FACTS, locale: 'en' }),
      extra: ['', '   ', 'Extra'],
    })
    expect(strings).toContain('Title')
    expect(strings).toContain('Extra')
    expect(strings.every((value) => value.trim() !== '')).toBe(true)
    // Both halves of every section, because a claim in a heading is the one most likely to be quoted.
    expect(strings).toContain(CONTENT_COPY_EN.spa.questions['where-do-i-park'])
    expect(strings).toContain(FACTS.parkingNotes)
  })
})

/** A publishable post with the fields a case does not care about filled in. */
function post(partial: Partial<JournalPost>): JournalPost {
  return {
    slug: 'a-post',
    title: 'A post',
    standfirst: null,
    bodyText: 'The desk takes your booking.',
    paragraphs: ['The desk takes your booking.'],
    byline: 'Author 01',
    reviewedBy: 'Reviewer 01',
    publishedOn: '2026-09-19',
    healthTopicDeclared: false,
    ...partial,
  }
}
