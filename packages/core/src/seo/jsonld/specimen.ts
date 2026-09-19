/**
 * A specimen fact sheet and the graphs built from it. Not data — a shape.
 *
 * ## Why a specimen exists at all
 *
 * Three callers need the same one. `scripts/validate-structured-data.mjs` is a gate in `pnpm verify`, which
 * runs before the migrations in CI, so it has no database to read; the unit tests beside this file assert
 * properties of a graph and need a payload to build one from; and `scripts/test-gates.mjs` mutates the
 * builders and needs the identical input, or the mutation and the control would be judged against two
 * different graphs.
 *
 * Two copies of a thirty-field payload is one copy that will drift, and the copy that drifts is the one the
 * gate uses — which is how a gate ends up passing against a shape nothing serves.
 *
 * ## Why it is NOT this business
 *
 * Every value here is invented and deliberately unlike the real one. `premises` is the only place this
 * business's name, address and numbers may be written down (docs/09 §4), and
 * `packages/db/src/seed/premises.test.ts` greps every `.ts`, `.tsx` and `.mjs` under `packages/`, `apps/` and
 * `scripts/` for a violation. A specimen carrying the real street would need an exemption, and the
 * exemption list is closed.
 *
 * What a specimen has to exercise is the *shape*, and none of that needs the real values:
 *
 *   - a session that **crosses midnight**, which is the case `openingHoursSpecifications` exists for;
 *   - a **null coordinate**, which is what `premises` holds and what `geoNode` must omit rather than invent;
 *   - an **unconfirmed WhatsApp number**, whose branch carries no digits at all;
 *   - an offering with **no price**, which is a table with no price column (0032);
 *   - a therapist who **passes** the publishing guard and one who fails it on both counts.
 *
 * The trading window is 12:00–03:00 rather than the business's own hours for the same reason: it crosses
 * midnight, and it is unmistakably a specimen. The hours grep is scoped to `apps/web` and `packages/ui`, so
 * this file could legally carry the real ones — and a second copy of the most consequential operational fact
 * in the system is not worth having for a specimen that does not need it.
 *
 * ## Why it is parsed rather than asserted
 *
 * `factsSchema.parse` on the way out. The payload has thirty-odd fields across five nested blocks, and a
 * specimen that stopped matching the contract would go on exercising the builders with a shape nothing
 * serves. Parsing means a field added to `factsSchema` fails every caller until the specimen declares it.
 */
import { type Facts, factsSchema } from '@berelax/shared'
import type { BreadcrumbStep, FaqEntry, TherapistCandidate } from './content.ts'
import type { StructuredDataInput } from './graph.ts'
import type { LicenceClass } from './vocabulary.ts'

/** The origin every specimen URL hangs off. `.test` is reserved by RFC 6761 and resolves nowhere. */
export const SPECIMEN_ORIGIN = 'https://example.test'
export const SPECIMEN_PAGE_URL = `${SPECIMEN_ORIGIN}/`

/** The specimen's trading window. Crosses midnight, which is the only property that matters. */
export const SPECIMEN_OPENS = '12:00'
export const SPECIMEN_CLOSES = '03:00'

/**
 * The specimen fact sheet.
 *
 * `overrides` is a shallow merge over the top-level blocks, which is what every caller needs: a test that
 * wants a coordinate replaces `geo` whole rather than reaching into it, and a shallow merge makes that the
 * only way to do it — so a test cannot accidentally leave a half-populated block behind.
 */
export function specimenFacts(overrides: Partial<Facts> = {}): Facts {
  const base = {
    schemaVersion: 1,
    generatedAt: '2026-01-01T00:00:00.000Z',
    canonicalUrl: `${SPECIMEN_ORIGIN}/api/facts`,
    names: {
      legal: 'SPECIMEN WELLNESS LLC',
      trading: 'Specimen Wellness Rooms',
      display: 'Specimen Wellness Rooms and Spa',
    },
    address: {
      line1: '1 Specimen Road',
      line2: 'Block Q',
      floor: 'Ground',
      area: 'Specimen District',
      areaAliases: ['Specimen Quarter'],
      emirate: 'Specimen Emirate',
      countryCode: 'AE',
      poBox: null,
      makaniNumber: null,
      oneLine: '1 Specimen Road, Block Q, Ground, Specimen District, Specimen Emirate, AE',
    },
    geo: {
      latitude: null,
      longitude: null,
      plusCode: null,
      placeId: null,
      mapUrl: `${SPECIMEN_ORIGIN}/map`,
      directionsUrl: `${SPECIMEN_ORIGIN}/directions`,
    },
    contact: {
      landline: { e164: '+97120000000', display: '+971 2 000 0000' },
      mobile: { e164: '+971500000000', display: '+971 50 000 0000' },
      whatsapp: {
        status: 'unconfirmed',
        provisional: true,
        openQuestionId: 'Y1-nap',
        why: 'the specimen mirrors the real payload: no confirmed number, and so no digits anywhere',
        number: null,
      },
      email: null,
    },
    hours: {
      timezone: 'Asia/Dubai',
      weekly: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
        dayOfWeek,
        opens: SPECIMEN_OPENS,
        closes: SPECIMEN_CLOSES,
        // The generated column's value, carried across. Never recomputed from the two times above.
        closesNextDay: true,
        isClosed: false,
      })),
      crossesMidnight: true,
      exceptions: [],
      ramadan: [],
    },
    parkingNotes: 'Specimen parking note',
    directionsNotes: null,
    catalogue: {
      currency: 'AED',
      vatInclusive: true,
      pricePointCount: 8,
      services: [
        {
          style: 'asian',
          treatmentKey: 'normal_massage',
          slug: 'specimen-normal-massage-asian',
          name: 'Specimen Normal Massage (Asian)',
          variants: [
            { durationMinutes: 45, grossFils: '17000', grossAed: '170.00' },
            { durationMinutes: 60, grossFils: '20000', grossAed: '200.00' },
            { durationMinutes: 90, grossFils: '30000', grossAed: '300.00' },
            { durationMinutes: 120, grossFils: '40000', grossAed: '400.00' },
          ],
        },
        {
          style: 'arabic',
          treatmentKey: 'hot_oil_massage',
          slug: 'specimen-hot-oil-massage-arabic',
          name: 'Specimen Hot Oil Massage (Arabic)',
          variants: [
            { durationMinutes: 45, grossFils: '25000', grossAed: '250.00' },
            { durationMinutes: 60, grossFils: '30000', grossAed: '300.00' },
            { durationMinutes: 90, grossFils: '40000', grossAed: '400.00' },
            { durationMinutes: 120, grossFils: '50000', grossAed: '500.00' },
          ],
        },
      ],
      onRequest: [
        {
          label: 'Specimen Four Hands',
          requirement: 'Two therapists, one room, one client',
          provisional: true,
          openQuestionId: 'Y9-poa-prices',
        },
      ],
    },
    provisional: [
      { field: 'contact.whatsapp', openQuestionId: 'Y1-nap', note: 'no confirmed number' },
    ],
    unanswered: [{ field: 'geo.latitude', why: 'no coordinate is recorded' }],
  }
  return factsSchema.parse({ ...base, ...overrides })
}

