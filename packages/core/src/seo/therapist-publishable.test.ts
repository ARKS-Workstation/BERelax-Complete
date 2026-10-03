import { describe, expect, it } from 'vitest'
import { isEmployeePublishable } from '../hr/employee.ts'
import {
  generatedIsPublishableFor,
  isTherapistPublishable,
  knowsAboutFor,
  type LiveService,
  servicesForSpecialism,
  type TherapistCandidate,
  therapistDisposition,
  therapistPublishingRefusals,
  therapistSlug,
} from './therapist-publishable.ts'

/** The only state the real roster is in: nineteen of these (Y12-names, Y12-consent-photo). */
const UNNAMED: TherapistCandidate = {
  staffReference: 'Therapist 07',
  displayName: null,
  photographyConsentRecordedAt: null,
  retiredAt: null,
}

const PUBLISHABLE: TherapistCandidate = {
  staffReference: 'Therapist 07',
  displayName: 'A Name',
  photographyConsentRecordedAt: '2026-01-01T00:00:00.000Z',
  retiredAt: null,
}

describe('the four combinations of a display name and a recorded photography consent', () => {
  /*
    The acceptance criterion's own parameterisation, as a table. Only the both-present case may publish,
    and the three that may not are three DIFFERENT absences — which is why the refusals are asserted by
    name rather than by count: a guard that answered `false` for the right rows and the wrong reason would
    pass a count assertion and give an admin screen the wrong thing to fix.
  */
  const cases: readonly {
    readonly name: string
    readonly candidate: TherapistCandidate
    readonly publishable: boolean
    readonly refusals: readonly string[]
  }[] = [
    {
      name: 'neither',
      candidate: UNNAMED,
      publishable: false,
      refusals: ['no_display_name', 'no_photography_consent'],
    },
    {
      name: 'a name and no consent',
      candidate: { ...UNNAMED, displayName: 'A Name' },
      publishable: false,
      refusals: ['no_photography_consent'],
    },
    {
      name: 'a consent and no name',
      candidate: { ...UNNAMED, photographyConsentRecordedAt: '2026-01-01T00:00:00.000Z' },
      publishable: false,
      refusals: ['no_display_name'],
    },
    { name: 'both', candidate: PUBLISHABLE, publishable: true, refusals: [] },
  ]

  for (const entry of cases) {
    it(`${entry.name}: publishable is ${String(entry.publishable)}`, () => {
      expect(isTherapistPublishable(entry.candidate)).toBe(entry.publishable)
      expect([...therapistPublishingRefusals(entry.candidate)]).toEqual(entry.refusals)
    })
  }

  it('exactly one of the four combinations publishes, which is the control', () => {
    expect(cases.filter((entry) => isTherapistPublishable(entry.candidate))).toHaveLength(1)
  })

  it('agrees with the generated column mirror over all four, which is what holds the two equal', () => {
    /*
      `isEmployeePublishable` (P-HR-01) mirrors `employee.is_publishable`, which is GENERATED as
      `display_name is not null and photo_consent`. It is a claim about what the DATABASE computes, where
      this module's is a claim about whether a PAGE may be published — the pair plus retirement plus the
      portrait's alt text. Both have to exist and both are the pair underneath, so this is the assertion
      the brief asks for whenever a fact is stated twice.
    */
    for (const entry of cases) {
      const pairRefusals = therapistPublishingRefusals(entry.candidate).filter(
        (refusal) => refusal !== 'portrait_without_alt',
      )
      expect(generatedIsPublishableFor(entry.candidate), entry.name).toBe(pairRefusals.length === 0)
      expect(
        isEmployeePublishable({
          displayName: entry.candidate.displayName,
          photoConsent: entry.candidate.photographyConsentRecordedAt !== null,
        }),
        entry.name,
      ).toBe(pairRefusals.length === 0)
    }
    // The control: the mirror and the page guard DISAGREE for a retired therapist, which is the whole
    // reason there are two. A test that found them identical everywhere would have proved they are one
    // function under two names, and this is where that would be visible.
    const retired = { ...PUBLISHABLE, retiredAt: '2026-06-30T00:00:00.000Z' }
    expect(generatedIsPublishableFor(retired)).toBe(true)
    expect(isTherapistPublishable(retired)).toBe(false)
  })
})

