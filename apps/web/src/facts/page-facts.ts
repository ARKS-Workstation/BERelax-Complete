import { readCompliancePolicy, readPremisesFacts } from '@berelax/db'
import type { Facts } from '@berelax/shared'
import { siteOrigin } from '../routes/alternates.ts'
import { buildFacts } from './build.ts'
import { factsRuntime } from './runtime.ts'

/**
 * What a rendered page reads from the database about the business itself.
 *
 * Two rows, and they are read together because every consumer of the first needs the second. The premises
 * fact sheet says what the business is; `regulatory_profile_current.licence_class` says what it may be
 * *called* — which schema.org types the published structured data may claim (docs/09 §"Schema types", ADR
 * 0020) and, through `medical_claims_permitted`, which words a public name may carry.
 *
 * One `Promise.all` on the one connection `factsRuntime` owns. A second pool for one column would be a
 * second connection against the managed instance's ceiling (ADR 0004), and reading them in two calls would
 * let a graph be built against one profile version and a name linted against another.
 */
export interface PageFacts {
  readonly facts: Facts
  /** `unconfirmed`, `wellness` or `healthcare`, as the enum spells it. Narrowed at the edge that uses it. */
  readonly licenceClass: string
}

/**
 * The facts and the licence class, for a rendered page, or `null`.
 *
 * ## Why this swallows the failure and `/api/facts` does not
 *
 * Because the two answers differ in what a wrong answer costs. `/api/facts` is quoted by machines, so an
 * unreadable row has to be a 503 — a 200 with no address teaches a crawler that this business has no
 * address, and it will repeat that. A **page** has other content: a design-system gallery whose whole job
 * is the twelve-render sweep and the touch-target audit must not become a 500 because a worktree's database
 * has not been seeded, and three integration files that predate this unit drive that route.
 *
 * So the read is fail-soft, and the page renders a stated absence rather than nothing at all. That is the
 * same shape the therapist card already uses for a name nobody has set: the page shows what the site looks
 * like on day one instead of a happy path that hides the gap. A page with no JSON-LD block says nothing,
 * which is right; a block built from no row would say the business has no address.
 *
 * The error is deliberately not logged here. The caller renders the absence, and a route handler that wants
 * the failure gets it loudly from `factsResponse`.
 */
export async function readPageFacts(): Promise<PageFacts | null> {
  try {
    const runtime = factsRuntime()
    const [read, policy] = await Promise.all([
      readPremisesFacts(runtime.sql),
      readCompliancePolicy(runtime.sql),
    ])
    if (read === null) return null
    return {
      facts: buildFacts(read, { generatedAt: runtime.now(), origin: siteOrigin() }),
      licenceClass: policy.licenceClass,
    }
  } catch {
    return null
  }
}

/** The fact sheet alone, for a caller that renders the NAP block and no structured data. */
export async function readFactsForPage(): Promise<Facts | null> {
  return (await readPageFacts())?.facts ?? null
}
