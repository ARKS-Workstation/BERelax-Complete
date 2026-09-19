import { describe, expect, it } from 'vitest'
import { organizationId } from './business.ts'
import {
  breadcrumbListNode,
  faqPageNode,
  imageObjectNode,
  mayPublishTherapist,
  personId,
  personNodeFor,
  personNodesFor,
  type TherapistCandidate,
  therapistPublishingRefusals,
  videoObjectNode,
} from './content.ts'
import {
  SPECIMEN_BREADCRUMB,
  SPECIMEN_FAQ,
  SPECIMEN_ORIGIN,
  SPECIMEN_PAGE_URL,
  SPECIMEN_THERAPISTS,
} from './specimen.ts'

const PERSON_OPTIONS = {
  origin: SPECIMEN_ORIGIN,
  licence: 'unconfirmed' as const,
  organizationId: organizationId(SPECIMEN_ORIGIN),
}

describe('a therapist is published only with a name AND a recorded consent', () => {
  const named: TherapistCandidate = {
    staffReference: 'Therapist 07',
    displayName: 'A Name',
    photographyConsentRecordedAt: '2026-01-01T00:00:00.000Z',
  }

  it('refuses a therapist with no display name', () => {
    // ADR 0020. `employee` has no `display_name` column at all (0030) precisely so an admin screen cannot
    // fill one in without a consent row and leave the guard invisible.
    const refusals = therapistPublishingRefusals({ ...named, displayName: null })
    expect([...refusals]).toEqual(['no_display_name'])
    expect(mayPublishTherapist({ ...named, displayName: null })).toBe(false)
    expect([...therapistPublishingRefusals({ ...named, displayName: '   ' })]).toEqual([
      'no_display_name',
    ])
  })

  it('refuses a therapist with a name and no photography consent', () => {
    const refusals = therapistPublishingRefusals({ ...named, photographyConsentRecordedAt: null })
    expect([...refusals]).toEqual(['no_photography_consent'])
  })

  it('reports both refusals at once, so one screen is one conversation', () => {
    expect([
      ...therapistPublishingRefusals({
        staffReference: 'Therapist 07',
        displayName: null,
        photographyConsentRecordedAt: null,
      }),
    ]).toEqual(['no_display_name', 'no_photography_consent'])
  })

  it('publishes a therapist who passes, which is the control', () => {
    expect([...therapistPublishingRefusals(named)]).toEqual([])
    const node = personNodeFor(named, PERSON_OPTIONS)
    expect(node.name).toBe('A Name')
    expect(node.worksFor).toEqual({ '@id': organizationId(SPECIMEN_ORIGIN) })
    expect([...node['@type']]).toEqual(['Person'])
  })

  it('throws rather than publishing an empty Person', () => {
    // docs/13 §5 on the alternative: "19 indexed, empty, near-duplicate pages — worse for SEO than having
    // none", with the added property that a machine would repeat it.
    expect(() => personNodeFor({ ...named, displayName: null }, PERSON_OPTIONS)).toThrow(
      /may not be published as a Person/,
    )
  })

  it('filters rather than throwing over a mixed list, because the photo card still renders', () => {
    const nodes = personNodesFor(SPECIMEN_THERAPISTS, PERSON_OPTIONS)
    expect(nodes).toHaveLength(1)
    expect(nodes[0]?.name).toBe('Specimen Therapist')
    // And the one that failed contributes nothing at all — not a node with a blank name.
    expect(JSON.stringify(nodes)).not.toContain('Specimen 02')
  })

  it('publishes the skills and languages as knowsAbout and knowsLanguage, when they exist', () => {
    const node = personNodesFor(SPECIMEN_THERAPISTS, PERSON_OPTIONS)[0]
    expect(node?.knowsAbout).toEqual(['Asian style', 'Arabic style'])
    expect(node?.knowsLanguage).toEqual(['en', 'ar'])
    // Omitted rather than empty when there are none: an empty `knowsLanguage` claims the person speaks
    // nothing.
    const bare = personNodeFor(named, PERSON_OPTIONS)
    expect(bare).not.toHaveProperty('knowsAbout')
    expect(bare).not.toHaveProperty('knowsLanguage')
    expect(
      personNodeFor({ ...named, skills: [], languages: [] }, PERSON_OPTIONS),
    ).not.toHaveProperty('knowsLanguage')
  })

  it('carries the optional fields when they are set', () => {
    const node = personNodeFor(
      {
        ...named,
        jobTitle: 'Senior Therapist',
        portraitUrl: `${SPECIMEN_ORIGIN}/portrait.avif`,
        url: `${SPECIMEN_ORIGIN}/therapists/a-name`,
      },
      PERSON_OPTIONS,
    )
    expect(node.jobTitle).toBe('Senior Therapist')
    expect(node.image).toBe(`${SPECIMEN_ORIGIN}/portrait.avif`)
    expect(node.url).toBe(`${SPECIMEN_ORIGIN}/therapists/a-name`)
  })

  it('identifies a therapist by the internal handle, which is not a name', () => {
    expect(personId(SPECIMEN_ORIGIN, 'Therapist 07')).toBe(
      `${SPECIMEN_ORIGIN}/#therapist-therapist-07`,
    )
  })

  it('adds Physician only under a healthcare licence', () => {
    expect([
      ...personNodeFor(named, { ...PERSON_OPTIONS, licence: 'healthcare' })['@type'],
    ]).toEqual(['Person', 'Physician'])
  })
})

