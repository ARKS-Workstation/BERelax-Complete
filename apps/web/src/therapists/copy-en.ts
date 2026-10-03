import type { TherapistsCopy } from './copy-shape.ts'

/**
 * The therapist pages, in English.
 *
 * Every sentence here is about the MECHANISM or about what is on file. Nothing describes a therapist: the
 * build has nineteen photographs, no names, no languages, no credentials and no first-person notes
 * (Y12-names, Y12-consent-photo, Y8-staff), and a page of warm copy about unnamed people would be the
 * nineteen near-duplicate pages docs/13 §5 calls *"worse for SEO than having none"*.
 */
export const THERAPISTS_COPY_EN: TherapistsCopy = {
  home: 'Home',
  index: {
    title: 'The therapists',
    lede:
      'Every therapist on the floor. A therapist has a page of their own once they have told us the name ' +
      'they want published and given their consent to be photographed — until then the card shows no ' +
      'name and leads nowhere.',
    empty: 'Nobody is on the roster.',
    unnamedTherapist: 'Name not yet published',
    provisionalPortrait: 'Portrait pending',
  },
  detail: {
    specialisms: 'Trained in',
    languages: 'Speaks',
    languagesUnknown: 'No language is recorded for this therapist yet.',
    availability: 'Next available',
    bookWith: (name: string) => `Book with ${name}`,
    noVariant: 'Nothing on the menu matches what this therapist is trained in.',
    alternatives: {
      title: 'No times free',
      lede: 'Three ways on from here, rather than an empty list.',
      nearestDays: 'The nearest days with space',
      otherTherapists: 'The same treatment with another therapist',
      waitlist: 'Join the waitlist for this day',
      waitlistRefused: (reason: string) => `A waitlist join is not on offer: ${reason}.`,
      noDays: 'No day in the fortnight either side has space.',
      noTherapists: 'No other therapist has space on this day.',
    },
  },
  skills: { asian_style: 'Asian-style massage', arabic_style: 'Arabic-style massage' },
  skillJoin: ' and ',
}
