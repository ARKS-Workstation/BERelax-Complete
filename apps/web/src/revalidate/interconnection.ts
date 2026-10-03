/**
 * docs/09 §5's interconnection map, as a table a test can read row by row.
 *
 * The document says *"This is what 'everything interconnected' actually means, concretely"* and then
 * gives a table: a change on the left, the surfaces it cascades to on the right. Eight of its rows are
 * W-SITE-08's acceptance criterion, and the criterion's shape is the thing worth noticing — *"each row
 * purges exactly its declared cache tags **and no others**"*.
 *
 * ## Why "and no others" is the half that matters
 *
 * Over-purging is the failure nobody reports. A settings change that purged every tag would make every
 * test about propagation pass, and the cost would be invisible: the cache empties on a change that
 * touched one page, the site serves cold for a few minutes, and nothing anywhere says that is what
 * happened. So the expected set is EXACT, and the test compares sets rather than asserting membership.
 *
 * ## Why this is a declared table and not derived from the settings registry
 *
 * `invalidationsFor(key)` in `@berelax/config` already answers "which tags does changing this SETTING
 * invalidate", and three of the eight rows are settings. The other five are not settings at all — a
 * service price, publishing a therapist, archiving a therapist, hero media and a package template are
 * ROW changes — so a map derived from the settings registry could only ever cover three-eighths of the
 * document, and the missing five are the ones with money and a person's name in them. The two are held
 * equal where they overlap: `interconnection.test.ts` asserts each settings-backed row against
 * `invalidationsFor`, so the table cannot drift from the registry.
 */
import { type CacheTag, invalidationsFor } from '@berelax/config'

/**
 * The eight changes docs/09 §5's table names, by the words the document uses.
 *
 * Keys spelled from the document rather than from the code, so a reader can hold the two side by side.
 * `accent_density_radius` is one row in the document ("Accent / density / radius") and is one row here:
 * the three are separate settings and they cascade identically, and splitting them would invite a
 * reader to assume the difference means something.
 */
export const INTERCONNECTION_CHANGES = [
  'address',
  'opening_hours',
  'service_price',
  'publish_therapist',
  'archive_therapist',
  'accent_density_radius',
  'hero_media',
  'package_template',
] as const
export type InterconnectionChange = (typeof INTERCONNECTION_CHANGES)[number]

/** One row: the tags it purges, and the settings keys behind it when it is a settings change. */
export interface InterconnectionRow {
  /** Exactly the tags this change purges. Compared as a SET; see the module header. */
  readonly cacheTags: readonly CacheTag[]
  /**
   * The settings keys this row is driven by, or an empty list when it is a row change.
   *
   * Non-empty rows are cross-checked against `invalidationsFor`, which is what holds this table and the
   * settings registry equal. An empty list is a claim too — *this change is not a setting* — and the test
   * asserts that no key in the registry claims otherwise.
   */
  readonly settingKeys: readonly string[]
  /** The sentence from docs/09 §5, so the expectation and the specification are side by side. */
  readonly cascadesTo: string
}

/**
 * The table.
 *
 * Every row's `cacheTags` is the EXACT set, and the sets are small on purpose: the whole argument for
 * cache tags over "revalidate everything" is that the cost of a change is proportional to the change
 * rather than to the size of the site.
 */