describe('FAQPage derives from the rows and nothing else', () => {
  it('maps each row to a Question with an Answer', () => {
    const node = faqPageNode(SPECIMEN_FAQ, { url: SPECIMEN_PAGE_URL })
    expect(node?.mainEntity).toHaveLength(1)
    expect(node?.mainEntity[0]?.name).toBe(SPECIMEN_FAQ[0]?.question)
    expect(node?.mainEntity[0]?.acceptedAnswer.text).toBe(SPECIMEN_FAQ[0]?.answer)
  })

  it('emits nothing for an empty collection rather than an invalid FAQPage', () => {
    // Google requires at least one Question. An empty `mainEntity` would put an invalid node in every graph
    // on the site for as long as the collection was empty.
    expect(faqPageNode([], { url: SPECIMEN_PAGE_URL })).toBeUndefined()
  })

  it('drops a half-finished row rather than publishing a blank answer', () => {
    const entries = [
      { question: 'Do you take walk-ins?', answer: '   ', topic: 'booking' },
      { question: '  ', answer: 'Yes.', topic: 'booking' },
      { question: 'Real question?', answer: 'Real answer.', topic: 'booking' },
    ]
    const node = faqPageNode(entries, { url: SPECIMEN_PAGE_URL })
    expect(node?.mainEntity).toHaveLength(1)
    expect(node?.mainEntity[0]?.name).toBe('Real question?')
  })

  it('hangs the @id off the page, because an FAQ belongs to the page it is on', () => {
    expect(faqPageNode(SPECIMEN_FAQ, { url: SPECIMEN_PAGE_URL })?.['@id']).toBe(
      `${SPECIMEN_PAGE_URL}#faq`,
    )
  })
})

describe('BreadcrumbList', () => {
  it('numbers the trail from one, contiguously', () => {
    const node = breadcrumbListNode(SPECIMEN_BREADCRUMB, { url: SPECIMEN_PAGE_URL })
    expect(node?.itemListElement.map((item) => item.position)).toEqual([1, 2])
    expect(node?.itemListElement[1]?.item).toBe(`${SPECIMEN_ORIGIN}/treatments`)
  })

  it('emits nothing for the home page, which has no parent', () => {
    // A trail whose only item is the page it is on tells a consumer nothing the URL did not, and Google's own
    // guidance is not to emit one.
    expect(
      breadcrumbListNode([{ name: 'Home', url: SPECIMEN_PAGE_URL }], { url: SPECIMEN_PAGE_URL }),
    ).toBeUndefined()
    expect(breadcrumbListNode([], { url: SPECIMEN_PAGE_URL })).toBeUndefined()
  })
})

