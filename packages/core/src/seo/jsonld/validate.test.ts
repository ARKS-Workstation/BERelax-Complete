import { describe, expect, it } from 'vitest'
import { buildStructuredDataGraph } from './graph.ts'
import { specimenGraphs } from './specimen.ts'
import { GRAPH_RULES, type GraphRule, SCHEMA_CONTEXT } from './types.ts'
import {
  formatFindings,
  graphOpenAt,
  type ValidateGraphOptions,
  validateGraph,
} from './validate.ts'

/**
 * The validator, rule by rule.
 *
 * Every rule gets a known-bad node that must be reported **by name**, and the file ends with the property
 * that closes the loop: every rule in `GRAPH_RULES` has been seen to fire. A rule that matches nothing is a
 * rule that reports PASS for ever, which is ADR 0003's whole subject.
 *
 * The controls are the specimens. `specimenGraphs()` builds three real graphs through the real builders and
 * every one of them must produce zero findings — so a validator that had started reporting everything, or
 * nothing, fails here rather than in six weeks.
 */
const LICENCE: ValidateGraphOptions = { licence: 'unconfirmed' }

/** The rules a graph produced findings for. */
const rulesFor = (
  graph: unknown,
  options: ValidateGraphOptions = LICENCE,
): readonly GraphRule[] => [
  ...new Set(validateGraph(graph, options).map((finding) => finding.rule)),
]

/** A minimal valid graph, so each fixture below differs from a passing one in exactly one way. */
const wrap = (...nodes: readonly unknown[]) => ({ '@context': SCHEMA_CONTEXT, '@graph': nodes })

const VALID_ADDRESS = {
  '@type': 'PostalAddress',
  streetAddress: '1 Specimen Road',
  addressLocality: 'Specimen District',
  addressRegion: 'Specimen Emirate',
  addressCountry: 'AE',
}
const VALID_HOURS = [
  { '@type': 'OpeningHoursSpecification', dayOfWeek: ['Monday'], opens: '12:00', closes: '23:59' },
  { '@type': 'OpeningHoursSpecification', dayOfWeek: ['Tuesday'], opens: '00:00', closes: '03:00' },
]
const VALID_BUSINESS = {
  '@type': ['DaySpa'],
  '@id': 'https://example.test/#business',
  name: 'Specimen Wellness Rooms and Spa',
  url: 'https://example.test/',
  telephone: '+97120000000',
  address: VALID_ADDRESS,
  openingHoursSpecification: VALID_HOURS,
}

describe('the specimens are valid, which is the control every fixture below is measured against', () => {
  it('reports nothing for any specimen graph, including the required types', () => {
    for (const specimen of specimenGraphs()) {
      const graph = buildStructuredDataGraph(specimen.input)
      const findings = validateGraph(graph, {
        licence: specimen.licence,
        requireTypes: specimen.requireTypes,
      })
      expect(formatFindings(findings), specimen.label).toBe('')
    }
  })
})