export const INTERCONNECTION_MAP: Readonly<Record<InterconnectionChange, InterconnectionRow>> = {
  /*
    "Address → LocalBusiness JSON-LD · footer NAP · /contact · /spa · map embed · sitemap · OG image ·
    /api/facts · flags a GBP consistency check · invoices snapshot the issuing address, so historic
    invoices never change."

    `premises` is every surface that renders the row; `facts` is `/api/facts` and `llms.txt`;
    `schema-jsonld` is the `LocalBusiness` node. NOT `catalogue` and NOT `availability`: an address change
    moves no price and frees no slot, and purging them would be the over-purge this file is about. The
    invoice clause needs no tag at all — an issued invoice snapshots the address (ADR 0008), so there is
    nothing cached to invalidate and nothing to recompute.
  */
  address: {
    cacheTags: ['premises', 'facts', 'schema-jsonld'],
    // No settings keys: the address is the `premises` ROW (W-SITE-02 made it the only NAP source), not a
    // configuration value. `invalidationsFor` therefore has nothing to say about this row, which is why
    // the table cannot be derived from the settings registry — see the module header.
    settingKeys: [],
    cascadesTo:
      'LocalBusiness JSON-LD, footer NAP, /contact, /spa, the map embed, the sitemap, the OG image, ' +
      '/api/facts, and a flagged GBP consistency check. Historic invoices never change: they snapshot ' +
      'the issuing address.',
  },
  /*
    "Opening hours → Availability engine · OpeningHoursSpecification · GBP consistency check · reminder
    copy · the 'no availability' alternatives."

    `availability` is the one that matters and the one a tag-less implementation forgets: the solver's
    answers are memoised, so an hours change that purged only the pages would leave the booking flow
    offering slots outside trading hours until the memo expired.
  */
  opening_hours: {
    cacheTags: ['premises', 'facts', 'schema-jsonld', 'availability'],
    // Also a row, not a setting: `premises_hours` plus any dated `premises_hours_override`. The booking
    // settings that DO invalidate `availability` (turnaround, lead time, buffer) are a different change
    // and have their own rows in the settings registry.
    settingKeys: [],
    cascadesTo:
      'the availability engine, OpeningHoursSpecification, the GBP consistency check, reminder copy, ' +
      'and the no-availability alternatives.',
  },
  /*
    "Service price → Treatment page · Offer schema · pricing page · booking flow · snapshotted onto future
    bookings, never historic ones."

    `catalogue` covers the treatment page, the index and /pricing; `schema-jsonld` is the `Offer`.
    `availability` is NOT here, and the omission is ADR 0021 working: price and therapist assignment are
    decoupled, so a repricing changes what a booking costs and not who can take it.
  */
  service_price: {
    cacheTags: ['catalogue', 'schema-jsonld'],
    settingKeys: [],
    cascadesTo:
      'the treatment page, the Offer schema, the pricing page and the booking flow. Snapshotted onto ' +
      'future bookings, never historic ones.',
  },
  /*
    "Publish a therapist → /therapists/[slug] page · Person schema · sitemap entry · bookable filter in
    the availability engine · therapist index."

    `availability` is here and is NOT decoration: publishing a therapist does not make them bookable —
    credentials do — but the *bookable filter* reads the roster, and the page offering a "Book with"
    action for somebody the solver still excludes is the inconsistency the row exists against.
  */
  publish_therapist: {
    cacheTags: ['therapists', 'schema-jsonld', 'availability'],
    settingKeys: [],
    cascadesTo:
      'the /therapists/[slug] page, the Person schema, a sitemap entry, the bookable filter in the ' +
      'availability engine, and the therapist index.',
  },
  /*
    "Archive a therapist → 301 to /therapists · removed from availability · future appointments flagged
    for reassignment · internal links rewritten."

    The same tags as publishing, because it is the same surfaces in the other direction. `content` joins
    them for the internal-link rewrite: the links live in CMS prose, so the rewrite changes CMS-derived
    pages that the therapist tags do not cover.
  */
  archive_therapist: {
    cacheTags: ['therapists', 'schema-jsonld', 'availability', 'content'],
    settingKeys: [],
    cascadesTo:
      'a 301 to /therapists, removal from availability, future appointments flagged for reassignment, ' +
      'and internal links rewritten.',
  },
  /*
    "Accent / density / radius → CSS custom properties at :root · both themes · regenerated hex mirror ·
    email templates · PDF templates."

    `theme` alone. Every surface the document lists is built from the token layer, and no row changes — so
    a page's CONTENT is untouched and purging `catalogue` or `premises` would be the over-purge.
  */
  accent_density_radius: {
    cacheTags: ['theme'],
    /*
      Two keys, not three. `theme.accent` and `theme.density` are F09 settings; **radius is not a setting
      at all** — it is a token in `@berelax/ui`'s theme, changed by a deploy. The document names all
      three in one row because they cascade identically, and listing a key that does not exist here would
      make `registryTagsFor` throw on a key nothing defines, which is the drift this pair exists to catch
      rather than to cause.
    */
    settingKeys: ['theme.accent', 'theme.density'],
    cascadesTo:
      'CSS custom properties at :root, both themes, the regenerated hex mirror, and the email and PDF ' +
      'templates. Radius is a token rather than a setting, so changing it is a deploy.',
  },
  /*
    "Hero media → Derivative generation job · CDN purge · new immutable URL · VideoObject/ImageObject
    schema · weight check at publish."

    `content` and `schema-jsonld`. Notably NOT a cache tag for the media bytes themselves: W-SYS-05's
    media URLs are content-addressed (`/m/<id>/<hash>/<name>`), so a changed file is a changed URL and
    there is nothing to purge — the CDN purge on this row is for the PAGES that embed it.
  */
  hero_media: {
    cacheTags: ['content', 'schema-jsonld'],
    settingKeys: [],
    cascadesTo:
      'the derivative generation job, a CDN purge, a new immutable URL, VideoObject/ImageObject schema, ' +
      'and the weight check at publish.',
  },
  /*
    "Changing a package template creates a new version, leaves outstanding balances on their original
    version, updates the public package page and its Offer schema, and is audited."

    `catalogue` and `schema-jsonld`: the package page is a catalogue surface and the `Offer` is its schema.
    The version clause needs no tag — an outstanding balance stays on the version it was sold under, so
    nothing cached about it changes.
  */
  package_template: {
    cacheTags: ['catalogue', 'schema-jsonld'],
    settingKeys: [],
    cascadesTo:
      'a new template version, outstanding balances left on their original version, the public package ' +
      'page and its Offer schema, and an audit row.',
  },
}

/** The tags one change purges. A function so a caller cannot read a mutable object. */
export function cacheTagsFor(change: InterconnectionChange): readonly CacheTag[] {
  return INTERCONNECTION_MAP[change].cacheTags
}

/**
 * The tags the settings registry says a row's keys invalidate, as one set.
 *
 * Used only by the test that holds the two equal. It is here rather than in the test so the comparison is
 * over one implementation of "the union of these keys' tags" — a second one in a test file would be a
 * second answer, and the test would then be about itself.
 */
export function registryTagsFor(change: InterconnectionChange): readonly CacheTag[] {
  const tags = new Set<CacheTag>()
  for (const key of INTERCONNECTION_MAP[change].settingKeys) {
    for (const tag of invalidationsFor(key).cacheTags) tags.add(tag)
  }
  return [...tags].sort()
}
