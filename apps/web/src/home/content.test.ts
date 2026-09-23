import { assertCmsCopyCompliant, type CmsCopy } from '@berelax/cms'
import type { CompliancePolicy } from '@berelax/core'
import type { Facts } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import { revalidationPathsFor } from '../revalidate/catalogue.ts'
import { CONTENT_ROUTES_BY_KIND } from '../revalidate/content.ts'
import {
  formatHomeBudgetFindings,
  HOME_BUDGET,
  HOME_BUDGET_METRICS,
  type HomeBudgetMeasurement,
  homeBudgetLimit,
  judgeHomeBudget,
} from './budget.ts'
import {
  aggregateRatingMarkersIn,
  bookActionFor,
  brandAndLocality,
  businessNames,
  HOME_SECTIONS,
  homeAnchor,
  homeRenderedStrings,
  menuSize,
  NO_THERAPIST_ROUTE,
  PLACEHOLDER_TESTIMONIAL_MARKERS,
  placeholderMarkersIn,
  reviewSection,
  type TherapistRow,
  therapistCardFor,
  therapistCardsFor,
  treatmentCardsFor,
} from './content.ts'
import { HOME_COPY_AR } from './copy-ar.ts'
import { HOME_COPY_EN } from './copy-en.ts'

/**
 * The half of W-SITE-04 that is decidable without a browser.
 *
 * Three of this unit's criteria are about values rather than pixels — the section order and the anchor ids,
 * which cards carry a link, and that no testimonial reaches a page without a record behind it — and each of
 * them is asserted here **in both directions**. The browser half is `apps/web/src/home.itest.ts`.
 *
 * Every case below pairs its assertion with a control that must fail, which is brief rule 3: a scan for
 * placeholder strings that matched nothing would pass on every page ever written, and a guard that refuses a
 * link is indistinguishable from a function that never returns one.
 */

/** Enough of a fact sheet for the pure functions. Not a fixture of the real business; see each field. */
const FACTS = {
  names: { legal: 'Legal Name LLC', trading: 'Trading Name', display: 'Display Name' },
  address: {
    line1: 'Line one',
    line2: null,
    floor: null,
    area: 'Area',
    areaAliases: ['Alias One', 'Alias Two'],
    emirate: 'Emirate',
    countryCode: 'AE',
    poBox: null,
    makaniNumber: null,
    oneLine: 'Line one, Area, Emirate',
  },
  contact: {
    landline: { e164: '+97120000000', display: '02 000 0000' },
    mobile: { e164: '+97150000000', display: '050 000 0000' },
    whatsapp: { status: 'unconfirmed', provisional: true, openQuestionId: 'Y1-nap', number: null },
    email: null,
  },
  catalogue: {
    currency: 'AED',
    vatInclusive: true,
    pricePointCount: 8,
    services: [
      {
        style: 'asian',
        treatmentKey: 'normal',
        slug: 'first-massage',
        name: 'First Massage',
        variants: [
          { durationMinutes: 60, grossFils: '20000', grossAed: '200.00' },
          { durationMinutes: 90, grossFils: '30000', grossAed: '300.00' },
        ],
      },
      {
        style: 'arabic',
        treatmentKey: 'bath',
        slug: 'second-massage',
        name: 'Second Massage',
        variants: [
          { durationMinutes: 60, grossFils: '20000', grossAed: '200.00' },
          { durationMinutes: 90, grossFils: '30000', grossAed: '300.00' },
        ],
      },
    ],
    onRequest: [],
  },
} as unknown as Facts

const UNPUBLISHABLE: TherapistRow = {
  staffReference: 'Therapist 01',
  displayName: null,
  isPublishable: false,
  skills: ['asian_style'],
}

/**
 * A row that HAS passed the guard.
 *
 * Not a name of a person: brief rule 10, and `packages/fixtures/src/synthetic.ts` exists because a plausible
 * name in a fixture eventually gets treated as one. It is the string `Published Display Name`, which no admin
 * would ever set, and it is here only to make the publishable branch reachable.
 */
const PUBLISHABLE: TherapistRow = {
  staffReference: 'Therapist 02',
  displayName: 'Published Display Name',
  isPublishable: true,
  skills: ['arabic_style'],
}

const skillLabel = (skills: readonly string[]): string | undefined =>
  skills.length === 0 ? undefined : skills.join(', ')