describe('the graph envelope', () => {
  it('refuses a missing or wrong @context, and stops there', () => {
    expect(rulesFor({ '@graph': [] })).toEqual(['context_missing'])
    expect(rulesFor({ '@context': 'http://schema.org', '@graph': [] })).toEqual(['context_missing'])
    expect(rulesFor('not a graph')).toEqual(['context_missing'])
    // Without a context every `@type` is an undefined term, so reporting thirty consequential findings
    // would bury the one that matters.
    expect(validateGraph({ '@graph': [{ '@type': 'MedicalClinic' }] }, LICENCE)).toHaveLength(1)
  })

  it('refuses a graph with no @graph array', () => {
    expect(rulesFor({ '@context': SCHEMA_CONTEXT })).toEqual(['context_missing'])
  })

  it('refuses a node with no @type, and a node that is not an object', () => {
    expect(rulesFor(wrap({ name: 'no type' }))).toContain('node_without_type')
    expect(rulesFor(wrap('a string'))).toEqual(['node_without_type'])
  })

  it('refuses two nodes sharing an @id, because they merge and one overwrites the other', () => {
    expect(
      rulesFor(
        wrap(
          { ...VALID_BUSINESS },
          {
            '@type': 'Organization',
            '@id': VALID_BUSINESS['@id'],
            name: 'x',
            url: 'https://example.test/',
          },
        ),
      ),
    ).toContain('duplicate_node_id')
    // The control: different ids, no finding.
    expect(
      rulesFor(
        wrap(VALID_BUSINESS, {
          '@type': 'Organization',
          '@id': 'https://example.test/#organization',
          name: 'x',
          url: 'https://example.test/',
        }),
      ),
    ).toEqual([])
  })

  it('refuses a null anywhere, at any depth', () => {
    // `"geo": null` is a published claim; `"latitude": null` is worse, because a consumer checking for the
    // key finds it.
    expect(rulesFor(wrap({ ...VALID_BUSINESS, geo: null }))).toContain('null_property')
    expect(
      rulesFor(
        wrap({
          ...VALID_BUSINESS,
          geo: { '@type': 'GeoCoordinates', latitude: null, longitude: null },
        }),
      ),
    ).toContain('null_property')
    expect(rulesFor(wrap({ ...VALID_BUSINESS, image: [null] }))).toContain('null_property')
  })

  it('names the path of a finding, so a graph can be fixed in one pass', () => {
    const findings = validateGraph(wrap({ ...VALID_BUSINESS, email: null }), LICENCE)
    expect(findings[0]?.path).toBe('@graph[0].email')
    expect(formatFindings(findings)).toMatch(/^null_property {2}@graph\[0]\.email: /)
  })

  it('refuses a placeholder, using the schema’s own predicate', () => {
    // `TRN-PENDING-Y1-TRN` and `WHATSAPP-PENDING-Y1-NAP` are values `is_placeholder_text()` refuses (0026),
    // and a published document is the last place they may reach.
    for (const placeholder of [
      'TRN-PENDING-Y1-TRN',
      'WHATSAPP-PENDING-Y1-NAP',
      'Address to be confirmed',
      'TBC',
      '[CONFIRM] the floor',
    ]) {
      expect(rulesFor(wrap({ ...VALID_BUSINESS, name: placeholder })), placeholder).toContain(
        'placeholder_property',
      )
    }
    // The control: the real names carry no marker.
    expect(rulesFor(wrap(VALID_BUSINESS))).toEqual([])
  })

  it('refuses medical vocabulary while the licence class is not healthcare', () => {
    const graph = wrap({ ...VALID_BUSINESS, '@type': ['DaySpa', 'MedicalClinic'] })
    expect(rulesFor(graph)).toContain('medical_vocabulary_outside_healthcare')
    expect(rulesFor(graph, { licence: 'wellness' })).toContain(
      'medical_vocabulary_outside_healthcare',
    )
    // The control, and the only path that permits it.
    expect(rulesFor(graph, { licence: 'healthcare' })).toEqual([])
  })

  it('refuses a page that is missing a node type it must carry', () => {
    expect(
      rulesFor(wrap(VALID_BUSINESS), { ...LICENCE, requireTypes: ['Organization'] }),
    ).toContain('business_missing_required_property')
    expect(rulesFor(wrap(VALID_BUSINESS), { ...LICENCE, requireTypes: ['DaySpa'] })).toEqual([])
  })
})

