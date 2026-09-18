import type { PremisesFacts } from '@berelax/db'
import { collapseHours } from '@berelax/ui/patterns'
import { describe, expect, it } from 'vitest'
import { buildFacts, factsEtag } from './facts/build.ts'
import { buildLlmsTxt, lintableProse, lintLlmsTxt, publishLlmsTxt } from './facts/llms.ts'
import { AI_CRAWLER_USER_AGENTS, buildRobotsTxt } from './facts/robots.ts'
import { routeByPath } from './routes/registry.ts'

/**
 * W-SITE-02's three machine surfaces, as far as they can be checked without a database.
 *
 * The builders are pure — the clock, the origin and the rows all arrive as arguments — so everything about
 * the *shape* of what is published is decidable here, in milliseconds, on every commit. What is **not**
 * here is every claim about the real business: whether the address in the payload is the address in the
 * row, whether the hours cross midnight, whether the provisional entries match the Unconfirmed Assumptions
 * panel. Those are claims about a database and they live in `apps/web/src/facts.itest.ts`.
 *
 * The fixture below is deliberately **not** this business's NAP. This file is scanned by the grep in
 * `packages/db/src/seed/premises.test.ts` like every other, and although a test file is exempt, a fixture
 * spelling the real street would still be a second copy of it for a reader to find and reuse.
 */

const FIXTURE: PremisesFacts = {
  premises: {
    displayName: 'EXAMPLE - Massage Center and Spa',
    addressLine1: '1 Example Road',
    addressLine2: 'Block Q, Z99',
    floor: 'G-Floor',
    area: 'Example District',
    areaAliases: ['Other Name', 'Third Name'],
    emirate: 'Example Emirate',
    countryCode: 'AE',
    poBox: null,
    makaniNumber: null,
    latitude: null,
    longitude: null,
    plusCode: null,
    googlePlaceId: null,
    phoneLandline: '+97121234567',
    phoneMobile: '+971501234567',
    phoneWhatsapp: 'WHATSAPP-PENDING-Y1-NAP',
    whatsappIsPlaceholder: true,
    email: null,
    parkingNotes: 'Parking at the back',
    directionsNotes: null,
    timezone: 'Asia/Dubai',
  },
  legal: { legalName: 'EXAMPLE SPA - L.L.C', tradingName: 'EXAMPLE - Massage Center and Spa' },
  hours: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
    dayOfWeek,
    openTime: '11:00',
    closeTime: '02:00',
    crossesMidnight: true,
    isClosed: false,
  })),
  exceptions: [],
  prices: [
    {
      style: 'asian',
      treatmentKey: 'normal_massage',
      slug: 'asian-normal-massage',
      publicDisplayName: 'Normal Massage (Asian)',
      durationMinutes: 45,
      grossPriceFils: '17000',
    },
    {
      style: 'asian',
      treatmentKey: 'normal_massage',
      slug: 'asian-normal-massage',
      publicDisplayName: 'Normal Massage (Asian)',
      durationMinutes: 60,
      grossPriceFils: '20000',
    },
    {
      style: 'arabic',
      treatmentKey: 'normal_massage',
      slug: 'arabic-normal-massage',
      publicDisplayName: 'Normal Massage (Arabic)',
      durationMinutes: 60,
      grossPriceFils: '25000',
    },
  ],
  onRequest: [
    {
      menuLabel: 'Couple Massage',
      resourceRequirement: 'two therapists, one double-capacity room, two clients',
      openQuestionId: 'Y9-poa-prices',
      provisionalNote: 'docs/13 section 4 prices this on request; no figure stated',
    },
  ],
}

const OPTIONS = { generatedAt: '2026-09-18T10:00:00.000Z', origin: 'https://example.test' }
const POLICY = {
  // The 0004 defaults, which is the profile in force. `treatment` is on this list, which is why
  // `lintableProse` has to strip URLs before the lint sees `/treatments`.
  bannedClaimTerms: [
    'therapeutic',
    'therapy',
    'treatment',
    'pain relief',
    'cure',
    'heal',
    'medical',
    'clinical',
  ],
  permittedPublicTitles: ['Therapist', 'Senior Therapist', 'Spa Therapist'],
  medicalClaimsPermitted: false,
}