describe('acceptance — the sections render in the prototype’s order with stable anchor ids', () => {
  it('is exactly the six ids the criterion names, in the prototype’s order', () => {
    expect([...HOME_SECTIONS]).toEqual([
      'about',
      'services',
      'team',
      'gallery',
      'reviews',
      'contact',
    ])
  })

  it('turns each id into the fragment a link carries', () => {
    expect(HOME_SECTIONS.map(homeAnchor)).toEqual([
      '#about',
      '#services',
      '#team',
      '#gallery',
      '#reviews',
      '#contact',
    ])
  })

  it('has a heading and a lede for every id in both locales', () => {
    // Total over the union at the type level, so this is the runtime half: a copy object built by spreading
    // another one could satisfy the type with an empty string, and an empty heading is an anchor a reader
    // cannot see.
    for (const copy of [HOME_COPY_EN, HOME_COPY_AR]) {
      for (const id of HOME_SECTIONS) {
        expect(copy.sections[id].heading.trim(), id).not.toBe('')
        expect(copy.sections[id].lede.trim(), id).not.toBe('')
      }
    }
  })

  it('names the same set of sections in both locales', () => {
    expect(Object.keys(HOME_COPY_AR.sections).sort()).toEqual(
      Object.keys(HOME_COPY_EN.sections).sort(),
    )
  })
})

describe('acceptance — every treatment card links to a real route', () => {
  it('builds one card per published service, with the path the caller resolves', () => {
    const cards = treatmentCardsFor(
      FACTS,
      (minutes) => `${minutes} minutes`,
      (slug) => `/treatments/${slug}`,
    )
    expect(cards.map((card) => card.href)).toEqual([
      '/treatments/first-massage',
      '/treatments/second-massage',
    ])
    expect(cards.map((card) => card.name)).toEqual(['First Massage', 'Second Massage'])
    expect(cards[0]?.durations).toEqual(['60 minutes', '90 minutes'])
  })

  it('carries no price on any card', () => {
    // The decision, asserted: a "from" figure here would be a fifth rendering of a row whose only purpose is
    // to be compared with the four on the page it links to. Every gross amount in the fixture, in both its
    // spellings, must be absent from the whole card.
    const cards = treatmentCardsFor(
      FACTS,
      (minutes) => `${minutes} minutes`,
      (slug) => `/treatments/${slug}`,
    )
    const rendered = JSON.stringify(cards)
    for (const service of FACTS.catalogue.services) {
      for (const variant of service.variants) {
        expect(rendered, variant.grossAed).not.toContain(variant.grossAed)
        expect(rendered, variant.grossFils).not.toContain(variant.grossFils)
      }
    }
    // The control on that scan: the duration figures ARE there, so "contains no number" is not what passed.
    expect(rendered).toContain('60 minutes')
  })

  it('takes the locale’s path from the caller rather than building one', () => {
    // The Arabic prefix is what gets forgotten in a second spelling of `/treatments/<slug>`, so the resolver
    // is injected. This is the assertion that it really is: the same rows, a different resolver, different
    // hrefs, and no `/treatments` literal anywhere in the output.
    const arabic = treatmentCardsFor(
      FACTS,
      (minutes) => `${minutes} د`,
      (slug) => `/ar/treatments/${slug}`,
    )
    expect(arabic.map((card) => card.href)).toEqual([
      '/ar/treatments/first-massage',
      '/ar/treatments/second-massage',
    ])
  })
})

describe('acceptance — an unconsented therapist card carries no link', () => {
  it('gives an unpublishable row no href and no display name', () => {
    const card = therapistCardFor(UNPUBLISHABLE, () => '/therapists/anything', skillLabel)
    expect(card.href).toBeUndefined()
    expect(card.displayName).toBeUndefined()
    expect(card.reference).toBe('Therapist 01')
    expect(card.qualifications).toBe('asian_style')
  })

  it('gives a publishable row the href the resolver returns — the control', () => {
    // Without this the assertion above would pass for a function that never returns an href at all, which is
    // ADR 0003's failure mode: the guard and a bug are indistinguishable from one direction.
    const card = therapistCardFor(
      PUBLISHABLE,
      (row) => `/therapists/${row.staffReference}`,
      skillLabel,
    )
    expect(card.href).toBe('/therapists/Therapist 02')
    expect(card.displayName).toBe('Published Display Name')
  })

  it('still gives a publishable row no href when no therapist route exists', () => {
    // The state the site is actually in, and it is two independent reasons rather than one. `/therapists/[slug]`
    // is W-SITE-06's route: the registry is in exact bijection with the filesystem, so it cannot be declared
    // before it is written, and a hand-built path would be a link to a 404.
    expect(therapistCardFor(PUBLISHABLE, NO_THERAPIST_ROUTE, skillLabel).href).toBeUndefined()
  })

  it('maps a whole roster in order, and none of the real rows is linked', () => {
    const cards = therapistCardsFor([UNPUBLISHABLE, PUBLISHABLE], NO_THERAPIST_ROUTE, skillLabel)
    expect(cards.map((card) => card.reference)).toEqual(['Therapist 01', 'Therapist 02'])
    expect(cards.filter((card) => card.href !== undefined)).toEqual([])
  })

  it('never renders a display name a row has while the guard is false', () => {
    // The row shape 0050 makes impossible in the database — `is_publishable` is GENERATED — reaching this
    // function anyway, which is what a restored dump or a `psql` session could produce. The name must not
    // render, because the consent is what it is waiting on and not the column.
    const named: TherapistRow = { ...PUBLISHABLE, isPublishable: false }
    const card = therapistCardFor(named, NO_THERAPIST_ROUTE, skillLabel)
    expect(card.displayName).toBeUndefined()
    expect(card.href).toBeUndefined()
  })
})