describe('the business node', () => {
  it('refuses a DaySpa with no address — the acceptance criterion’s own fixture', () => {
    const { address: _dropped, ...noAddress } = VALID_BUSINESS
    expect(rulesFor(wrap(noAddress))).toContain('business_missing_required_property')
  })

  it('refuses an address missing any of the four lines a geocoder needs', () => {
    for (const property of [
      'streetAddress',
      'addressLocality',
      'addressRegion',
      'addressCountry',
    ] as const) {
      const address = { ...VALID_ADDRESS, [property]: '' }
      expect(rulesFor(wrap({ ...VALID_BUSINESS, address })), property).toContain(
        'address_missing_required_property',
      )
    }
  })

  it('refuses a business with no name, no url, no telephone or a relative url', () => {
    expect(rulesFor(wrap({ ...VALID_BUSINESS, name: '' }))).toContain(
      'business_missing_required_property',
    )
    expect(rulesFor(wrap({ ...VALID_BUSINESS, telephone: undefined }))).toContain(
      'business_missing_required_property',
    )
    expect(rulesFor(wrap({ ...VALID_BUSINESS, url: '/' }))).toContain('url_not_absolute')
  })

  it('refuses a business with no opening hours at all', () => {
    expect(rulesFor(wrap({ ...VALID_BUSINESS, openingHoursSpecification: [] }))).toContain(
      'opening_hours_missing_required_property',
    )
    expect(rulesFor(wrap({ ...VALID_BUSINESS, openingHoursSpecification: undefined }))).toContain(
      'opening_hours_missing_required_property',
    )
  })

  it('refuses a specification that crosses midnight in one entry', () => {
    // The defect the whole hours design exists to avoid: a consumer evaluating `opens <= t <= closes`
    // concludes the premises is open for no minute of any day.
    const crossing = [
      {
        '@type': 'OpeningHoursSpecification',
        dayOfWeek: ['Monday'],
        opens: '11:00',
        closes: '02:00',
      },
    ]
    expect(rulesFor(wrap({ ...VALID_BUSINESS, openingHoursSpecification: crossing }))).toContain(
      'opening_hours_crosses_midnight_in_one_spec',
    )
    // The control: the same session, split, passes.
    expect(rulesFor(wrap({ ...VALID_BUSINESS, openingHoursSpecification: VALID_HOURS }))).toEqual(
      [],
    )
  })

  it('refuses a malformed or missing time, and a spec with no day', () => {
    const cases: readonly [string, GraphRule][] = [
      ['25:00', 'opening_hours_malformed_time'],
      ['11:00:00', 'opening_hours_malformed_time'],
      ['11am', 'opening_hours_malformed_time'],
    ]
    for (const [opens, rule] of cases) {
      const specs = [
        { '@type': 'OpeningHoursSpecification', dayOfWeek: ['Monday'], opens, closes: '23:59' },
      ]
      expect(
        rulesFor(wrap({ ...VALID_BUSINESS, openingHoursSpecification: specs })),
        opens,
      ).toContain(rule)
    }
    const noDay = [
      { '@type': 'OpeningHoursSpecification', dayOfWeek: [], opens: '12:00', closes: '23:59' },
    ]
    expect(rulesFor(wrap({ ...VALID_BUSINESS, openingHoursSpecification: noDay }))).toContain(
      'opening_hours_missing_required_property',
    )
    const noTimes = [{ '@type': 'OpeningHoursSpecification', dayOfWeek: ['Monday'] }]
    expect(rulesFor(wrap({ ...VALID_BUSINESS, openingHoursSpecification: noTimes }))).toContain(
      'opening_hours_missing_required_property',
    )
    expect(
      rulesFor(wrap({ ...VALID_BUSINESS, openingHoursSpecification: ['not an object'] })),
    ).toContain('opening_hours_missing_required_property')
  })

  it('refuses half a coordinate and a coordinate out of range', () => {
    const geo = (latitude: unknown, longitude: unknown) => ({
      ...VALID_BUSINESS,
      geo: { '@type': 'GeoCoordinates', latitude, longitude },
    })
    expect(
      rulesFor(wrap({ ...VALID_BUSINESS, geo: { '@type': 'GeoCoordinates', latitude: '24.49' } })),
    ).toContain('geo_incomplete')
    expect(rulesFor(wrap({ ...VALID_BUSINESS, geo: 'somewhere' }))).toContain('geo_incomplete')
    expect(rulesFor(wrap(geo('91.0', '54.37')))).toContain('geo_out_of_range')
    expect(rulesFor(wrap(geo('24.49', '181.0')))).toContain('geo_out_of_range')
    expect(rulesFor(wrap(geo('north', '54.37')))).toContain('geo_out_of_range')
    // The control: a real coordinate pair passes, so the rule is about the value and not the property.
    expect(rulesFor(wrap(geo('24.490123', '54.370987')))).toEqual([])
  })
})

describe('the rating that must never be published', () => {
  it('refuses an aggregateRating with no reviews behind it, on any node', () => {
    // docs/09 §"Schema types" refuses self-serving review markup, and Google answers it with a manual action
    // rather than a dropped rich result. Checked on every node type, because attaching it to the
    // Organization instead of the business is exactly how one survives a review of the business node.
    for (const rating of [
      { '@type': 'AggregateRating', ratingValue: '4.9' },
      { '@type': 'AggregateRating', ratingValue: '4.9', reviewCount: 0 },
      { '@type': 'AggregateRating', ratingValue: '4.9', reviewCount: 'lots' },
      'excellent',
    ]) {
      expect(rulesFor(wrap({ ...VALID_BUSINESS, aggregateRating: rating }))).toContain(
        'aggregate_rating_without_reviews',
      )
    }
  })

  it('permits one with a real review count, which is the only shape that is honest', () => {
    expect(
      rulesFor(
        wrap({
          ...VALID_BUSINESS,
          aggregateRating: { '@type': 'AggregateRating', ratingValue: '4.9', reviewCount: 214 },
        }),
      ),
    ).toEqual([])
  })
})

