import type { TherapistPageRow } from '@berelax/db'
import { THERAPIST_SKILLS } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import {
  bookWithHref,
  qualificationPhrase,
  therapistIndexCards,
  therapistPath,
  therapistsIndexPath,
} from './content.ts'
import { THERAPISTS_COPY_AR } from './copy-ar.ts'
import { THERAPISTS_COPY_EN } from './copy-en.ts'

/** A row in the launch state: no name, no consent, one provisional skill. */
const UNNAMED: TherapistPageRow = {
  id: '00000000-0000-7000-8000-000000000001',
  staffReference: 'Therapist 07',
  displayName: null,
  publicSlug: null,
  photoConsent: false,
  photoConsentRecordedAt: null,
  isPublishable: false,
  retiredAt: null,
  skills: ['asian_style'],
  languages: [],
  lastModified: '2026-01-01T00:00:00.000Z',
}

const PUBLISHED: TherapistPageRow = {
  ...UNNAMED,
  id: '00000000-0000-7000-8000-000000000002',
  staffReference: 'Therapist 08',
  displayName: 'A Name',
  publicSlug: 'a-name',
  photoConsent: true,
  photoConsentRecordedAt: '2026-02-01T00:00:00.000Z',
  isPublishable: true,
}

const skillLabel = (skills: readonly string[]): string | undefined =>
  qualificationPhrase(skills, THERAPISTS_COPY_EN.skills, THERAPISTS_COPY_EN.skillJoin)

describe('the index card is where the publication guard is visible', () => {
  it('gives an unpublishable therapist no name and no href', () => {
    const [card] = therapistIndexCards([UNNAMED], 'en', skillLabel)
    expect(card?.reference).toBe('Therapist 07')
    expect(card).not.toHaveProperty('displayName')
    // Absent, not empty: `TherapistCard` renders no anchor element at all for an absent href, and an `<a>`
    // with no href is still announced as a link by some screen readers.
    expect(card).not.toHaveProperty('href')
    expect(card?.qualifications).toBe('Asian-style massage')
  })

  it('gives a NAMED therapist with no consent a slug and still no href', () => {
    /*
      The case the guard is really about, and the one an unnamed row cannot exercise: this therapist HAS a
      display name and therefore has a `public_slug` (0157's equivalence), so the card has a URL available
      to link — and must not use it, because the photography consent is not on record. A test over the
      unnamed rows alone would pass against a card component that linked every row with a slug, since
      those rows have none.
    */
    const namedNoConsent: TherapistPageRow = {
      ...UNNAMED,
      displayName: 'Probe Therapist 02',
      publicSlug: 'probe-therapist-02',
    }
    const [card] = therapistIndexCards([namedNoConsent], 'en', skillLabel)
    expect(card).not.toHaveProperty('href')
    // And no name either: a name on an unlinked card is still the name published.
    expect(card).not.toHaveProperty('displayName')
    expect(bookWithHref(namedNoConsent, 'en')).toBeNull()
  })

  it('gives a publishable therapist both, which is the control', () => {
    const [card] = therapistIndexCards([PUBLISHED], 'en', skillLabel)
    expect(card?.displayName).toBe('A Name')
    expect(card?.href).toBe('/therapists/a-name')
  })

  it('gives a retired therapist no card at all, because a card is an offer to book them', () => {
    const retired = { ...PUBLISHED, retiredAt: '2026-06-30T00:00:00.000Z' }
    expect(therapistIndexCards([retired], 'en', skillLabel)).toEqual([])
    // Their PAGE still answers — a 301 — which is docs/09 §2's departure clause. The card is the half that
    // goes, and these are different claims about the same person.
    expect(therapistIndexCards([retired, PUBLISHED], 'en', skillLabel)).toHaveLength(1)
  })

  it('links into the reader own locale tree', () => {
    expect(therapistIndexCards([PUBLISHED], 'ar', skillLabel)[0]?.href).toBe(
      '/ar/therapists/a-name',
    )
    expect(therapistsIndexPath('ar')).toBe('/ar/therapists')
    expect(therapistPath('en', 'a-name')).toBe('/therapists/a-name')
  })
})

describe('"Book with" exists only for a therapist the site may name', () => {
  it('carries the employee id, which is what the solver filters on', () => {
    expect(bookWithHref(PUBLISHED, 'en')).toBe(`/book?therapist=${PUBLISHED.id}`)
    expect(bookWithHref(PUBLISHED, 'ar')).toBe(`/ar/book?therapist=${PUBLISHED.id}`)
  })

  it('is null for an unpublishable and for a retired therapist', () => {
    // An action naming somebody the site may not name is an action that names them.
    expect(bookWithHref(UNNAMED, 'en')).toBeNull()
    expect(bookWithHref({ ...PUBLISHED, retiredAt: '2026-06-30T00:00:00.000Z' }, 'en')).toBeNull()
  })
})

describe('the skill labels are total over the enum, in both locales', () => {
  it('has a label for every therapist_skill value', () => {
    // Without this, `qualificationPhrase` drops an unlabelled skill — so a new enum value would vanish
    // from every card rather than appearing untranslated, which is the quieter of the two failures.
    for (const skill of THERAPIST_SKILLS) {
      expect(THERAPISTS_COPY_EN.skills[skill], skill).toBeDefined()
      expect(THERAPISTS_COPY_AR.skills[skill], skill).toBeDefined()
    }
    expect(Object.keys(THERAPISTS_COPY_EN.skills).sort()).toEqual([...THERAPIST_SKILLS].sort())
    expect(Object.keys(THERAPISTS_COPY_AR.skills).sort()).toEqual([...THERAPIST_SKILLS].sort())
  })

  it('joins two skills and drops an unknown one rather than printing the enum value', () => {
    expect(skillLabel(['asian_style', 'arabic_style'])).toBe(
      'Asian-style massage and Arabic-style massage',
    )
    expect(skillLabel(['thai_style'])).toBeUndefined()
    expect(skillLabel([])).toBeUndefined()
  })

  it('says it in Arabic, and not in English', () => {
    for (const skill of THERAPIST_SKILLS) {
      expect(THERAPISTS_COPY_AR.skills[skill], skill).not.toBe(THERAPISTS_COPY_EN.skills[skill])
    }
  })
})