describe('/api/facts publishes the row and derives nothing it cannot', () => {
  const facts = buildFacts(FIXTURE, OPTIONS)

  it('carries the legal name, the trading name and the display name as three fields', () => {
    // Three, because they are three different claims: the legal name goes on a tax invoice, the trading
    // name on a citation, and the display name is what the site calls itself. Collapsing them is how an
    // invoice ends up issued in a brand name.
    expect(facts.names.legal).toBe(FIXTURE.legal?.legalName)
    expect(facts.names.trading).toBe(FIXTURE.legal?.tradingName)
    expect(facts.names.display).toBe(FIXTURE.premises.displayName)
  })

  it('publishes the address in parts and as one line, with the district aliases', () => {
    expect(facts.address.line1).toBe(FIXTURE.premises.addressLine1)
    expect(facts.address.floor).toBe(FIXTURE.premises.floor)
    expect([...facts.address.areaAliases]).toEqual([...FIXTURE.premises.areaAliases])
    expect(facts.address.oneLine).toContain(FIXTURE.premises.addressLine1)
    expect(facts.address.oneLine).toContain(FIXTURE.premises.emirate)
  })

  it('refuses to publish a WhatsApp number while Y1-nap is unanswered', () => {
    // The unit's central decision. Not a number, not one of the two candidates, not both of them: the
    // status, the open question and an explicit null. Publishing either candidate from the one endpoint
    // built to end the divergence would BE the divergence, in machine-readable form.
    expect(facts.contact.whatsapp.status).toBe('unconfirmed')
    expect(facts.contact.whatsapp.provisional).toBe(true)
    if (facts.contact.whatsapp.status !== 'unconfirmed') throw new Error('unreachable')
    expect(facts.contact.whatsapp.number).toBeNull()
    expect(facts.contact.whatsapp.openQuestionId).toBe('Y1-nap')
    // No digits anywhere in the object, which is the property that matters: a consumer that ignores
    // `status` and reads the first string it finds still cannot dial anything.
    expect(JSON.stringify(facts.contact.whatsapp)).not.toMatch(/\d{6}/)
    // And it is listed as provisional, with the stored value quoted, so the panel and the payload agree.
    expect(facts.provisional.map((entry) => entry.field)).toContain('contact.whatsapp')
    expect(
      facts.provisional.find((entry) => entry.field === 'contact.whatsapp')?.openQuestionId,
    ).toBe('Y1-nap')
  })

  it('publishes the two numbers that ARE confirmed, in both forms', () => {
    // The control for the case above: the refusal is specific to the disputed channel, not a blanket. A
    // fact sheet with no phone number at all would satisfy every assertion there.
    expect(facts.contact.landline?.e164).toBe(FIXTURE.premises.phoneLandline)
    expect(facts.contact.landline?.display).toBe('+971 2 123 4567')
    expect(facts.contact.mobile?.display).toBe('+971 50 123 4567')
  })

  it('promotes a confirmed WhatsApp number the moment the column holds one', () => {
    // The other direction, which is what answering Y1-nap looks like: one UPDATE, and the payload changes
    // shape with no code change. Without this the union has only ever been seen in one state.
    const answered = buildFacts(
      {
        ...FIXTURE,
        premises: {
          ...FIXTURE.premises,
          phoneWhatsapp: '+971501234567',
          whatsappIsPlaceholder: false,
        },
      },
      OPTIONS,
    )
    expect(answered.contact.whatsapp).toEqual({
      status: 'confirmed',
      provisional: false,
      e164: '+971501234567',
      display: '+971 50 123 4567',
    })
    expect(answered.provisional.map((entry) => entry.field)).not.toContain('contact.whatsapp')
  })

  it('states the next-day close rather than leaving it to be inferred', () => {
    expect(facts.hours.crossesMidnight).toBe(true)
    for (const day of facts.hours.weekly) expect(day.closesNextDay).toBe(true)
    // Read from the generated column, not recomputed: a fixture whose flag disagrees with its times is
    // published as the database stated it, because the database is the one that decides.
    const flat = buildFacts(
      {
        ...FIXTURE,
        hours: FIXTURE.hours.map((hour) => ({
          ...hour,
          openTime: '09:00',
          closeTime: '17:00',
          crossesMidnight: false,
        })),
      },
      OPTIONS,
    )
    expect(flat.hours.crossesMidnight).toBe(false)
    expect(flat.hours.weekly.every((day) => !day.closesNextDay)).toBe(true)
  })

  it('counts the price points and groups them by service, as decimal strings', () => {
    expect(facts.catalogue.pricePointCount).toBe(FIXTURE.prices.length)
    expect(facts.catalogue.services).toHaveLength(2)
    expect(facts.catalogue.services[0]?.variants.map((variant) => variant.durationMinutes)).toEqual(
      [45, 60],
    )
    expect(facts.catalogue.services[0]?.variants[1]).toEqual({
      durationMinutes: 60,
      grossFils: '20000',
      grossAed: '200.00',
    })
    expect(facts.catalogue.vatInclusive).toBe(true)
    // Money crosses the wire as digits and as a decimal string, never as a JSON number: `20000` in JSON is
    // a double to most consumers, and this is the endpoint a third party quotes a price from.
    expect(typeof facts.catalogue.services[0]?.variants[1]?.grossFils).toBe('string')
  })

  it('refuses a price that would not survive a round trip through a number', () => {
    // The `fils` domain is bigint and the driver hands it over as a string for exactly this reason. A
    // builder that called `Number()` would publish a rounded price, and nothing downstream would know.
    expect(() =>
      buildFacts(
        {
          ...FIXTURE,
          prices: FIXTURE.prices.map((price) => ({
            ...price,
            grossPriceFils: '90071992547409911',
          })),
        },
        OPTIONS,
      ),
    ).toThrow(/round trip/)
  })

  it('lists the price-on-request offerings as provisional, with no figure', () => {
    expect(facts.catalogue.onRequest).toEqual([
      {
        label: 'Couple Massage',
        requirement: 'two therapists, one double-capacity room, two clients',
        provisional: true,
        openQuestionId: 'Y9-poa-prices',
      },
    ])
    expect(JSON.stringify(facts.catalogue.onRequest)).not.toMatch(/\d{3,}/)
    expect(facts.provisional.map((entry) => entry.openQuestionId)).toContain('Y9-poa-prices')
  })

  it('enumerates what is unanswered instead of leaving a null to be interpreted', () => {
    const fields = facts.unanswered.map((entry) => entry.field)
    for (const field of ['geo.latitude', 'geo.plusCode', 'geo.placeId', 'contact.email']) {
      expect(fields, field).toContain(field)
    }
    // Every entry says what it is waiting on, so the list is actionable rather than a shrug.
    for (const entry of facts.unanswered) expect(entry.why.length).toBeGreaterThan(20)
    // The control: a field that IS known must not be listed as unanswered.
    const located = buildFacts(
      { ...FIXTURE, premises: { ...FIXTURE.premises, latitude: '24.4', longitude: '54.4' } },
      OPTIONS,
    )
    expect(located.unanswered.map((entry) => entry.field)).not.toContain('geo.latitude')
  })

  it('builds a map link and a directions link, and both from the same address', () => {
    // Read back through `URL`, not by string matching: `URLSearchParams` percent-encodes a space as `+`,
    // and a test that asserted `%20` would be asserting the encoder rather than the address.
    expect(new URL(facts.geo.mapUrl).searchParams.get('query')).toBe(facts.address.oneLine)
    expect(new URL(facts.geo.directionsUrl).searchParams.get('destination')).toBe(
      facts.address.oneLine,
    )
    expect(facts.geo.mapUrl).not.toBe(facts.geo.directionsUrl)
  })

  it('refuses to publish anything at all with no legal entity', () => {
    // 0026 seeds the singleton. Absent means a migration did not run, and a fact sheet with no registered
    // name is not a smaller problem than no fact sheet — the legal name is what a citation is checked
    // against.
    expect(() => buildFacts({ ...FIXTURE, legal: null }, OPTIONS)).toThrow(/legal_entity/)
  })
})

