/**
 * What the two therapist routes read, and the one guard they both resolve through.
 *
 * Three answers from one slug, and all three are ADR 0020:
 *
 *   - **200** for a therapist with a display name and a recorded photography consent.
 *   - **301 to `/therapists`** for one who has left. docs/09 §2: *"A therapist leaves and their page has
 *     inbound links, accumulated reviews and rankings. Do **not** 404 it."* The row is `redirect_map`'s,
 *     written by `archiveTherapist` inside the transaction that retires them, so there is no second place
 *     a redirect can be forgotten — exactly as a renamed service's is.
 *   - **404** for every other slug, including a therapist who exists and may not be published. Not a
 *     redirect to the index: a 301 from every unpublished therapist's slug would tell a crawler those URLs
 *     are real pages that moved, and would leak the fact that a person by that name works here.
 *
 * ## Why the resolution reads the roster rather than querying by slug
 *
 * Because "no such therapist" and "a therapist who may not be published" are different answers and the
 * second needs the row. A `where public_slug = $1 and is_publishable` would return nothing for both and
 * the route would 404 a person whose page is one admin action away, with nothing able to say so.
 *
 * ## Why this module is not fail-soft
 *
 * `readPageFacts` returns `null` when the database cannot be read, and the kitchen sink renders anyway
 * because its subject is the design system. A therapist page with no facts is a page about a named person
 * with no content, and a 200 that renders an empty card is worse than a failure because a crawler will
 * index it. So this throws, and the message names the step that was skipped.
 */
import {
  isTherapistPublishable,
  knowsAboutFor,
  type LiveService,
  type TherapistCandidate,
  type TherapistDisposition,
  therapistDisposition,
} from '@berelax/core'
import {
  type AlternativeTherapist,
  type AvailabilityRequest,
  type BookableVariantRow,
  lookupRedirect,
  type NearestDay,
  noAvailabilityAlternatives,
  queryAvailability,
  readAvailabilityLimits,
  readBookableVariants,
  readGenderMatching,
  readServiceSkills,
  readTherapistPages,
  type ServiceSkillRow,
  THERAPIST_INDEX_PATH,
  type TherapistPageRow,
  therapistPathFor,
  type WaitlistEligibility,
} from '@berelax/db'
import type { Facts } from '@berelax/shared'
import { availabilityDeps } from '../book/read.ts'
import { readPageFacts } from '../facts/page-facts.ts'
import { factsRuntime } from '../facts/runtime.ts'
import { nextTradingDate } from './trading.ts'

export { THERAPIST_INDEX_PATH, therapistPathFor }

/** The fact sheet, the licence class, the roster and the skill map the pages render from. */
export interface TherapistPageData {
  readonly facts: Facts
  readonly licenceClass: string
  readonly therapists: readonly TherapistPageRow[]
  /**
   * `service_skill`, so `knowsAbout` can resolve a specialism without the PAGE reading the database.
   *
   * On this payload rather than read by the route, because `kpi-arch.test.ts` refuses a page component
   * that imports a VALUE from `@berelax/db` — the rule is that a page renders and a module reads, and a
   * page that reaches for one more row is how a screen ends up with a database of its own.
   */
  readonly serviceSkills: readonly ServiceSkillRow[]
}

/**
 * One row as the pure guard sees it.
 *
 * The one adapter between a database row and `TherapistCandidate`, so the guard is called with the same
 * shape by the route, the sitemap and the schema builder. Written as a function rather than inlined three
 * times for the reason the guard itself is one function: three adapters are three chances to leave
 * `retiredAt` out, and leaving it out publishes somebody who has left.
 */
export function candidateFor(row: TherapistPageRow, origin?: string): TherapistCandidate {
  return {
    staffReference: row.staffReference,
    displayName: row.displayName,
    photographyConsentRecordedAt: row.photoConsentRecordedAt,
    retiredAt: row.retiredAt,
    ...(row.skills.length === 0 ? {} : { skills: [...row.skills] }),
    ...(row.languages.length === 0 ? {} : { languages: [...row.languages] }),
    ...(row.publicSlug === null || origin === undefined
      ? {}
      : { url: `${origin}${therapistPathFor(row.publicSlug)}` }),
  }
}