/** A therapist who passes ADR 0020's guard, and one who fails it on both counts. */
export const SPECIMEN_THERAPISTS: readonly TherapistCandidate[] = Object.freeze([
  {
    staffReference: 'Specimen 01',
    displayName: 'Specimen Therapist',
    photographyConsentRecordedAt: '2026-01-01T00:00:00.000Z',
    skills: ['Asian style', 'Arabic style'],
    languages: ['en', 'ar'],
  },
  { staffReference: 'Specimen 02', displayName: null, photographyConsentRecordedAt: null },
])

export const SPECIMEN_FAQ: readonly FaqEntry[] = Object.freeze([
  {
    question: 'Do you take walk-ins?',
    answer: 'Yes, subject to a room and a therapist being free.',
    topic: 'booking',
  },
])

export const SPECIMEN_BREADCRUMB: readonly BreadcrumbStep[] = Object.freeze([
  { name: 'Home', url: SPECIMEN_PAGE_URL },
  { name: 'Treatments', url: `${SPECIMEN_ORIGIN}/treatments` },
])

/** One specimen graph: what it is for, the licence it is built under, and what must be in it. */
export interface SpecimenGraph {
  readonly label: string
  readonly licence: LicenceClass
  readonly input: StructuredDataInput
  /** Types whose absence is a finding, so a specimen cannot pass by emitting less. */
  readonly requireTypes: readonly string[]
}

/**
 * The three graphs the gate and the tests both build.
 *
 * The third one is the important one: it is the shape the real database holds today — no therapist passes
 * the guard, no hero derivative is served, no profile URL is recorded — and it is the graph the site
 * actually emits. The first two exist so that the builders are exercised with every node type populated,
 * which is the only way `personNodesFor`, `faqPageNode`, `imageObjectNode` and `videoObjectNode` are ever
 * seen to produce anything.
 */
export function specimenGraphs(): readonly SpecimenGraph[] {
  const facts = specimenFacts()
  const populated = {
    facts,
    pageUrl: SPECIMEN_PAGE_URL,
    origin: SPECIMEN_ORIGIN,
    includeCatalogue: true,
    breadcrumb: SPECIMEN_BREADCRUMB,
    faq: SPECIMEN_FAQ,
    therapists: SPECIMEN_THERAPISTS,
    heroImage: {
      contentUrl: `${SPECIMEN_ORIGIN}/m/specimen/0123456789abcdef/hero-wide-1280.avif`,
      width: 1280,
      height: 720,
      caption: 'Specimen treatment room with a linen-draped bed',
    },
    heroVideo: {
      name: 'Specimen room tour',
      description: 'A walk through the specimen treatment rooms.',
      contentUrl: `${SPECIMEN_ORIGIN}/media/specimen-tour.mp4`,
      thumbnailUrls: [`${SPECIMEN_ORIGIN}/media/specimen-tour.jpg`],
      uploadDate: '2026-01-01',
      duration: 'PT1M12S',
    },
    sameAsProfiles: [{ kind: 'tripadvisor' as const, url: `${SPECIMEN_ORIGIN}/specimen-listing` }],
  }
  return [
    {
      label: 'a fully populated graph under the seeded licence class (unconfirmed)',
      licence: 'unconfirmed',
      input: { ...populated, licence: 'unconfirmed' },
      requireTypes: [
        'DaySpa',
        'Organization',
        'Service',
        'Person',
        'FAQPage',
        'BreadcrumbList',
        'ImageObject',
        'VideoObject',
      ],
    },
    {
      label: 'the same graph under a healthcare licence, where the medical types are permitted',
      licence: 'healthcare',
      input: { ...populated, licence: 'healthcare' },
      requireTypes: ['DaySpa', 'MedicalClinic', 'MedicalTherapy', 'Physician'],
    },
    {
      label: 'a graph shaped like the seeded data: no people, no hero media, no recorded profiles',
      licence: 'unconfirmed',
      input: {
        facts,
        pageUrl: SPECIMEN_PAGE_URL,
        origin: SPECIMEN_ORIGIN,
        licence: 'unconfirmed',
        includeCatalogue: true,
        therapists: [],
        faq: [],
        breadcrumb: [],
        heroImage: null,
        heroVideo: null,
      },
      requireTypes: ['DaySpa', 'Organization', 'Service'],
    },
  ]
}