describe('Service and Offer', () => {
  const service = {
    '@type': ['Service'],
    '@id': 'https://example.test/#service-x',
    name: 'Normal Massage (Asian)',
    provider: { '@id': VALID_BUSINESS['@id'] },
    offers: [
      {
        '@type': 'Offer',
        '@id': 'https://example.test/#service-x-60',
        name: 'Normal Massage (Asian) — 60 minutes',
        price: '200.00',
        priceCurrency: 'AED',
      },
    ],
  }

  it('refuses a Service with no offers — the acceptance criterion’s own fixture', () => {
    expect(rulesFor(wrap(VALID_BUSINESS, { ...service, offers: [] }))).toContain(
      'service_without_offers',
    )
    expect(rulesFor(wrap(VALID_BUSINESS, { ...service, offers: undefined }))).toContain(
      'service_without_offers',
    )
    // The control: the same node with its offers passes.
    expect(rulesFor(wrap(VALID_BUSINESS, service))).toEqual([])
  })

  it('refuses a Service with no name and one with no provider', () => {
    expect(rulesFor(wrap(VALID_BUSINESS, { ...service, name: '' }))).toContain(
      'service_missing_required_property',
    )
    expect(rulesFor(wrap(VALID_BUSINESS, { ...service, provider: undefined }))).toContain(
      'service_missing_required_property',
    )
  })

  it('refuses a price that is a number, a one-decimal string or a grouped figure', () => {
    for (const price of [200, '200', '200.0', '1,200.00', '200.000']) {
      const offers = [{ ...service.offers[0], price }]
      expect(rulesFor(wrap(VALID_BUSINESS, { ...service, offers })), String(price)).toContain(
        'offer_price_not_two_decimals',
      )
    }
  })

  it('refuses a price of zero, which every consumer reads as free', () => {
    const offers = [{ ...service.offers[0], price: '0.00' }]
    expect(rulesFor(wrap(VALID_BUSINESS, { ...service, offers }))).toContain('offer_price_zero')
  })

  it('refuses a currency that is not AED, and a missing one', () => {
    for (const priceCurrency of ['USD', undefined, 'aed']) {
      const offers = [{ ...service.offers[0], priceCurrency }]
      expect(
        rulesFor(wrap(VALID_BUSINESS, { ...service, offers })),
        String(priceCurrency),
      ).toContain('offer_currency_not_aed')
    }
  })

  it('accepts an offer with no price when it says so, and refuses one that stays silent', () => {
    const onRequest = {
      '@type': 'Offer',
      '@id': 'https://example.test/#service-x-on-request',
      name: 'Four Hands Massage',
      description: 'Price on request. Two therapists, one room, one client.',
    }
    expect(rulesFor(wrap(VALID_BUSINESS, { ...service, offers: [onRequest] }))).toEqual([])
    const { description: _dropped, ...silent } = onRequest
    expect(rulesFor(wrap(VALID_BUSINESS, { ...service, offers: [silent] }))).toContain(
      'offer_shape_unrecognised',
    )
    // And a currency with no figure, which reads as a price of nothing.
    expect(
      rulesFor(
        wrap(VALID_BUSINESS, { ...service, offers: [{ ...onRequest, priceCurrency: 'AED' }] }),
      ),
    ).toContain('offer_shape_unrecognised')
    expect(rulesFor(wrap(VALID_BUSINESS, { ...service, offers: ['not an object'] }))).toContain(
      'offer_shape_unrecognised',
    )
  })

  it('accepts a single offer that is not wrapped in an array', () => {
    expect(rulesFor(wrap(VALID_BUSINESS, { ...service, offers: service.offers[0] }))).toEqual([])
  })
})