describe('acceptance — no testimonial without a review record, and no rating markup', () => {
  it('renders the empty state when there are no records', () => {
    const section = reviewSection([])
    expect(section.isEmpty).toBe(true)
    expect(section.cards).toEqual([])
  })

  it('maps every card to the record behind it — the control on the empty case', () => {
    const section = reviewSection([
      {
        id: 'row-1',
        googleReviewId: 'g-1',
        rating: 5,
        commentText: '  Very clean and quiet.  ',
        reviewerDisplayName: 'A Google user',
      },
    ])
    expect(section.isEmpty).toBe(false)
    expect(section.cards).toEqual([
      {
        id: 'row-1',
        googleReviewId: 'g-1',
        rating: 5,
        quote: 'Very clean and quiet.',
        attribution: 'A Google user',
      },
    ])
  })

  it('cannot produce a card that is not one of the rows', () => {
    // The structural guarantee, stated as a property over an arbitrary row set: the quotes the section renders
    // are exactly the rows' comment texts, so a testimonial with no record has no route onto the page.
    const rows = [1, 2, 3].map((n) => ({
      id: `row-${n}`,
      googleReviewId: `g-${n}`,
      rating: 4,
      commentText: `Comment ${n}`,
      reviewerDisplayName: `Reviewer ${n}`,
    }))
    expect(reviewSection(rows).cards.map((card) => card.quote)).toEqual([
      'Comment 1',
      'Comment 2',
      'Comment 3',
    ])
  })

  it('finds a placeholder marker in text that contains one, in any case', () => {
    for (const marker of PLACEHOLDER_TESTIMONIAL_MARKERS) {
      expect(placeholderMarkersIn(`before ${marker.text} after`), marker.text).toHaveLength(1)
      expect(
        placeholderMarkersIn(`BEFORE ${marker.text.toUpperCase()} AFTER`),
        marker.text,
      ).toHaveLength(1)
    }
  })

  it('finds none in copy that is real, and says which kind each marker is', () => {
    const real = JSON.stringify([HOME_COPY_EN, HOME_COPY_AR])
    expect(placeholderMarkersIn(real)).toEqual([])
    // The provenance is part of the list rather than a comment beside it: exactly one entry claims to be
    // prototype copy, and it is the one docs/13 §6 quotes verbatim. The rest are shapes, and labelling them
    // is what stops the list being read later as a transcription of the prototype.
    const prototype = PLACEHOLDER_TESTIMONIAL_MARKERS.filter(
      (marker) => marker.kind === 'prototype',
    )
    expect(prototype).toHaveLength(1)
    expect(prototype[0]?.text).toBe('swap in your real Google reviews before publishing')
    for (const marker of PLACEHOLDER_TESTIMONIAL_MARKERS) {
      expect(marker.source.trim(), marker.text).not.toBe('')
    }
  })

  it('finds every rating spelling, and none in the real copy', () => {
    expect(aggregateRatingMarkersIn('"@type":"AggregateRating"')).toContain('AggregateRating')
    expect(aggregateRatingMarkersIn('{"ratingValue":"4.9"}')).toContain('ratingValue')
    expect(aggregateRatingMarkersIn(JSON.stringify([HOME_COPY_EN, HOME_COPY_AR]))).toEqual([])
  })
})