/** The disposition of one row — the one call site's worth of adapter plus guard. */
export function dispositionOf(row: TherapistPageRow): TherapistDisposition {
  return therapistDisposition(candidateFor(row))
}

/** Everything the therapist routes render from, or a throw naming what is missing. */
export async function therapistPageData(): Promise<TherapistPageData> {
  const source = await readPageFacts()
  if (source === null) {
    throw new Error(
      'The therapist pages have no facts to render: `premises` has no row, or the connection could not ' +
        'be built. Apply the migrations and run `pnpm seed` before serving these routes.',
    )
  }
  const sql = factsRuntime().sql
  const [therapists, serviceSkills] = await Promise.all([
    readTherapistPages(sql),
    readServiceSkills(sql),
  ])
  return { facts: source.facts, licenceClass: source.licenceClass, therapists, serviceSkills }
}

/** What a request for `/therapists/<slug>` resolves to. */
export type TherapistResolution =
  | { readonly kind: 'render'; readonly row: TherapistPageRow }
  /** A 301. `status` is the row's when a row said so, never invented. */
  | { readonly kind: 'redirect'; readonly target: string; readonly status: number }
  | { readonly kind: 'not_found' }

/**
 * Resolves one slug against the roster and the redirect map.
 *
 * The roster wins over the map, which is `resolveServicePath`'s order and matters for the same reason: a
 * therapist renamed away and back again would otherwise 301 to themselves.
 *
 * A retired therapist is resolved through `redirect_map` rather than by returning the index directly, and
 * the `?? THERAPIST_INDEX_PATH` fallback exists for exactly one case — a row retired before this unit
 * existed, which has no map row because nothing wrote one. It is a fallback and not the rule: the rule is
 * the row, so a renamed-then-retired therapist leaves ONE hop from their first URL rather than two.
 */
export async function resolveTherapist(
  therapists: readonly TherapistPageRow[],
  slug: string,
): Promise<TherapistResolution> {
  const row = therapists.find((candidate) => candidate.publicSlug === slug)
  if (row !== undefined) {
    const disposition = dispositionOf(row)
    if (disposition.kind === 'published') return { kind: 'render', row }
    if (disposition.kind === 'retired') {
      const redirect = await lookupRedirect(factsRuntime().sql, therapistPathFor(slug))
      return {
        kind: 'redirect',
        target: redirect?.targetPath ?? THERAPIST_INDEX_PATH,
        status: redirect?.statusCode ?? 301,
      }
    }
    return { kind: 'not_found' }
  }
  const redirect = await lookupRedirect(factsRuntime().sql, therapistPathFor(slug))
  if (redirect !== undefined) {
    return { kind: 'redirect', target: redirect.targetPath, status: redirect.statusCode }
  }
  return { kind: 'not_found' }
}

/**
 * `knowsAbout` for one therapist: the live services their specialisms resolve to.
 *
 * The live catalogue comes from the fact sheet the page already read, so the names in `knowsAbout` are the
 * same strings the treatment pages publish — which is the whole point of the claim being machine-readable.
 * `knowsAboutFor` throws naming the specialism when one resolves to nothing live, and the throw is not
 * caught here: a `Person` node claiming expertise in a treatment the business no longer sells is a page
 * that sends a client to the front desk asking for it.
 */
export function knowsAboutForRow(
  row: TherapistPageRow,
  facts: Facts,
  skills: readonly ServiceSkillRow[],
): readonly string[] {
  const skillOfStyle = new Map(skills.map((skill) => [skill.style, skill.requiredSkill]))
  const live: readonly LiveService[] = facts.catalogue.services.flatMap((service) => {
    const requiredSkill = skillOfStyle.get(service.style)
    // A live service whose style has no `service_skill` row is a service nobody may be published as
    // knowing about, and it is dropped rather than guessed: `reassignment.ts` already refuses the same
    // absence by name, so the gap is reported where it is actionable rather than papered over here.
    return requiredSkill === undefined
      ? []
      : [{ slug: service.slug, name: service.name, requiredSkill }]
  })
  return knowsAboutFor(row.skills, live)
}