describe('the ETag is a hash of the facts, not of the response', () => {
  it('is stable across two builds a second apart', () => {
    // The whole point of a content hash. An ETag that moved with the clock would make every conditional
    // request a 200 with a full body, which is the opposite of what it is for.
    const first = buildFacts(FIXTURE, OPTIONS)
    const second = buildFacts(FIXTURE, { ...OPTIONS, generatedAt: '2026-09-18T10:00:01.000Z' })
    expect(factsEtag(first)).toBe(factsEtag(second))
    expect(first.generatedAt).not.toBe(second.generatedAt)
  })

  it('changes when a fact changes — the control, and the reason it exists', () => {
    const before = factsEtag(buildFacts(FIXTURE, OPTIONS))
    const moved = factsEtag(
      buildFacts(
        { ...FIXTURE, premises: { ...FIXTURE.premises, addressLine1: '2 Example Road' } },
        OPTIONS,
      ),
    )
    expect(moved).not.toBe(before)
    // And when the origin changes, because a staging payload describes a different site.
    expect(
      factsEtag(buildFacts(FIXTURE, { ...OPTIONS, origin: 'https://staging.example.test' })),
    ).not.toBe(before)
  })

  it('is weak, because two responses with one tag differ in their timestamp', () => {
    expect(factsEtag(buildFacts(FIXTURE, OPTIONS))).toMatch(/^W\/"[0-9a-f]{32}"$/)
  })
})

