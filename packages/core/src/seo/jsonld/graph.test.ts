import type { AppError } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import { businessId, organizationId } from './business.ts'
import { buildStructuredDataGraph, serialiseGraph } from './graph.ts'
import { offerIdsIn } from './offerings.ts'
import {
  SPECIMEN_BREADCRUMB,
  SPECIMEN_FAQ,
  SPECIMEN_ORIGIN,
  SPECIMEN_PAGE_URL,
  SPECIMEN_THERAPISTS,
  specimenFacts,
  specimenGraphs,
} from './specimen.ts'
import { SCHEMA_CONTEXT, type SiteNode } from './types.ts'

/**
 * Every `@type` a node declares, as a list.
 *
 * `Organization` declares its type as a bare string and everything else as an array, so spreading `@type`
 * would turn 'Organization' into twelve single characters — and every `toContain` below would pass or fail
 * for the wrong reason.
 */
const typesOf = (node: SiteNode): readonly string[] =>
  typeof node['@type'] === 'string' ? [node['@type']] : [...node['@type']]

const facts = specimenFacts()
const BASE = {
  facts,
  pageUrl: SPECIMEN_PAGE_URL,
  origin: SPECIMEN_ORIGIN,
  licence: 'unconfirmed' as const,
  includeCatalogue: true,
}