/** The availability preview, and the alternatives when it is empty. */
export interface TherapistAvailability {
  /** The variant the preview is about, so the page can name the treatment it priced. */
  readonly variant: BookableVariantRow
  /** Offerable starts for this therapist on the date asked about, in epoch milliseconds. */
  readonly starts: readonly number[]
  /**
   * The alternatives region, present exactly when `starts` is empty.
   *
   * docs/09 §3: *"No availability is a designed state, not an empty one: nearest alternative days, the
   * same treatment with another therapist, and a waitlist join."* All three are present together or the
   * region is absent, because two of three is a designed state with a hole in it.
   */
  readonly alternatives: {
    readonly nearestDays: readonly NearestDay[]
    readonly otherTherapists: readonly AlternativeTherapist[]
    readonly waitlist: WaitlistEligibility
  } | null
}

/**
 * This therapist's availability on one trading date, with the alternatives when there is none.
 *
 * Every one of the nineteen comes back empty today, and that is B-AVAIL-04's rule working rather than a
 * gap: a mandatory credential type with no row at all is `credential_missing`, and no therapist has a
 * credential row (`Y8-staff`). So the alternatives region is what this page actually renders, which is why
 * `therapists.itest.ts` asserts it present rather than treating it as a rare branch.
 *
 * The variant is the first bookable one requiring a skill this therapist holds, because a preview has to be
 * about a treatment this therapist can deliver — a preview over the whole menu would show the hours
 * somebody else is free. `null` when there is none, which the page renders as a sentence rather than as an
 * empty grid.
 *
 * `genderMatching` is read from the row rather than assumed, because B-AVAIL-05 made it a hard constraint
 * with a strict default and a settings-driven value: hard-coding `'strict'` here would make this preview
 * disagree with the booking flow the moment the setting moved, and the disagreement would read as a
 * caching bug.
 */
export async function therapistAvailability(
  row: TherapistPageRow,
  tradingDate: string,
  now: number,
): Promise<TherapistAvailability | null> {
  const sql = factsRuntime().sql
  const [variants, skills, limits, genderMatching] = await Promise.all([
    readBookableVariants(sql),
    readServiceSkills(sql),
    readAvailabilityLimits(sql),
    readGenderMatching(sql),
  ])
  const skillOfStyle = new Map(skills.map((skill) => [skill.style, skill.requiredSkill]))
  const variant = variants.find((candidate) => {
    const required = skillOfStyle.get(candidate.style)
    return required !== undefined && row.skills.includes(required)
  })
  if (variant === undefined) return null
  const request: AvailabilityRequest = {
    tradingDate,
    serviceVariantId: variant.serviceVariantId,
    minLeadMinutes: limits.minLeadMinutes,
    maxAdvanceDays: limits.maxAdvanceDays,
    therapistIds: [row.id],
    genderMatching,
  }
  const deps = availabilityDeps(now)
  const answer = await queryAvailability(sql, request, deps)
  if (answer.slots.length > 0) {
    return { variant, starts: answer.slots.map((slot) => slot.startsAt), alternatives: null }
  }
  // The cold path, and the one this page is always on today. `noAvailabilityAlternatives` searches a week
  // either side, which is why it runs only when the day really came back empty.
  const alternatives = await noAvailabilityAlternatives(sql, request, deps)
  return {
    variant,
    starts: [],
    alternatives: {
      nearestDays: alternatives.nearestDays,
      otherTherapists: alternatives.alternativeTherapists,
      waitlist: alternatives.waitlistEligible,
    },
  }
}

/** The slugs the sitemap and the index may link to: every publishable therapist, in roster order. */
export function publishableTherapists(
  therapists: readonly TherapistPageRow[],
): readonly TherapistPageRow[] {
  return therapists.filter((row) => isTherapistPublishable(candidateFor(row)))
}

/**
 * The next open trading date, read here rather than by the page.
 *
 * `kpi-arch.test.ts` refuses a page component that imports a value from `@berelax/db`, and the rule is a
 * good one: a page renders and a module reads. This is the one line that reads the clock's consequence.
 */
export async function nextOpenTradingDate(now: number): Promise<string | null> {
  return await nextTradingDate(factsRuntime().sql, now)
}