describe('the brand and the locality, from the rows', () => {
  it('pairs the display name with the district and its aliases', () => {
    expect(brandAndLocality(FACTS, 'and')).toBe(
      'Display Name, Area (Alias One and Alias Two), Emirate',
    )
    // The Arabic conjunction, because the aliases are joined with a word and that word is translated.
    expect(brandAndLocality(FACTS, 'و')).toContain('Alias One و Alias Two')
  })

  it('publishes both names when they differ, and one when they do not', () => {
    expect(businessNames(FACTS)).toEqual(['Trading Name', 'Legal Name LLC'])
    const same = {
      ...FACTS,
      names: { ...FACTS.names, legal: 'Trading Name', trading: 'Trading Name' },
    } as Facts
    expect(businessNames(same)).toEqual(['Trading Name'])
  })

  it('counts the menu rather than stating it', () => {
    expect(menuSize(FACTS)).toEqual({ services: 2, pricePoints: 8 })
  })

  it('dials the row’s own number, and is absent when there is none', () => {
    expect(bookActionFor(FACTS)).toEqual({ href: 'tel:+97120000000', telephone: '02 000 0000' })
    const noPhones = {
      ...FACTS,
      contact: { ...FACTS.contact, landline: null, mobile: null },
    } as Facts
    expect(bookActionFor(noPhones)).toBeNull()
    // The mobile is the fallback, not an alternative: a bar with two numbers on it is a choice nobody wants
    // to make with a thumb.
    const mobileOnly = { ...FACTS, contact: { ...FACTS.contact, landline: null } } as Facts
    expect(bookActionFor(mobileOnly)?.href).toBe('tel:+97150000000')
  })
})

describe('the lint sees every string the page renders', () => {
  it('includes the headings, the ledes, the derived sentences and the catalogue names', () => {
    const strings = homeRenderedStrings(FACTS, HOME_COPY_EN, 19)
    for (const id of HOME_SECTIONS) {
      expect(strings, id).toContain(HOME_COPY_EN.sections[id].heading)
    }
    expect(strings).toContain(brandAndLocality(FACTS, HOME_COPY_EN.labels.and))
    expect(strings).toContain('First Massage — read more')
    expect(strings).toContain(HOME_COPY_EN.labels.rosterSize(19))
    expect(strings.every((value) => value.trim() !== '')).toBe(true)
  })

  it('passes the banned-claims lint in both locales, through the lint itself', () => {
    /*
     * The real function, not a regular expression over the copy.
     *
     * The first version of this case scanned for `\btreatment\b` and missed `treatments`, which is how a gate
     * fixture that put "Our treatments" in a heading passed a test written to refuse exactly that. The lint
     * does not have that gap: `tokenMatches` in `@berelax/core`'s lexicon matches the plural, the `-es` form
     * and the `-ing` form of every term, because the failure it is about is a claim and not a spelling. So
     * this calls `assertCmsCopyCompliant` — the function the two route files call — and the only thing
     * declared here is the seeded term list.
     *
     * The list is migration 0004's, under `licence_class = unconfirmed`. It is stated rather than read,
     * because a unit test has no database; the route's own call reads the row, so the day Y1-licence is
     * answered the page's vocabulary widens without this test having to be told.
     */
    const policy: CompliancePolicy = {
      bannedClaimTerms: [
        'therapeutic',
        'therapy',
        'treatment',
        'pain relief',
        'rehabilitation',
        'cure',
        'heal',
        'medical',
        'clinical',
        'diagnosis',
        'prescribe',
        'physiotherapy',
        'lymphatic drainage',
        'prenatal',
      ],
      permittedPublicTitles: ['Therapist', 'Senior Therapist', 'Spa Therapist'],
      medicalClaimsPermitted: false,
    }
    const copyOf = (copy: typeof HOME_COPY_EN): readonly CmsCopy[] =>
      homeRenderedStrings(FACTS, copy, 19).map((text) => ({ where: 'route/home', text }))
    for (const copy of [HOME_COPY_EN, HOME_COPY_AR]) {
      expect(() => {
        assertCmsCopyCompliant(copyOf(copy), policy)
      }).not.toThrow()
    }
    // The control, in two shapes, because "nothing threw" is what a lint given an empty list also reports.
    // One is a plural, which is the form the first version of this case could not see.
    expect(() => {
      assertCmsCopyCompliant([{ where: 'route/home', text: 'Our treatments' }], policy)
    }).toThrow(/banned_claim_term|treatment/)
    expect(() => {
      assertCmsCopyCompliant([{ where: 'route/home', text: 'A therapeutic massage' }], policy)
    }).toThrow(/banned_claim_term|therapeutic/)
    // And the list the lint was given is not empty, or every call above passed on nothing to compare.
    expect(policy.bannedClaimTerms.length).toBeGreaterThan(10)
  })
})