describe('a portrait with no alt text refuses the page', () => {
  it('refuses a portrait URL with no alt, and with blank alt', () => {
    const portrait = { ...PUBLISHABLE, portraitUrl: 'https://example.test/p.avif' }
    expect([...therapistPublishingRefusals(portrait)]).toEqual(['portrait_without_alt'])
    expect([...therapistPublishingRefusals({ ...portrait, portraitAlt: '  ' })]).toEqual([
      'portrait_without_alt',
    ])
  })

  it('publishes the same therapist once the alt is there, which is the control', () => {
    expect(
      isTherapistPublishable({
        ...PUBLISHABLE,
        portraitUrl: 'https://example.test/p.avif',
        portraitAlt: 'A therapist in the treatment room',
      }),
    ).toBe(true)
  })

  it('does not refuse a therapist with no portrait at all', () => {
    // While Y12-photos is open the card serves a palette-matched placeholder, which is not a portrait and
    // has nothing to label. A refusal here would make the launch state unpublishable for the wrong reason.
    expect(isTherapistPublishable(PUBLISHABLE)).toBe(true)
  })
})

describe('departure redirects and never 404s (docs/09 §2)', () => {
  const RETIRED = { ...PUBLISHABLE, retiredAt: '2026-06-30T00:00:00.000Z' }

  it('a retired therapist who was publishable is retired, not unpublished', () => {
    expect(therapistDisposition(RETIRED)).toEqual({ kind: 'retired' })
    // And not publishable: a 301 is not a page, so it earns no 200, no sitemap entry and no Person node.
    expect(isTherapistPublishable(RETIRED)).toBe(false)
  })

  it('a retired therapist who was never publishable is unpublished, because no URL exists to redirect', () => {
    expect(therapistDisposition({ ...UNNAMED, retiredAt: '2026-06-30T00:00:00.000Z' })).toEqual({
      kind: 'unpublished',
      refusals: ['no_display_name', 'no_photography_consent'],
    })
  })

  it('the three dispositions are distinguishable, which is the control', () => {
    expect(therapistDisposition(PUBLISHABLE).kind).toBe('published')
    expect(therapistDisposition(UNNAMED).kind).toBe('unpublished')
    expect(therapistDisposition(RETIRED).kind).toBe('retired')
  })
})

describe('the slug', () => {
  it('is the display name reduced to URL characters', () => {
    expect(therapistSlug('A Name')).toBe('a-name')
    expect(therapistSlug('  Two   Words  ')).toBe('two-words')
    expect(therapistSlug("O'Hara-Smith")).toBe('o-hara-smith')
  })

  it('strips combining marks rather than dropping the letter', () => {
    expect(therapistSlug('Zoë')).toBe('zoe')
  })

  it('refuses a name that reduces to nothing, because that slug IS the index', () => {
    expect(() => therapistSlug('—')).toThrow(/empty slug/)
    expect(() => therapistSlug('')).toThrow(/empty slug/)
  })

  it('collides for two distinct display names, which is why the database holds a unique index', () => {
    // The defect TypeScript cannot refuse: `employee_display_name_unique` is satisfied by both of these,
    // and without `employee_public_slug_unique` (0157) they are two therapists at one URL.
    expect(therapistSlug('Anna-Maria')).toBe(therapistSlug('Anna Maria'))
  })
})

describe('knowsAbout resolves specialisms against the live catalogue', () => {
  const LIVE: readonly LiveService[] = [
    { slug: 'asian-normal-massage', name: 'Asian normal massage', requiredSkill: 'asian_style' },
    { slug: 'asian-oil-massage', name: 'Asian oil massage', requiredSkill: 'asian_style' },
    {
      slug: 'arabic-hot-oil-massage',
      name: 'Arabic hot oil massage',
      requiredSkill: 'arabic_style',
    },
  ]

  it('maps a specialism to every live service of that style', () => {
    expect(servicesForSpecialism('asian_style', LIVE).map((service) => service.slug)).toEqual([
      'asian-normal-massage',
      'asian-oil-massage',
    ])
  })

  it('names the specialism when it resolves to nothing live', () => {
    expect(() => servicesForSpecialism('thai_style', LIVE)).toThrow(/'thai_style'/)
    // The control for the ADR 0021 trap: a STYLE where a SKILL belongs resolves to nothing, rather than
    // half-matching. `asian` is what `service.style` holds and `asian_style` is what a skill row holds.
    expect(() => servicesForSpecialism('asian', LIVE)).toThrow(/'asian'/)
    expect(() => servicesForSpecialism('arabic_style', [])).toThrow(
      /resolves to no live catalogue service/,
    )
  })

  it('publishes service names, sorted and deduplicated', () => {
    expect([...knowsAboutFor(['asian_style', 'arabic_style', 'asian_style'], LIVE)]).toEqual([
      'Arabic hot oil massage',
      'Asian normal massage',
      'Asian oil massage',
    ])
  })

  it('fails the whole list when one specialism is dead, rather than publishing the rest', () => {
    // Half a knowsAbout is worse than a refusal: the page still publishes, the missing expertise is
    // invisible, and the archived service is still in the skill row for the next reader to re-discover.
    expect(() => knowsAboutFor(['asian_style', 'thai_style'], LIVE)).toThrow(/'thai_style'/)
  })
})