describe('the graph is one document, with one identity per node', () => {
  const graph = buildStructuredDataGraph(BASE)

  it('declares one @context and one @graph', () => {
    // One graph rather than several sibling script blocks: nodes reference each other by `@id`, and a
    // consumer reading two blocks is entitled to treat them as two unrelated documents.
    expect(graph['@context']).toBe(SCHEMA_CONTEXT)
    expect(Array.isArray(graph['@graph'])).toBe(true)
  })

  it('puts the organization first and the business second, always', () => {
    // A fixed order makes the emitted JSON a function of the data alone, which is what lets a test compare
    // two renders byte for byte and a reviewer read a diff.
    expect(graph['@graph'][0]?.['@id']).toBe(organizationId(SPECIMEN_ORIGIN))
    expect(graph['@graph'][1]?.['@id']).toBe(businessId(SPECIMEN_ORIGIN))
  })

  it('is byte-identical across two builds from the same payload', () => {
    expect(serialiseGraph(buildStructuredDataGraph(BASE))).toBe(
      serialiseGraph(buildStructuredDataGraph(BASE)),
    )
  })

  it('cross-references by @id, so every reference resolves inside the one document', () => {
    const ids = new Set(graph['@graph'].map((node) => node['@id']))
    const services = graph['@graph'].filter((node) => typesOf(node).includes('Service'))
    expect(services.length).toBeGreaterThan(0)
    for (const service of services) {
      if (!('provider' in service)) throw new Error('a Service with no provider reached the graph')
      expect(ids.has(service.provider['@id'])).toBe(true)
    }
    const business = graph['@graph'][1]
    if (
      business === undefined ||
      !('makesOffer' in business) ||
      business.makesOffer === undefined
    ) {
      throw new Error('the business node published no offers')
    }
    expect(business.makesOffer.map((ref) => ref['@id'])).toEqual(offerIdsIn(services as never))
  })

  it('gives no two nodes the same @id', () => {
    const ids = graph['@graph'].map((node) => node['@id'])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('omits the catalogue when the page is not about the menu', () => {
    const bare = buildStructuredDataGraph({ ...BASE, includeCatalogue: false })
    expect(bare['@graph'].some((node) => typesOf(node).includes('Service'))).toBe(false)
    // And the business node then makes no offer, rather than making an empty list of them.
    expect(bare['@graph'][1]).not.toHaveProperty('makesOffer')
  })

  it('emits no Person, FAQPage, BreadcrumbList, ImageObject or VideoObject by default', () => {
    // Which is the state of the real database: no therapist passes the guard, the FAQ collection is empty,
    // the home page has no parent, and no hero derivative is served.
    const types = buildStructuredDataGraph(BASE)['@graph'].flatMap(typesOf)
    for (const absent of ['Person', 'FAQPage', 'BreadcrumbList', 'ImageObject', 'VideoObject']) {
      expect(types, absent).not.toContain(absent)
    }
  })

  it('adds each optional node when, and only when, its data exists — the control', () => {
    const full = buildStructuredDataGraph({
      ...BASE,
      therapists: SPECIMEN_THERAPISTS,
      faq: SPECIMEN_FAQ,
      breadcrumb: SPECIMEN_BREADCRUMB,
      heroImage: {
        contentUrl: `${SPECIMEN_ORIGIN}/hero.avif`,
        width: 1280,
        height: 720,
        caption: 'A room',
      },
      heroVideo: {
        name: 'Tour',
        description: 'A walk through the rooms.',
        contentUrl: `${SPECIMEN_ORIGIN}/tour.mp4`,
        thumbnailUrls: [`${SPECIMEN_ORIGIN}/tour.jpg`],
        uploadDate: '2026-01-01',
      },
    })
    const types = full['@graph'].flatMap(typesOf)
    for (const present of ['Person', 'FAQPage', 'BreadcrumbList', 'ImageObject', 'VideoObject']) {
      expect(types, present).toContain(present)
    }
    // Exactly one Person: the second specimen therapist fails ADR 0020's guard on both counts.
    expect(types.filter((type) => type === 'Person')).toHaveLength(1)
  })
})

describe('the graph refuses what it cannot honestly publish', () => {
  it('refuses a page URL that is not under the origin', () => {
    // Every `@id` hangs off the origin, so a mismatch publishes a node identified by a host the page is not
    // served from — two entities where there should be one.
    expect(() => buildStructuredDataGraph({ ...BASE, pageUrl: 'https://elsewhere.test/' })).toThrow(
      /not under origin/,
    )
  })

  it('refuses a medical claim that arrived as data rather than as a type', () => {
    // The last gate before the graph leaves the package, and it walks the finished document: a service name
    // from the catalogue or a description from the CMS is the same claim to a regulator as a `@type`.
    const first = facts.catalogue.services[0]
    if (first === undefined) throw new Error('the specimen catalogue is empty')
    const claiming = specimenFacts({
      catalogue: {
        ...facts.catalogue,
        services: [{ ...first, name: 'Physician-led deep tissue massage' }],
      },
    })
    try {
      buildStructuredDataGraph({ ...BASE, facts: claiming })
      // The rule name is in the message on purpose: `scripts/test-gates.mjs` removes the guard and asserts
      // that this suite fails **by rule**, which it can only do if the failure says which rule it was.
      expect.unreachable(
        'a medical claim reached the published graph: medical_vocabulary_outside_healthcare',
      )
    } catch (error) {
      const failure = error as AppError
      expect(failure.message).toContain('Physician')
      expect(failure.details['rule']).toBe('medical_vocabulary_outside_healthcare')
    }
    // And the only path that permits it.
    expect(() =>
      buildStructuredDataGraph({ ...BASE, facts: claiming, licence: 'healthcare' }),
    ).not.toThrow()
  })

  it('refuses a business with no telephone rather than publishing one nobody can reach', () => {
    const unreachable = specimenFacts({
      contact: { ...facts.contact, landline: null, mobile: null },
    })
    expect(() => buildStructuredDataGraph({ ...BASE, facts: unreachable })).toThrow(
      /no telephone to publish/,
    )
  })

  it('never publishes a WhatsApp number or an open-question id', () => {
    // `contact.whatsapp`'s unanswered branch types the number as `z.null()` (Y1-nap), and the graph must not
    // resurrect a candidate — `telephone` and `sameAs` are the fields that would.
    const serialised = serialiseGraph(buildStructuredDataGraph(BASE))
    expect(serialised).not.toMatch(/whatsapp/i)
    expect(serialised).not.toMatch(/Y1-nap|Y9-poa-prices|Y2-gbp-status/)
    // The provisional and unanswered blocks of the fact sheet belong to `/api/facts`, which is built for a
    // reader that wants to know what is missing. A published graph states facts or says nothing.
    expect(serialised).not.toMatch(/provisional|unanswered/i)
  })
})

describe('serialiseGraph', () => {
  it('escapes the three characters an HTML parser acts on', () => {
    // A value containing `</script>` would close the element early and the rest of the JSON would become
    // document markup. React's `dangerouslySetInnerHTML` does no escaping and every value here comes from a
    // row or a CMS field a person can type into.
    const hostile = specimenFacts({
      names: {
        ...facts.names,
        display: 'Rooms </script><script>alert(1)</script> & Spa',
      },
    })
    const serialised = serialiseGraph(buildStructuredDataGraph({ ...BASE, facts: hostile }))
    expect(serialised).not.toContain('<')
    expect(serialised).not.toContain('>')
    expect(serialised).not.toContain('&')
    expect(serialised).toContain('\\u003c')
    // And the escapes are valid JSON, so a consumer reads back exactly what the row holds.
    const parsed = JSON.parse(serialised) as { '@graph': { name?: string }[] }
    expect(parsed['@graph'][0]?.name).toBe('Rooms </script><script>alert(1)</script> & Spa')
  })

  it('emits no indentation, because nobody reads it and every request pays for it', () => {
    expect(serialiseGraph(buildStructuredDataGraph(BASE))).not.toContain('\n')
  })
})

describe('the specimens', () => {
  it('cover both licence classes and the shape the database actually holds', () => {
    const graphs = specimenGraphs()
    expect(graphs.map((specimen) => specimen.licence)).toEqual([
      'unconfirmed',
      'healthcare',
      'unconfirmed',
    ])
    // The third is the one the site emits today, and it must require the three node types that are always
    // there — so a specimen cannot pass by emitting less.
    expect([...(graphs[2]?.requireTypes ?? [])]).toEqual(['DaySpa', 'Organization', 'Service'])
  })

  it('builds every one of them without a throw', () => {
    for (const specimen of specimenGraphs()) {
      expect(() => buildStructuredDataGraph(specimen.input), specimen.label).not.toThrow()
    }
  })

  it('carries no value of this business, which is what the NAP grep gate depends on', () => {
    // The specimen lives in `packages/core`, inside the grep's scan. A specimen carrying the real street
    // would need an exemption, and the exemption list in `packages/db/src/seed/premises.test.ts` is closed.
    const serialised = JSON.stringify(specimenFacts())
    for (const real of [
      'Al Meena',
      'Al Zahiyah',
      'Tower Block',
      'M-Floor',
      '97125576533',
      '971563429399',
    ]) {
      expect(serialised, real).not.toContain(real)
    }
  })
})
