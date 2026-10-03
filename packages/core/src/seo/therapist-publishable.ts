/**
 * The therapist publishing guard: the ONE place that decides whether a real person may be published.
 *
 * A therapist page names a named human being, shows their photograph and claims what they are trained in.
 * So this is not a flag a screen sets and not a filter a builder applies — it is a **refusal**, and ADR
 * 0020 states its two conditions: a display name an admin set, and a photography consent somebody
 * recorded. Nothing here may be inferred, defaulted or derived from a photograph (brief rule 15).
 *
 * ## Why the guard moved out of `jsonld/content.ts`
 *
 * W-SITE-03 wrote it there, beside the `Person` builder, because the builder was the only consumer. It now
 * has three — the route handler, the sitemap builder and the schema builder — and the acceptance criterion
 * for W-SITE-06 is that there is exactly one of it. A predicate living inside the structured-data module
 * is one a route author reasonably writes again: `row.display_name !== null && row.photo_consent` reads as
 * obviously equivalent, and it is not, because it misses retirement and it misses the portrait's alt text.
 * So the guard is its own module with its own name, `jsonld/content.ts` imports it, and
 * `therapist-publishable.test.ts` asserts the three consumers reach it rather than restating it.
 *
 * ## Three dispositions, not two, and the third is the whole point of ADR 0020's departure clause
 *
 * docs/09 §2: *"A therapist leaves and their page has inbound links, accumulated reviews and rankings. Do
 * **not** 404 it."* A boolean cannot say that. `published` earns a 200, a sitemap entry and a `Person`
 * node; `unpublished` earns an unlinked card, a 404 at the slug and absence from every sitemap; `retired`
 * earns a 301 to the index and absence from every sitemap. Collapsing the last two into "not published"
 * is precisely the defect the clause exists against — and it is invisible, because both look like "the
 * page is gone" to everybody except the crawler holding the inbound link.
 *
 * ## There is one OTHER statement of the name-and-consent pair, and it is held equal
 *
 * `isEmployeePublishable` in `packages/core/src/hr/employee.ts` is P-HR-01's mirror of the GENERATED
 * column `employee.is_publishable`, and it is a different claim from this module's: it says what the
 * DATABASE computes, where `isTherapistPublishable` says whether a PAGE may be published — the same pair
 * of facts plus retirement plus the portrait's alt text. Both have to exist, because an admin screen needs
 * the per-reason refusals below and the mirror needs to be the conjunction the column is.
 *
 * So the two are held equal rather than merged: `therapist-publishable.test.ts` asserts that over all four
 * combinations of the pair, "no name-or-consent refusal" and `isEmployeePublishable` agree — which is the
 * check the brief asks for whenever a fact is stated twice. `apps/web/src/therapist-guard.test.ts` scans
 * the repository for any THIRD statement of the conjunction and names that file as the one exception.
 *
 * ## Why the portrait's alt text is a refusal and not a lint
 *
 * W-SYS-09 made alt text a required property of a media slot, and the `therapist-portrait` slot is where
 * these photographs are served. An alt-less portrait of an identifiable person is the one failure that
 * cannot be fixed after publication: the page is indexed, the image is indexed with it, and a screen
 * reader has announced an unlabelled photograph of somebody who consented to a labelled one. So a portrait
 * with no alt refuses the page rather than degrading it.
 */
import { AppError } from '@berelax/shared'
import { isEmployeePublishable } from '../hr/employee.ts'

/**
 * A therapist as the guard sees one.
 *
 * `displayName`, `photographyConsentRecordedAt` and `retiredAt` are `string | null` rather than optional,
 * because that is what a nullable column reads as and a consumer that has to handle both `undefined` and
 * `null` handles neither (the argument `PostalAddress` in `@berelax/shared` makes).
 *
 * `retiredAt` is REQUIRED and not optional, and the choice cost three literals in this commit. Optional
 * would have meant a caller that had not thought about departure published a retired therapist, which is
 * the one state that must never answer 200 — and a field whose absence means "still working" is a field
 * every new call site gets right by luck.
 */
export interface TherapistCandidate {
  /** The internal handle — `Therapist 07`. Never published; it is here to name a rejection. */
  readonly staffReference: string
  readonly displayName: string | null
  /** When a photography consent was recorded, ISO 8601. Null means none. */
  readonly photographyConsentRecordedAt: string | null
  /** When employment ended, ISO 8601. Null is open-ended employment, never an unknown. */
  readonly retiredAt: string | null
  readonly skills?: readonly string[]
  readonly languages?: readonly string[]
  readonly jobTitle?: string
  /** The published portrait URL, when one is served. */
  readonly portraitUrl?: string
  /** The portrait's alt text. Required whenever `portraitUrl` is set — see the module header. */
  readonly portraitAlt?: string
  /** The therapist page, when the route exists. */
  readonly url?: string
}

