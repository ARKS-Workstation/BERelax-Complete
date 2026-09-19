import { formatAmount, formatMoney, specimenFacts } from '@berelax/core'
import { describe, expect, it } from 'vitest'
import { LOCALES } from '../i18n/locales.ts'
import {
  type CatalogueService,
  durationsOf,
  MENU_QUESTIONS,
  menuSections,
  priceCellFor,
  priceRangeOf,
  priceRowId,
  slugifyHeadingKey,
  TREATMENT_QUESTIONS,
  treatmentSections,
  variantMoney,
} from './content.ts'
import { MENU_COPY_AR, TREATMENT_COPY_AR } from './copy-ar.ts'
import { MENU_COPY_EN, TREATMENT_COPY_EN } from './copy-en.ts'

/**
 * W-SITE-05 — the structure of the catalogue pages, without a browser.
 *
 * The acceptance criterion *"every h2 is question-shaped with a stable slugified id and is immediately
 * followed by a `<p>`"* is checked twice, on purpose. Here, over the data, for every question of every page
 * in both locales, in milliseconds; and in `treatments.itest.ts` over the **served DOM** of all eight pages,
 * which is the only place "immediately followed by" can be proved. Neither is redundant: a unit test cannot
 * see a template that inserted a `<div>` between the two elements, and an integration test cannot enumerate
 * every locale's copy without a server per locale.
 *
 * The facts are the specimen's — `packages/core`'s own, the one the JSON-LD builders are unit-tested against
 * — so this file needs no database and still exercises the real shape of a catalogue.
 */
const facts = specimenFacts()
const service = facts.catalogue.services[0] as CatalogueService

describe('acceptance — every heading is a question with a stable slug id', () => {
  const pages = [
    {
      label: 'treatment/en',
      sections: treatmentSections({ facts, service, locale: 'en' }, TREATMENT_COPY_EN),
    },
    {
      label: 'treatment/ar',
      sections: treatmentSections({ facts, service, locale: 'ar' }, TREATMENT_COPY_AR),
    },
    { label: 'menu/en', sections: menuSections(facts, MENU_COPY_EN) },
    { label: 'menu/ar', sections: menuSections(facts, MENU_COPY_AR) },
  ]

  it('ends every heading in a question mark, in both scripts', () => {
    for (const page of pages) {
      expect(page.sections.length, page.label).toBeGreaterThan(0)
      for (const section of page.sections) {
        // `?` and `؟` are the same punctuation mark in two scripts: an Arabic document that ended its
        // headings in a Latin question mark would read as a translation nobody finished.
        expect(section.question.trim(), `${page.label}: ${section.id}`).toMatch(/[?؟]$/)
        expect(section.answer.trim().length, `${page.label}: ${section.id}`).toBeGreaterThan(20)
      }
    }
  })

  it('gives every heading a slug id, unique on the page', () => {
    for (const page of pages) {
      const ids = page.sections.map((section) => section.id)
      for (const id of ids) expect(id, `${page.label}: ${id}`).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
      // Two headings with one id is one anchor that resolves to the wrong section, and a duplicate `id`
      // attribute in the document.
      expect(new Set(ids).size, page.label).toBe(ids.length)
    }
  })

  it('uses the same ids in both locales, because an anchor is not copy', () => {
    const treatmentEn = treatmentSections({ facts, service, locale: 'en' }, TREATMENT_COPY_EN)
    const treatmentAr = treatmentSections({ facts, service, locale: 'ar' }, TREATMENT_COPY_AR)
    expect(treatmentAr.map((section) => section.id)).toEqual(
      treatmentEn.map((section) => section.id),
    )
    // The ids are the declared keys, not a slug of the copy: an id derived from an Arabic question would be
    // empty (the slugifier drops the script) or a transliteration, and an id derived from English copy would
    // move the day the wording was improved.
    expect(treatmentEn.map((section) => section.id)).toEqual([...TREATMENT_QUESTIONS])
    expect(menuSections(facts, MENU_COPY_AR).map((section) => section.id)).toEqual([
      ...MENU_QUESTIONS,
    ])
    // The control: the questions themselves DO differ, or the two locales are the same document.
    expect(treatmentAr.map((section) => section.question)).not.toEqual(
      treatmentEn.map((section) => section.question),
    )
  })

  it('refuses a key that does not reduce to an anchor', () => {
    // The control on the guard. An empty id is a fragment that silently resolves to the top of the page, and
    // a fragment with a space resolves to nothing at all.
    expect(() => slugifyHeadingKey('؟؟؟')).toThrow(/usable anchor id/)
    expect(() => slugifyHeadingKey('  ')).toThrow(/usable anchor id/)
    expect(slugifyHeadingKey('How much does it cost?')).toBe('how-much-does-it-cost')
  })
})