describe('an ISR home page is in both publish loops', () => {
  it('is revalidated when the premises row changes', () => {
    // The page renders the NAP block, the trading name beside the district and the `LocalBusiness` JSON-LD,
    // all from that one row. W-SITE-02 wrote that cache-tag revalidation "belongs to the first ISR route that
    // renders NAP"; this is the third and the most visited, and without it a corrected telephone number would
    // reach `/contact` and `/spa` and not the page every reader arrives on.
    expect(CONTENT_ROUTES_BY_KIND.premises).toContain('home')
    // And not to the loops it has nothing to do with: nothing on this page comes from an FAQ entry or a post.
    expect(CONTENT_ROUTES_BY_KIND.faq).not.toContain('home')
    expect(CONTENT_ROUTES_BY_KIND.journal).not.toContain('home')
  })

  it('is revalidated when the catalogue changes, in both locales', () => {
    // The treatments overview is one card per published service carrying the service's own name, so a rename
    // or an archival changes what `/` says.
    const paths = revalidationPathsFor({ kind: 'price', slug: 'asian-normal-massage' })
    expect(paths).toContain('/')
    expect(paths).toContain('/ar')
  })
})

describe('acceptance — the home budget fails with the measured value', () => {
  /** Comfortably inside every limit. The control: nothing may fire on this. */
  const INSIDE: HomeBudgetMeasurement = {
    'first-party-js': 40 * 1024,
    css: 16 * 1024,
    'critical-above-fold': 150 * 1024,
    'requests-before-lcp': 6,
    'dom-nodes': 900,
  }

  it('declares docs/08 §8’s five numbers, once each', () => {
    expect(HOME_BUDGET.map((limit) => limit.metric)).toEqual([...HOME_BUDGET_METRICS])
    expect(homeBudgetLimit('first-party-js')).toBe(110 * 1024)
    expect(homeBudgetLimit('css')).toBe(25 * 1024)
    expect(homeBudgetLimit('critical-above-fold')).toBe(250 * 1024)
    expect(homeBudgetLimit('requests-before-lcp')).toBe(8)
    expect(homeBudgetLimit('dom-nodes')).toBe(1500)
    // Every limit carries a reason. A budget with no stated reason gets raised the first time it fails, which
    // is what `scripts/check-budgets.mjs` says makes it decoration.
    for (const limit of HOME_BUDGET) expect(limit.why.trim(), limit.metric).not.toBe('')
  })

  it('finds nothing on a measurement inside every limit', () => {
    expect(formatHomeBudgetFindings(judgeHomeBudget(INSIDE))).toBe('')
  })

  it('treats a measurement exactly at the limit as inside it', () => {
    const exact = Object.fromEntries(
      HOME_BUDGET.map((limit) => [limit.metric, limit.limit]),
    ) as HomeBudgetMeasurement
    expect(judgeHomeBudget(exact)).toEqual([])
  })

  it('fires on an oversized fixture, once per metric, with both numbers', () => {
    // The oversized fixture the criterion asks for: one over each limit, by one unit, so the failure cannot be
    // passing because the numbers are wildly wrong.
    const over = Object.fromEntries(
      HOME_BUDGET.map((limit) => [limit.metric, limit.limit + 1]),
    ) as HomeBudgetMeasurement
    const findings = judgeHomeBudget(over)
    expect(findings.map((finding) => finding.metric)).toEqual([...HOME_BUDGET_METRICS])
    for (const finding of findings) {
      expect(finding.message, finding.metric).toContain('[home-budget-over]')
      // Both numbers, in the message a failing assertion prints. "over budget" sends somebody to build the
      // page twice to find out by how much.
      expect(finding.message, finding.metric).toContain(String(finding.measured))
      expect(finding.message, finding.metric).toContain(String(finding.limit))
    }
    expect(formatHomeBudgetFindings(findings).split('\n')).toHaveLength(HOME_BUDGET.length)
  })

  it('reports every breach rather than the first', () => {
    const two: HomeBudgetMeasurement = {
      ...INSIDE,
      'requests-before-lcp': 20,
      'dom-nodes': 5000,
    }
    expect(judgeHomeBudget(two).map((finding) => finding.metric)).toEqual([
      'requests-before-lcp',
      'dom-nodes',
    ])
  })

  it('throws for a metric nobody declared', () => {
    expect(() => homeBudgetLimit('invented' as never)).toThrow('no home budget declared')
  })
})