describe('/llms.txt is an index, and says what it is not', () => {
  const PAGES = [
    { label: 'Home', url: 'https://example.test/', alternates: ['https://example.test/ar'] },
  ]
  const body = buildLlmsTxt({
    facts: buildFacts(FIXTURE, OPTIONS),
    origin: OPTIONS.origin,
    pages: PAGES,
  })

  it('carries the honest caveat docs/09 asks for, near the top', () => {
    // docs/09 §"LLM SEO": worth publishing "with the honest caveat that it is an unofficial convention
    // with limited adoption, not a standard". A reader who finds this path has no other way to know.
    expect(body.split('\n').slice(0, 12).join(' ')).toMatch(/unofficial/)
    expect(body).toMatch(/not a standard|rather than a standard/)
  })

  it('states what robots.txt and a sitemap are for, so neither is implied by this file', () => {
    expect(body).toContain('robots.txt')
    expect(body).toContain('sitemap')
    expect(body).toMatch(/what a crawler may/)
  })

  it('links the fact sheet and every page it was given, with the other locale', () => {
    expect(body).toContain(`${OPTIONS.origin}/api/facts`)
    expect(body).toContain('[Home](https://example.test/)')
    expect(body).toContain('https://example.test/ar')
  })

  it('names the price points and the offerings with no figure', () => {
    expect(body).toContain('Normal Massage (Asian): 45 min 170.00, 60 min 200.00')
    expect(body).toContain('Couple Massage: priced on request')
  })

  it('says that no WhatsApp number is published, rather than omitting the channel', () => {
    // Omission is the failure mode: a reader that finds no line may repeat a number from a directory. One
    // that is told the number is disputed can say so.
    expect(body).toMatch(/WhatsApp: no number is published/)
    expect(body).not.toMatch(/WHATSAPP-PENDING/)
    expect(body).toContain('Y1-nap')
  })

  it('warns that the close is on the next day, in words', () => {
    expect(body).toMatch(/following day/)
    expect(body).toMatch(/opens <= now <= closes/)
  })

  it('passes the banned-claims lint, and is refused when it would not', () => {
    expect(lintLlmsTxt(body, POLICY)).toEqual([])
    // The control. A lint that returned [] for everything would satisfy the line above for ever, so a
    // deliberately non-compliant body has to be refused BY RULE NAME.
    const claim = `${body}\n- Our therapeutic massage will cure your back pain.\n`
    const findings = lintLlmsTxt(claim, POLICY)
    expect(findings.map((finding) => finding.rule)).toContain('banned_claim_term')
    expect(findings.map((finding) => finding.term)).toContain('therapeutic')
  })

  it('does not lint the URLs, because a path is a locator and not a claim', () => {
    // `/treatments` is docs/09 §1's catalogue index and `treatment` is a banned claim term, so linting the
    // URLs would refuse this file for linking the most valuable page on the site. The prose around a link
    // is still linted, which is the half that matters.
    expect(lintableProse('see [the menu](https://x.test/treatments) for prices')).not.toContain(
      'treatments',
    )
    expect(lintableProse('see [the menu](/treatments) for prices')).toContain('the menu')
    expect(lintLlmsTxt('- [Our services](https://x.test/treatments)', POLICY)).toEqual([])
    expect(
      lintLlmsTxt('- [Our treatment menu](https://x.test/x)', POLICY).map((f) => f.rule),
    ).toContain('banned_claim_term')
  })

  it('refuses to publish rather than warning', () => {
    const input = { facts: buildFacts(FIXTURE, OPTIONS), origin: OPTIONS.origin, pages: PAGES }
    expect(publishLlmsTxt(input, POLICY)).toBe(body)
    // A profile that banned the word the menu uses refuses the file. Fail closed, like the catalogue seed.
    expect(() => publishLlmsTxt(input, { ...POLICY, bannedClaimTerms: ['massage'] })).toThrow(
      /cannot be published/,
    )
  })
})