describe('FAQPage, BreadcrumbList, Person and the media objects', () => {
  it('refuses an FAQPage with no questions and a Question with no answer', () => {
    expect(rulesFor(wrap({ '@type': 'FAQPage', mainEntity: [] }))).toContain(
      'faq_page_without_questions',
    )
    expect(rulesFor(wrap({ '@type': 'FAQPage' }))).toContain('faq_page_without_questions')
    const blank = {
      '@type': 'FAQPage',
      mainEntity: [
        { '@type': 'Question', name: 'Q?', acceptedAnswer: { '@type': 'Answer', text: '  ' } },
      ],
    }
    expect(rulesFor(wrap(blank))).toContain('question_missing_answer')
    expect(
      rulesFor(wrap({ '@type': 'FAQPage', mainEntity: [{ '@type': 'Question', name: '' }] })),
    ).toContain('question_missing_answer')
    expect(rulesFor(wrap({ '@type': 'FAQPage', mainEntity: ['nope'] }))).toContain(
      'question_missing_answer',
    )
    // The control.
    expect(
      rulesFor(
        wrap({
          '@type': 'FAQPage',
          mainEntity: {
            '@type': 'Question',
            name: 'Q?',
            acceptedAnswer: { '@type': 'Answer', text: 'A.' },
          },
        }),
      ),
    ).toEqual([])
  })

  it('refuses breadcrumb positions that are not 1-based and contiguous', () => {
    const item = (position: unknown, name = 'Home') => ({
      '@type': 'ListItem',
      position,
      name,
      item: 'https://example.test/',
    })
    expect(
      rulesFor(wrap({ '@type': 'BreadcrumbList', itemListElement: [item(0), item(1)] })),
    ).toContain('breadcrumb_positions_not_contiguous')
    expect(
      rulesFor(wrap({ '@type': 'BreadcrumbList', itemListElement: [item(1), item(3)] })),
    ).toContain('breadcrumb_positions_not_contiguous')
    expect(
      rulesFor(wrap({ '@type': 'BreadcrumbList', itemListElement: [item(1), item(undefined)] })),
    ).toContain('breadcrumb_positions_not_contiguous')
    expect(rulesFor(wrap({ '@type': 'BreadcrumbList', itemListElement: ['nope'] }))).toContain(
      'breadcrumb_positions_not_contiguous',
    )
    expect(rulesFor(wrap({ '@type': 'BreadcrumbList', itemListElement: [] }))).toContain(
      'breadcrumb_without_items',
    )
    expect(
      rulesFor(wrap({ '@type': 'BreadcrumbList', itemListElement: [{ ...item(1), name: '' }] })),
    ).toContain('breadcrumb_without_items')
    expect(
      rulesFor(wrap({ '@type': 'BreadcrumbList', itemListElement: [{ ...item(1), item: '/' }] })),
    ).toContain('url_not_absolute')
    // The control.
    expect(
      rulesFor(
        wrap({ '@type': 'BreadcrumbList', itemListElement: [item(1), item(2, 'Treatments')] }),
      ),
    ).toEqual([])
  })

  it('refuses a Person with no name', () => {
    expect(rulesFor(wrap({ '@type': ['Person'], name: '' }))).toContain('person_missing_name')
    expect(rulesFor(wrap({ '@type': ['Person'], name: 'A Name' }))).toEqual([])
  })

  it('refuses an ImageObject with a relative URL or no dimensions', () => {
    expect(
      rulesFor(wrap({ '@type': 'ImageObject', contentUrl: '/hero.avif', width: 1, height: 1 })),
    ).toContain('image_object_missing_required_property')
    expect(
      rulesFor(wrap({ '@type': 'ImageObject', contentUrl: 'https://example.test/hero.avif' })),
    ).toContain('image_object_missing_required_property')
    expect(
      rulesFor(
        wrap({
          '@type': 'ImageObject',
          contentUrl: 'https://example.test/hero.avif',
          width: 1280,
          height: 720,
        }),
      ),
    ).toEqual([])
  })

  it('refuses a VideoObject without an upload date, a thumbnail or a content URL', () => {
    const video = {
      '@type': 'VideoObject',
      name: 'Tour',
      description: 'A walk through the rooms.',
      uploadDate: '2026-01-01',
      thumbnailUrl: ['https://example.test/tour.jpg'],
      contentUrl: 'https://example.test/tour.mp4',
    }
    expect(rulesFor(wrap({ ...video, uploadDate: '' }))).toContain(
      'video_object_missing_required_property',
    )
    expect(rulesFor(wrap({ ...video, thumbnailUrl: [] }))).toContain(
      'video_object_missing_required_property',
    )
    expect(rulesFor(wrap({ ...video, thumbnailUrl: '/tour.jpg' }))).toContain(
      'video_object_missing_required_property',
    )
    expect(rulesFor(wrap({ ...video, contentUrl: undefined }))).toContain(
      'video_object_missing_required_property',
    )
    // An embedUrl instead of a contentUrl is legitimate, and a single thumbnail need not be an array.
    expect(
      rulesFor(
        wrap({
          ...video,
          contentUrl: undefined,
          embedUrl: 'https://example.test/embed',
          thumbnailUrl: 'https://example.test/t.jpg',
        }),
      ),
    ).toEqual([])
  })
})