/** Why a therapist may not be published. The reason is named so an admin screen can say which. */
export const THERAPIST_PUBLISHING_REFUSALS = [
  'no_display_name',
  'no_photography_consent',
  'portrait_without_alt',
] as const
export type TherapistPublishingRefusal = (typeof THERAPIST_PUBLISHING_REFUSALS)[number]

/**
 * The reasons this therapist may not be published, or an empty list.
 *
 * Every reason, not the first. An admin who is told about the missing name sets it, comes back and is then
 * told about the consent; two refusals shown at once are one conversation instead of two, and the same
 * argument `lintPublicDisplayName` makes for returning every finding.
 *
 * Retirement is deliberately NOT one of these. It is not a reason the page may not exist — it is the
 * reason the page redirects — and a retired therapist whose name and consent are on file still has both.
 * See {@link therapistDisposition}.
 */
export function therapistPublishingRefusals(
  candidate: TherapistCandidate,
): readonly TherapistPublishingRefusal[] {
  const refusals: TherapistPublishingRefusal[] = []
  if (candidate.displayName === null || candidate.displayName.trim() === '') {
    refusals.push('no_display_name')
  }
  if (candidate.photographyConsentRecordedAt === null) refusals.push('no_photography_consent')
  if (candidate.portraitUrl !== undefined && (candidate.portraitAlt ?? '').trim() === '') {
    refusals.push('portrait_without_alt')
  }
  return refusals
}

/**
 * True only when this therapist may be published right now.
 *
 * The one predicate. The route handler, the sitemap builder and the schema builder all call it, and
 * `therapist-publishable.test.ts` asserts that by reading their source — because the failure mode is not a
 * wrong answer here, it is a second answer somewhere else.
 *
 * A retired therapist is NOT publishable: the page they had answers 301, and a 301 is not a page.
 */
export function isTherapistPublishable(candidate: TherapistCandidate): boolean {
  return candidate.retiredAt === null && therapistPublishingRefusals(candidate).length === 0
}

/**
 * What the database's generated column would say about this candidate — the pair, and nothing else.
 *
 * Exported so the equality between this module and `isEmployeePublishable` is assertable from one import,
 * and NOT used by `isTherapistPublishable`: the refusals have to be computed per reason, because an admin
 * screen that is told "not publishable" cannot act on it. See the module header.
 */
export function generatedIsPublishableFor(candidate: TherapistCandidate): boolean {
  return isEmployeePublishable({
    displayName: candidate.displayName,
    photoConsent: candidate.photographyConsentRecordedAt !== null,
  })
}

/** What the site does with this therapist's URL. Three values, because docs/09 §2 names three. */
export type TherapistDisposition =
  /** 200, a sitemap entry, a `Person` node, a card with an anchor, a "Book with" action. */
  | { readonly kind: 'published' }
  /** 404 at the slug, an unlinked card, absent from every sitemap. No "Book with" action. */
  | { readonly kind: 'unpublished'; readonly refusals: readonly TherapistPublishingRefusal[] }
  /** 301 to the therapist index, absent from every sitemap, no bookable availability. */
  | { readonly kind: 'retired' }

/**
 * The disposition of one therapist's URL.
 *
 * Retirement is checked FIRST and the order is load-bearing. A therapist who left and whose consent was
 * subsequently withdrawn still has an indexed URL and inbound links, so the page still has to redirect
 * rather than start 404ing — a 404 on a URL that ranks loses the ranking and tells a crawler the page was
 * a mistake. The one case where that is not what we want is a therapist who was never publishable in the
 * first place: there is no URL anybody can be holding, so there is nothing to redirect, and the second
 * condition below is what says so.
 */
export function therapistDisposition(candidate: TherapistCandidate): TherapistDisposition {
  const refusals = therapistPublishingRefusals(candidate)
  if (candidate.retiredAt !== null) {
    return refusals.length === 0 ? { kind: 'retired' } : { kind: 'unpublished', refusals }
  }
  return refusals.length === 0 ? { kind: 'published' } : { kind: 'unpublished', refusals }
}