describe('the visible hours block collapses days without merging sessions', () => {
  const day = (dayOfWeek: number, opens: string, closes: string, closesNextDay = true) => ({
    dayOfWeek,
    opens,
    closes,
    closesNextDay,
    isClosed: false,
  })

  it('collapses seven identical days into one run', () => {
    // docs/13 §2 is one session every day, which is seven identical rows. Seven identical lines in a footer
    // are noise a reader skips, and the fact that matters — the close is on the next day — goes with them.
    const runs = collapseHours(buildFacts(FIXTURE, OPTIONS).hours.weekly)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ fromDay: 0, toDay: 6, opens: '11:00', closes: '02:00' })
  })

  it('keeps two different sessions apart — the control, and the only bug this function can have', () => {
    // Invisible on the seeded data, where all seven days are the same, and a real defect: a footer claiming
    // Friday opens at 11:00 when the row says 14:00 is worse than seven repeated lines.
    const runs = collapseHours([
      day(0, '11:00', '02:00'),
      day(1, '11:00', '02:00'),
      day(2, '14:00', '02:00'),
      day(3, '11:00', '02:00'),
    ])
    expect(runs.map((run) => [run.fromDay, run.toDay, run.opens])).toEqual([
      [0, 1, '11:00'],
      [2, 2, '14:00'],
      [3, 3, '11:00'],
    ])
  })

  it('does not merge across a gap in the week, or across a closed day', () => {
    // Runs are by adjacency as well as by session: two days with the same hours either side of a third with
    // different ones are two rows, and a range written over the day in between would be a lie.
    const runs = collapseHours([day(0, '11:00', '02:00'), day(6, '11:00', '02:00')])
    expect(runs).toHaveLength(2)
    const withClosed = collapseHours([
      day(0, '11:00', '02:00'),
      { ...day(1, '11:00', '02:00'), isClosed: true },
      day(2, '11:00', '02:00'),
    ])
    expect(withClosed).toHaveLength(3)
    expect(withClosed[1]?.isClosed).toBe(true)
  })
})

describe('robots.txt is a crawl policy and repeats itself on purpose', () => {
  const body = buildRobotsTxt({ origin: 'https://example.test', sitemapPath: null })

  it('allows every AI crawler docs/09 names, each in its own group', () => {
    for (const agent of AI_CRAWLER_USER_AGENTS) {
      expect(body, agent).toContain(`User-agent: ${agent}`)
    }
    expect([...AI_CRAWLER_USER_AGENTS]).toEqual([
      'GPTBot',
      'ClaudeBot',
      'PerplexityBot',
      'Google-Extended',
      'CCBot',
    ])
  })

  it('gives every group the whole policy, because a named group replaces the wildcard', () => {
    // The mistake this file exists to avoid. A `User-agent: GPTBot` group containing only `Allow: /` does
    // not inherit `Disallow: /admin` — robots.txt groups are alternatives, not layers — so it would grant
    // GPTBot the entire admin while reading as one line more permissive.
    const groups = body
      .split(/\nUser-agent: /)
      .slice(1)
      .map((group) => group.split('\n').filter((line) => /^(Allow|Disallow):/.test(line)))
    expect(groups).toHaveLength(AI_CRAWLER_USER_AGENTS.length + 1)
    for (const group of groups) {
      expect(group).toContain('Disallow: /admin')
      expect(group).toContain('Disallow: /cms-api')
      expect(group).toContain('Disallow: /api/')
      expect(group).toContain('Allow: /api/facts')
      expect(group).toContain('Allow: /')
    }
    // Every group identical, asserted as a set: one policy, however many audiences.
    expect(new Set(groups.map((group) => group.join('|'))).size).toBe(1)
  })

  it('allows the fact sheet inside the API namespace it otherwise disallows', () => {
    // A robots.txt match is decided by the longest matching path, not by line order, so the Allow wins.
    const lines = body.split('\n')
    expect(lines).toContain('Disallow: /api/')
    expect(lines).toContain('Allow: /api/facts')
  })

  it('does not disallow the noindex routes, which is the distinction it is built on', () => {
    // A crawler forbidden to fetch `/kitchen-sink` could never read its `x-robots-tag: noindex`, so a URL
    // discovered from an inbound link would stay indexable for ever. Disallow and noindex are alternatives.
    for (const path of ['/kitchen-sink', '/settings', '/analytics']) {
      expect(body, path).not.toContain(`Disallow: ${path}`)
    }
  })

  it('names no sitemap while no route serves one, and names it the day one does', () => {
    expect(body).not.toContain('Sitemap:')
    // The registry is in exact bijection with the filesystem, so this is also the statement that nothing
    // serves that path today. W-SITE-08 owns the sitemap index.
    expect(routeByPath('/sitemap.xml')).toBeUndefined()
    // The control: the line is emitted, absolute, when the caller says the route exists.
    const withSitemap = buildRobotsTxt({
      origin: 'https://example.test',
      sitemapPath: '/sitemap.xml',
    })
    expect(withSitemap).toContain('Sitemap: https://example.test/sitemap.xml')
  })

  it('points a reader at the two machine surfaces without pretending they are directives', () => {
    expect(body).toContain('# https://example.test/api/facts')
    expect(body).toContain('# https://example.test/llms.txt')
  })
})