describe('graphOpenAt reads the published hours, not the payload', () => {
  it('answers from the emitted specifications', () => {
    const graph = buildStructuredDataGraph(specimenGraphs()[2]?.input as never)
    expect(graphOpenAt(graph, 1, '01:30')).toBe(true)
    expect(graphOpenAt(graph, 1, '04:00')).toBe(false)
  })

  it('returns undefined rather than "closed" when there is no business node to ask', () => {
    // A caller must not be able to read "closed" as an answer to a question that was never asked.
    expect(graphOpenAt(wrap({ '@type': 'Organization' }), 1, '01:30')).toBeUndefined()
    expect(graphOpenAt('not a graph', 1, '01:30')).toBeUndefined()
    expect(graphOpenAt({ '@context': SCHEMA_CONTEXT }, 1, '01:30')).toBeUndefined()
  })
})

describe('every rule has been seen to fire', () => {
  it('leaves no rule in GRAPH_RULES unexercised by this file', () => {
    // The property that keeps the list honest: a rule nobody has a fixture for is a rule that reports PASS
    // for ever, which is ADR 0003's whole subject. Each fixture here is the minimal graph that provokes one
    // rule, assembled so the loop is a statement about the rule set rather than about any one node.
    const fixtures: readonly (readonly [GraphRule, unknown, ValidateGraphOptions])[] = [
      ['context_missing', { '@graph': [] }, LICENCE],
      ['node_without_type', wrap({ name: 'x' }), LICENCE],
      [
        'duplicate_node_id',
        wrap(VALID_BUSINESS, {
          '@type': 'Organization',
          '@id': VALID_BUSINESS['@id'],
          name: 'x',
          url: 'https://example.test/',
        }),
        LICENCE,
      ],
      ['null_property', wrap({ ...VALID_BUSINESS, email: null }), LICENCE],
      ['placeholder_property', wrap({ ...VALID_BUSINESS, name: 'TBC' }), LICENCE],
      [
        'medical_vocabulary_outside_healthcare',
        wrap({ ...VALID_BUSINESS, '@type': ['DaySpa', 'MedicalClinic'] }),
        LICENCE,
      ],
      [
        'business_missing_required_property',
        wrap({ ...VALID_BUSINESS, address: undefined }),
        LICENCE,
      ],
      [
        'address_missing_required_property',
        wrap({ ...VALID_BUSINESS, address: { ...VALID_ADDRESS, streetAddress: '' } }),
        LICENCE,
      ],
      [
        'geo_incomplete',
        wrap({ ...VALID_BUSINESS, geo: { '@type': 'GeoCoordinates', latitude: '1' } }),
        LICENCE,
      ],
      [
        'geo_out_of_range',
        wrap({
          ...VALID_BUSINESS,
          geo: { '@type': 'GeoCoordinates', latitude: '91', longitude: '1' },
        }),
        LICENCE,
      ],
      [
        'opening_hours_missing_required_property',
        wrap({ ...VALID_BUSINESS, openingHoursSpecification: [] }),
        LICENCE,
      ],
      [
        'opening_hours_crosses_midnight_in_one_spec',
        wrap({
          ...VALID_BUSINESS,
          openingHoursSpecification: [
            {
              '@type': 'OpeningHoursSpecification',
              dayOfWeek: ['Monday'],
              opens: '11:00',
              closes: '02:00',
            },
          ],
        }),
        LICENCE,
      ],
      [
        'opening_hours_malformed_time',
        wrap({
          ...VALID_BUSINESS,
          openingHoursSpecification: [
            {
              '@type': 'OpeningHoursSpecification',
              dayOfWeek: ['Monday'],
              opens: '11am',
              closes: '23:59',
            },
          ],
        }),
        LICENCE,
      ],
      [
        'organization_missing_required_property',
        wrap({ '@type': 'Organization', name: '' }),
        LICENCE,
      ],
      [
        'same_as_not_absolute_https',
        wrap({
          '@type': 'Organization',
          name: 'x',
          url: 'https://example.test/',
          sameAs: ['http://x.test'],
        }),
        LICENCE,
      ],
      [
        'service_without_offers',
        wrap({
          '@type': ['Service'],
          name: 'x',
          provider: { '@id': 'https://example.test/#business' },
          offers: [],
        }),
        LICENCE,
      ],
      [
        'service_missing_required_property',
        wrap({
          '@type': ['Service'],
          name: '',
          provider: { '@id': 'https://example.test/#business' },
          offers: [{ '@type': 'Offer', price: '1.00', priceCurrency: 'AED' }],
        }),
        LICENCE,
      ],
      [
        'offer_shape_unrecognised',
        wrap({
          '@type': ['Service'],
          name: 'x',
          provider: { '@id': 'https://example.test/#business' },
          offers: [{ '@type': 'Offer' }],
        }),
        LICENCE,
      ],
      [
        'offer_price_not_two_decimals',
        wrap({
          '@type': ['Service'],
          name: 'x',
          provider: { '@id': 'https://example.test/#business' },
          offers: [{ '@type': 'Offer', price: 200, priceCurrency: 'AED' }],
        }),
        LICENCE,
      ],
      [
        'offer_price_zero',
        wrap({
          '@type': ['Service'],
          name: 'x',
          provider: { '@id': 'https://example.test/#business' },
          offers: [{ '@type': 'Offer', price: '0.00', priceCurrency: 'AED' }],
        }),
        LICENCE,
      ],
      [
        'offer_currency_not_aed',
        wrap({
          '@type': ['Service'],
          name: 'x',
          provider: { '@id': 'https://example.test/#business' },
          offers: [{ '@type': 'Offer', price: '1.00', priceCurrency: 'USD' }],
        }),
        LICENCE,
      ],
      [
        'aggregate_rating_without_reviews',
        wrap({
          ...VALID_BUSINESS,
          aggregateRating: { '@type': 'AggregateRating', ratingValue: '5' },
        }),
        LICENCE,
      ],
      [
        'question_missing_answer',
        wrap({ '@type': 'FAQPage', mainEntity: [{ '@type': 'Question', name: 'Q?' }] }),
        LICENCE,
      ],
      ['faq_page_without_questions', wrap({ '@type': 'FAQPage', mainEntity: [] }), LICENCE],
      [
        'breadcrumb_positions_not_contiguous',
        wrap({
          '@type': 'BreadcrumbList',
          itemListElement: [
            { '@type': 'ListItem', position: 0, name: 'Home', item: 'https://example.test/' },
          ],
        }),
        LICENCE,
      ],
      [
        'breadcrumb_without_items',
        wrap({ '@type': 'BreadcrumbList', itemListElement: [] }),
        LICENCE,
      ],
      ['person_missing_name', wrap({ '@type': ['Person'], name: '' }), LICENCE],
      [
        'image_object_missing_required_property',
        wrap({ '@type': 'ImageObject', contentUrl: '/x.avif', width: 1, height: 1 }),
        LICENCE,
      ],
      [
        'video_object_missing_required_property',
        wrap({ '@type': 'VideoObject', name: 'x', description: 'y', uploadDate: '' }),
        LICENCE,
      ],
      ['url_not_absolute', wrap({ ...VALID_BUSINESS, url: '/' }), LICENCE],
    ]

    const fired = new Set<GraphRule>()
    for (const [rule, graph, options] of fixtures) {
      const rules = rulesFor(graph, options)
      expect(rules, `${rule} did not fire on its own fixture`).toContain(rule)
      for (const seen of rules) fired.add(seen)
    }
    expect([...GRAPH_RULES].filter((rule) => !fired.has(rule))).toEqual([])
  })
})