/**
 * The slug of a therapist page, from the display name.
 *
 * ## Why the slug comes from the name and not from the staff reference
 *
 * `/therapists/therapist-07` is a URL nobody searches for and nobody shares. docs/09 §2's whole argument
 * for this route is that *"a returning client searches for a person, not a service"*, and the name in the
 * URL is half of what makes that search land. The internal handle stays internal.
 *
 * It is computed HERE and written to `employee.public_slug` by the one repository function that sets a
 * display name — rather than being a generated column with a `slugify()` in SQL — because that keeps one
 * spelling of the transformation instead of two that `pnpm db:drift` cannot compare. What the database
 * does hold is the UNIQUE INDEX, which is the part TypeScript cannot: two distinct display names can
 * slugify to one string (`Anna-Maria` and `Anna Maria` both give `anna-maria`), and without the index that
 * is two therapists at one URL and two sitemap entries claiming the same page.
 *
 * Throws on a name that reduces to nothing. A name of punctuation alone would otherwise produce the empty
 * slug, which is `/therapists/` — the index — so the therapist's page would silently *be* the index.
 */
export function therapistSlug(displayName: string): string {
  const slug = displayName
    .normalize('NFKD')
    // Combining marks, so `Zoë` gives `zoe` rather than `zo`. The range is Unicode's own.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (slug === '') {
    throw new AppError(
      'validation',
      `the display name ${JSON.stringify(displayName)} reduces to an empty slug, so the therapist's ` +
        'page would be the therapist index. A published display name has to contain at least one ' +
        'letter or digit.',
      { details: { rule: 'therapist_slug_is_not_empty' } },
    )
  }
  return slug
}

// ------------------------------------------------------------------------------------------------
// knowsAbout — specialisms that have to resolve to something bookable
// ------------------------------------------------------------------------------------------------

/**
 * A live catalogue service, as the specialism resolver reads one.
 *
 * `requiredSkill` and not `style`, and the difference is ADR 0021. `service.style` is `asian` / `arabic`
 * and `employee_skill.skill` is `asian_style` / `arabic_style`, and the relation between them is a ROW in
 * `service_skill` — not a string transformation. Matching on the style here would have compared `asian`
 * with `asian_style`, resolved nothing for anybody, and refused every therapist's specialism with a
 * message about an archived service. The caller joins the two through the table (`readServiceSkills`), so
 * the day a third style arrives it is a row rather than a suffix somebody has to notice.
 */
export interface LiveService {
  readonly slug: string
  readonly name: string
  /** `service_skill.required_skill` for this service's style — a skill, never a style (ADR 0021). */
  readonly requiredSkill: string
}

/**
 * The services one specialism resolves to, or a refusal naming the specialism.
 *
 * `knowsAbout` is a claim that this person is expert in a thing, and docs/09 §2 asks for specialisms
 * **mapped to bookable services**. A specialism that maps to nothing is the failure worth refusing loudly:
 * it publishes expertise in something the business does not sell, so a client arrives asking for it. The
 * commonest way it arrives is an archival — a service is taken off the menu and the therapist rows that
 * named it are still there — which is why the refusal names the specialism rather than counting them.
 */
export function servicesForSpecialism(
  specialism: string,
  live: readonly LiveService[],
): readonly LiveService[] {
  const matched = live.filter((service) => service.requiredSkill === specialism)
  if (matched.length === 0) {
    throw new AppError(
      'validation',
      `the specialism '${specialism}' resolves to no live catalogue service, so publishing it would ` +
        'claim expertise in something this business does not sell. Either a service of that style is ' +
        'archived, or the skill row names a style the menu has never had.',
      {
        details: {
          rule: 'specialism_without_live_service',
          specialism,
          liveSkills: [...new Set(live.map((service) => service.requiredSkill))].sort(),
        },
      },
    )
  }
  return matched
}

/**
 * `knowsAbout` for one therapist: the names of the live services their specialisms resolve to.
 *
 * Service names rather than style labels, because `asian_style` is a database enum and `knowsAbout` is
 * read by a machine that matches it against the service names on the rest of the site. Sorted and
 * deduplicated: two specialisms can resolve to one service, and a `knowsAbout` whose order moves with the
 * row order of `employee_skill` makes a diff of the rendered page unreadable.
 */
export function knowsAboutFor(
  specialisms: readonly string[],
  live: readonly LiveService[],
): readonly string[] {
  const names = new Set<string>()
  for (const specialism of specialisms) {
    for (const service of servicesForSpecialism(specialism, live)) names.add(service.name)
  }
  return [...names].sort()
}
