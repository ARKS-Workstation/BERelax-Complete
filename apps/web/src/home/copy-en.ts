import type { HomeCopy } from './content.ts'

/**
 * The home page in English. Labels and sentences about the page — never a fact.
 *
 * Every figure, name, address line and opening time on this page comes from the premises row, the legal
 * entity or the catalogue and is interpolated by the component.
 * `packages/db/src/seed/premises.test.ts` asserts that from the other direction, and it used to grant this
 * route an exemption for the district it named in prose; W-SITE-02 retired the exemption by deleting the
 * literal, and this unit is what replaces it with the row.
 *
 * ## The words this file may not use
 *
 * `treatment`, `therapy`, `therapeutic`, `medical` and nine more are on
 * `regulatory_profile.banned_claim_terms` under the seeded profile (`licence_class = unconfirmed`), and this
 * page's rendered copy goes through that lint — `homePageData` reads the policy and the route calls
 * `assertPageCopyCompliant`. So the menu is a **menu**, a treatment is a **session** or a **massage**, and
 * the heading over the roster says what it is. `src/cms/content.ts` records the same discipline for the five
 * CMS routes and the same reason: it is a consequence of `Y1-licence` being open, not a style choice. The
 * day a lawyer confirms the licence class, `medical_claims_permitted` flips in a row and the vocabulary
 * widens with no code change.
 *
 * The one apparent exception is the service names themselves, which come from the catalogue: they are
 * linted when they are written (`setPublicDisplayName` and `seedCatalogue` both refuse an unlinted one) and
 * linted again here, so a name that arrived through `psql` fails the build on this page.
 */
export const HOME_COPY_EN: HomeCopy = {
  home: 'Home',
  eyebrow: 'Abu Dhabi',
  heading: 'BE RELAX',
  lede: 'A massage centre and spa, open from late morning until the first hours after midnight.',
  hero: {
    // The hero is the one image on the page nobody scrolls past, so the alt text describes the room rather
    // than the brand. Which photograph belongs in the hero slot is `Y12-photos`; this is the one that is
    // committed, and `assets/media/README.md` records that it came from the business's own site.
    alt: 'The spa, photographed for the business’s own site.',
    play: 'Play the background film',
    pause: 'Pause the background film',
  },
  onThisPage: 'On this page',
  sections: {
    about: {
      heading: 'What this place is',
      lede:
        'The full name and the district, because there is a second business trading under a similar short ' +
        'name in this city and they are not the same spa.',
    },
    services: {
      heading: 'The menu',
      lede: 'Every massage on the menu has its own page, with the durations and what each one costs.',
    },
    team: {
      heading: 'The therapists',
      lede:
        'The people who work here. No name is published until the person has agreed to it in writing and ' +
        'that agreement has been recorded, so most of these cards carry a reference and not a name.',
    },
    gallery: {
      heading: 'The rooms',
      // What the three photographs show is not stated anywhere, so this does not state it either. An earlier
      // draft said "the rooms, the hammam and the arrival", which reads better and is a claim about three
      // files nobody has described — Y12-photos is the audit that chooses the photography per slot.
      lede: 'The premises, photographed for the business’s own site.',
    },
    reviews: {
      heading: 'What guests say',
      lede:
        'Reviews left on Google, quoted as they were written. Nothing on this page is written by the ' +
        'business about itself.',
    },
    contact: {
      heading: 'Where to find us',
      lede: 'The address, the numbers and the hours, from the one record that holds them.',
    },
  },
  labels: {
    and: 'and',
    seeTreatment: (name: string) => `${name} — read more`,
    durationSeparator: ' · ',
    // Not a placeholder to fill in later: it is the sentence a card says while the question is open, and
    // `Y12-names` and `Y12-consent-photo` are the two answers that would change it.
    unnamedTherapist: 'Name not yet published',
    skills: { asian_style: 'Asian style', arabic_style: 'Arabic style' },
    skillSeparator: ', ',
    noReviews:
      'No review has been recorded in this system yet. When one is, it will appear here quoted from ' +
      'Google — the business publishes none of its own.',
    reviewBy: (name: string) => `— ${name}, on Google`,
    bookBar: 'Call to book',
    bookBarLabel: (telephone: string) => `Call ${telephone} to book`,
    // One sentence for all three, because nobody has said which interior each file shows: `Y12-photos` is
    // the audit that picks the photography per slot, and a specific description would be invented.
    galleryAlt: (index: number) =>
      `An interior of the spa, from the business’s own photography (${index} of 3).`,
    menuSize: (services: number, pricePoints: number) =>
      `${services} massages on the menu, ${pricePoints} priced durations between them.`,
    rosterSize: (therapists: number) => `${therapists} people on the roster.`,
  },
}