describe('the hero media, which is deliberately absent', () => {
  it('emits no ImageObject when nothing serves one', () => {
    // `assets/media/manifest.json` holds four hero stills and no derivative is committed, so there is no URL
    // a crawler could fetch. An ImageObject whose contentUrl 404s is a claim the page fails.
    expect(imageObjectNode(null, { url: SPECIMEN_PAGE_URL })).toBeUndefined()
  })

  it('emits no VideoObject, because there is no video', () => {
    // All 25 assets in the library are stills. A VideoObject for a video that does not exist is the textbook
    // structured-data manual action.
    expect(videoObjectNode(null, { url: SPECIMEN_PAGE_URL })).toBeUndefined()
  })

  it('builds a complete ImageObject when one is served — the control', () => {
    const node = imageObjectNode(
      {
        contentUrl: `${SPECIMEN_ORIGIN}/hero.avif`,
        width: 1280,
        height: 720,
        caption: 'A room',
      },
      { url: SPECIMEN_PAGE_URL },
    )
    expect(node).toEqual({
      '@type': 'ImageObject',
      '@id': `${SPECIMEN_PAGE_URL}#hero-image`,
      contentUrl: `${SPECIMEN_ORIGIN}/hero.avif`,
      url: `${SPECIMEN_ORIGIN}/hero.avif`,
      width: 1280,
      height: 720,
      caption: 'A room',
      representativeOfPage: true,
    })
  })

  it('refuses a relative image URL and a missing dimension', () => {
    expect(() =>
      imageObjectNode(
        { contentUrl: '/hero.avif', width: 1280, height: 720, caption: 'A room' },
        { url: SPECIMEN_PAGE_URL },
      ),
    ).toThrow(/absolute URL/)
    expect(() =>
      imageObjectNode(
        { contentUrl: `${SPECIMEN_ORIGIN}/hero.avif`, width: 0, height: 720, caption: 'A room' },
        { url: SPECIMEN_PAGE_URL },
      ),
    ).toThrow(/real pixel dimensions/)
  })

  it('builds a complete VideoObject when one exists — the control', () => {
    const node = videoObjectNode(
      {
        name: 'Tour',
        description: 'A walk through the rooms.',
        contentUrl: `${SPECIMEN_ORIGIN}/tour.mp4`,
        thumbnailUrls: [`${SPECIMEN_ORIGIN}/tour.jpg`],
        uploadDate: '2026-01-01',
        duration: 'PT1M12S',
        embedUrl: `${SPECIMEN_ORIGIN}/embed/tour`,
      },
      { url: SPECIMEN_PAGE_URL },
    )
    expect(node?.uploadDate).toBe('2026-01-01')
    expect(node?.thumbnailUrl).toEqual([`${SPECIMEN_ORIGIN}/tour.jpg`])
    expect(node?.duration).toBe('PT1M12S')
    expect(node?.embedUrl).toBe(`${SPECIMEN_ORIGIN}/embed/tour`)
  })

  it('refuses the two fields a VideoObject is most often published without', () => {
    const base = {
      name: 'Tour',
      description: 'A walk through the rooms.',
      contentUrl: `${SPECIMEN_ORIGIN}/tour.mp4`,
      thumbnailUrls: [`${SPECIMEN_ORIGIN}/tour.jpg`],
      uploadDate: '2026-01-01',
    }
    expect(() =>
      videoObjectNode({ ...base, thumbnailUrls: [] }, { url: SPECIMEN_PAGE_URL }),
    ).toThrow(/thumbnail/)
    expect(() =>
      videoObjectNode({ ...base, uploadDate: 'last spring' }, { url: SPECIMEN_PAGE_URL }),
    ).toThrow(/ISO 8601/)
    expect(() =>
      videoObjectNode({ ...base, thumbnailUrls: ['/tour.jpg'] }, { url: SPECIMEN_PAGE_URL }),
    ).toThrow(/absolute URL/)
    expect(() =>
      videoObjectNode({ ...base, contentUrl: 'tour.mp4' }, { url: SPECIMEN_PAGE_URL }),
    ).toThrow(/absolute URL/)
  })
})
