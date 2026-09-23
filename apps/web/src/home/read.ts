import { assertPublicDisplayNameCompliant, type CompliancePolicy } from '@berelax/core'
import {
  type PublicReviewRow,
  type PublicTherapistRow,
  readCompliancePolicy,
  readPublicReviews,
  readPublicTherapists,
} from '@berelax/db'
import type { Facts } from '@berelax/shared'
import { readPageFacts } from '../facts/page-facts.ts'
import { factsRuntime } from '../facts/runtime.ts'

/**
 * Everything the home route renders from, in one read, or a throw naming what is missing.
 *
 * The model is `src/treatments/read.ts` and `src/cms/page-data.ts`, and the shape is deliberately the same:
 * one function, one read per render, and a **throw** rather than a partial page when the business's own
 * records are absent. The reason is the one both of those record — a 200 that renders an empty home page is
 * worse than a build that fails, because a crawler indexes the 200 — and it applies most strongly here,
 * since this is the page every other page links to.
 *
 * ## Why this is a read at all, which is the change this unit makes
 *
 * `/` and `/ar` were `rendering: 'static'` until now, which meant everything on them was evaluated during
 * `next build` with no database — and `app/(en)/(public)/page.tsx` recorded the two consequences by name:
 * the locality could not be paired with the trading name (docs/09 §"The brand collision"), and the NAP
 * block could not be rendered because a build-time read would bake an address nothing could then correct.
 * Both are discharged by making the route `isr`, which is what docs/09 §1 lists it as. The cost is the one
 * W-SITE-05 already paid and CI already handles: **`next build` needs a migrated and seeded database**, and
 * `.github/workflows/ci.yml` applies the migrations and seeds before the build step.
 *
 * ## The three reads and why none of them is shared
 *
 * `readPageFacts` is the shared one — the premises row, the price grid and the licence class on one
 * connection — and it is what keeps `/api/facts`, `/pricing`, the treatment pages and this page from
 * disagreeing about a price. The roster and the reviews are this page's own, and `@berelax/db`'s
 * `queries/public-roster.ts` says why neither of them is an existing read: the availability read answers
 * "who may take this appointment", which excludes all nineteen therapists today, and the review queue
 * answers "what needs a reply", which is the opposite selection from "what may be shown".
 */
export interface HomePageData {
  readonly facts: Facts
  /** `regulatory_profile_current.licence_class`, from the row. Never defaulted — see `validateGraph`. */
  readonly licenceClass: string
  readonly policy: CompliancePolicy
  /** Everyone on the roster, with the publication guard attached rather than applied. */
  readonly therapists: readonly PublicTherapistRow[]
  /** Every review that exists on Google and has words in it. Empty today. */
  readonly reviews: readonly PublicReviewRow[]
}

export async function homePageData(): Promise<HomePageData> {
  const source = await readPageFacts()
  if (source === null) {
    throw new Error(
      'The home page has no facts to render: `premises` has no row, or the connection could not be ' +
        'built. Apply the migrations and run `pnpm seed` before `next build` — `/` and `/ar` are ' +
        'prerendered from the premises row, the catalogue and the roster, so the database is a build ' +
        'dependency (see this module’s header).',
    )
  }
  const row = await readCompliancePolicy(factsRuntime().sql)
  const policy: CompliancePolicy = {
    bannedClaimTerms: row.bannedClaimTerms,
    permittedPublicTitles: row.permittedPublicTitles,
    medicalClaimsPermitted: row.medicalClaimsPermitted,
  }
  // The same lint the catalogue pages run, for the same reason `src/treatments/read.ts` gives: a display
  // name is linted when it is written, so a non-compliant one can only have arrived through a path that
  // bypassed the repository — and this page is where such a row becomes published copy.
  for (const service of source.facts.catalogue.services) {
    assertPublicDisplayNameCompliant(service.name, policy)
  }
  const sql = factsRuntime().sql
  const [therapists, reviews] = await Promise.all([
    readPublicTherapists(sql),
    readPublicReviews(sql),
  ])
  return { facts: source.facts, licenceClass: source.licenceClass, policy, therapists, reviews }
}