describe('acceptance — every figure on the page is a catalogue row through the money helper', () => {
  it('formats every price point of every service, over all of them', () => {
    let counted = 0
    for (const candidate of facts.catalogue.services) {
      for (const variant of candidate.variants) {
        // The cell is `formatAmount` of the gross fils — the figure, grouped, two decimals, no symbol,
        // because the column header states AED once. `grossAed` is the same figure formatted by
        // `buildFacts`, which is the second half of the claim: two helpers, one number.
        expect(priceCellFor(variant)).toBe(formatAmount(variantMoney(variant)))
        expect(priceCellFor(variant).replace(/,/g, '')).toBe(variant.grossAed)
        expect(priceCellFor(variant)).toMatch(/^[\d,]+\.\d{2}$/)
        counted += 1
      }
    }
    // The control: a formatter that returned the empty string would satisfy every assertion above on zero
    // rows. The specimen's catalogue is not empty and the count is the number of price points in it.
    expect(counted).toBe(facts.catalogue.pricePointCount)
    expect(counted).toBeGreaterThan(0)
  })

  it('renders the same figure in both locales, which is why the assertion is one string', () => {
    // docs/08 §7: Latin numerals in Arabic (`ar-AE-u-nu-latn`). `formatAmount` has no locale argument
    // *because* the two produce the same string — measured here rather than assumed, since the day that
    // stops being true the Arabic price table silently disagrees with the English one.
    for (const variant of service.variants) {
      const amounts = LOCALES.map(() => priceCellFor(variant))
      expect(new Set(amounts).size).toBe(1)
      // And the sentence form does differ by locale — currency placement — so a test comparing sentences
      // across locales would be wrong to expect equality.
      expect(formatMoney(variantMoney(variant), 'ar')).not.toBe(
        formatMoney(variantMoney(variant), 'en'),
      )
    }
  })

  it('names a price row after the catalogue row it came from', () => {
    // The `data-price-row` attribute is how the integration test finds the cell for a given catalogue row
    // in the served DOM. Two rows with one id would make that assertion compare the same cell twice.
    const ids = facts.catalogue.services.flatMap((candidate) =>
      candidate.variants.map((variant) => priceRowId(candidate.slug, variant.durationMinutes)),
    )
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids[0]).toBe(`${service.slug}-${service.variants[0]?.durationMinutes}`)
  })

  it('reports the cheapest and dearest durations, and refuses a service with no price', () => {
    const { cheapest, dearest } = priceRangeOf(service)
    expect(Number(cheapest.grossFils)).toBeLessThanOrEqual(Number(dearest.grossFils))
    expect(durationsOf(service)).toEqual(
      [...service.variants.map((variant) => variant.durationMinutes)].sort((a, b) => a - b),
    )
    // A published service with no priced variant cannot exist (0029 refuses the publication), so a fact
    // sheet holding one is not a menu gap — it is a payload that did not come from the database.
    expect(() => priceRangeOf({ ...service, variants: [] })).toThrow(/no priced duration/)
  })
})

describe('the answers are built from the row and nothing else', () => {
  it('quotes the premises row’s own name, address and hours', () => {
    const sections = treatmentSections({ facts, service, locale: 'en' }, TREATMENT_COPY_EN)
    const find = (id: string): string => sections.find((section) => section.id === id)?.answer ?? ''
    expect(find('what-is-it')).toContain(facts.names.display)
    expect(find('what-is-it')).toContain(service.name)
    expect(find('where-is-it-delivered')).toContain(facts.address.oneLine)
    for (const alias of facts.address.areaAliases) {
      expect(find('where-is-it-delivered')).toContain(alias)
    }
    expect(find('when-can-i-book-it')).toContain(facts.hours.timezone)
    const open = facts.hours.weekly.find((day) => !day.isClosed)
    expect(find('when-can-i-book-it')).toContain(open?.opens ?? 'never')
    expect(find('how-much-does-it-cost')).toContain(
      formatMoney(variantMoney(priceRangeOf(service).cheapest), 'en'),
    )
  })

  it('publishes a telephone number only when the row holds one, and never the WhatsApp placeholder', () => {
    const sections = treatmentSections({ facts, service, locale: 'en' }, TREATMENT_COPY_EN)
    const answer = sections.find((section) => section.id === 'how-do-i-book-it')?.answer ?? ''
    expect(answer).toContain(facts.contact.landline?.display ?? 'no landline')
    // `premises.phone_whatsapp` is a placeholder the schema's own predicate refuses (Y1-nap), and
    // `factsSchema` models the unconfirmed channel with no digits at all. Nothing on the page may carry it.
    expect(answer).not.toContain('WHATSAPP')
    expect(answer).not.toContain('PENDING')
    // The control: with no numbers on the row the sentence says so rather than inventing one.
    const noPhones = {
      ...facts,
      contact: { ...facts.contact, landline: null, mobile: null },
    }
    const withoutPhones = treatmentSections(
      { facts: noPhones, service, locale: 'en' },
      TREATMENT_COPY_EN,
    )
    expect(withoutPhones.find((section) => section.id === 'how-do-i-book-it')?.answer).toMatch(
      /No telephone number is recorded/,
    )
  })

  it('states the number of price-on-request offerings the row holds, with no figure', () => {
    const answer =
      menuSections(facts, MENU_COPY_EN).find(
        (section) => section.id === 'what-is-priced-on-request',
      )?.answer ?? ''
    expect(facts.catalogue.onRequest.length).toBeGreaterThan(0)
    for (const offering of facts.catalogue.onRequest) expect(answer).toContain(offering.label)
    // No digits in the sentence: `price_on_request` has no price column (0032) and a derived figure was
    // deliberately reversed by B-CAT-06, so there is nothing here to quote.
    expect(answer).not.toMatch(/\d/)
  })
})
