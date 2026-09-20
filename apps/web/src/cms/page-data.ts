import { assertCmsCopyCompliant, type CmsCopy } from '@berelax/cms'
import type { CompliancePolicy, FaqEntry } from '@berelax/core'
import { readCompliancePolicy } from '@berelax/db'
import type { Facts } from '@berelax/shared'
import { readPageFacts } from '../facts/page-facts.ts'
import { factsRuntime } from '../facts/runtime.ts'
import {
  assertPostsPublishable,
  assertRenderedCopyCompliant,
  type CmsAvailability,
  type EditorialPage,
  type JournalPost,
  readEditorialPages,
  readFaqEntries,
  readJournalPosts,
  readMedicalDisclaimer,
} from './read.ts'

/**
 * The one read the five CMS-and-premises routes share, and the three refusals it makes.
 *
 * `src/treatments/read.ts` is the model and the shape is deliberately the same: one function, one read per
 * page, and a **throw** rather than a partial render when the business's own records are missing. A page
 * about where the spa is, with no address, is worse than a build that fails — a crawler indexes the 200.
 *
 * The three refusals, each of which fails `next build` rather than publishing:
 *
 *   1. **No premises row.** Same message and same reasoning as the catalogue pages: apply the migrations and
 *      seed before the build, because these routes prerender from the database.
 *   2. **A published journal post that is not publishable** — no author byline, no reviewer byline, no date,
 *      or health-adjacent copy with no disclaimer written. The Payload hook refuses the publish in the first
 *      place; this catches a row that arrived another way.
 *   3. **CMS copy that fails the banned-claims lint.** The acceptance criterion in full: *"Every CMS route's
 *      rendered copy passes the banned-claims lint in CI, and a fixture post containing 'cures sciatica'
 *      fails the build by rule name."* The rule it fails by is `banned_claim_term`, which is B-CAT-05's own
 *      rule name and reads its term list from `regulatory_profile` — so the answer to Y1-licence changes what
 *      is refused without a deploy.
 *
 * What it does **not** refuse is an absent CMS schema. `read.ts`'s header has the whole argument; the short
 * version is that Payload's tables are created by drizzle-kit `push`, which is off under
 * `NODE_ENV=production`, and `next build` is always production — so a build in a fresh environment must
 * render the honest empty state rather than fail. `availability` carries the reason so a caller can say so.
 */
export interface ContentPageData {
  readonly facts: Facts
  /** `regulatory_profile_current.licence_class`, from the row. Never defaulted. */
  readonly licenceClass: string
  readonly policy: CompliancePolicy
  /** The published FAQ rows: the array `/faq` renders AND the one the `FAQPage` node is built from. */
  readonly faq: readonly FaqEntry[]
  readonly posts: readonly JournalPost[]
  readonly pages: readonly EditorialPage[]
  /** `compliance_notices.medical_disclaimer`, flattened, or null while the owner has not written it. */
  readonly disclaimer: string | null
  /** Whether the CMS could be read at all, and why not when it could not. */
  readonly availability: CmsAvailability
}

export async function contentPageData(): Promise<ContentPageData> {
  const source = await readPageFacts()
  if (source === null) {
    throw new Error(
      'The CMS routes have no facts to render: `premises` has no row, or the connection could not be ' +
        'built. Apply the migrations and run `pnpm seed` before `next build` — /spa, /contact and /about ' +
        'are generated from the premises row, so the database is a build dependency.',
    )
  }
  const row = await readCompliancePolicy(factsRuntime().sql)
  const policy: CompliancePolicy = {
    bannedClaimTerms: row.bannedClaimTerms,
    permittedPublicTitles: row.permittedPublicTitles,
    medicalClaimsPermitted: row.medicalClaimsPermitted,
  }

  const [faq, posts, pages, disclaimer] = await Promise.all([
    readFaqEntries(),
    readJournalPosts(),
    readEditorialPages(),
    readMedicalDisclaimer(),
  ])

  // Publishability first, then the copy lint. A post with no byline and a banned claim in it is two
  // problems, and the byline is the one an editor can act on without reading a lexicon.
  await assertPostsPublishable(posts.rows, disclaimer)
  assertRenderedCopyCompliant({ faq: faq.rows, posts: posts.rows, pages: pages.rows }, policy)

  return {
    facts: source.facts,
    licenceClass: source.licenceClass,
    policy,
    faq: faq.rows,
    posts: posts.rows,
    pages: pages.rows,
    disclaimer,
    // One availability for the page: the three collections are created by one `push`, so they are present or
    // absent together, and reporting three would invite a page that rendered two of them and said nothing.
    availability: faq.availability,
  }
}

/**
 * The strings a page is about to render, linted, or a throw naming the rule.
 *
 * Called by each route with its own built sections, because the copy a page renders is not knowable until the
 * sections have been built from the rows — which is the point: this lints the **rendered** copy, including
 * every value interpolated out of the premises row and the catalogue, and not a template with holes in it.
 * A string the page does not render must not be passed: a lint that judged an unrendered branch would refuse
 * pages for copy nobody can read.
 *
 * ## The one exemption: `compliance_notices.medical_disclaimer`
 *
 * The disclaimer is rendered verbatim and is **never** linted, and this is the exemption W-SITE-07 found by
 * failing a build over it. W-SYS-08's fixture wording is *"Massage is not a medical treatment."* — which is a
 * correct disclaimer and contains two of `regulatory_profile.banned_claim_terms` (`medical`, `treatment`), so
 * linting it refused the sentence that exists to protect the business. That is not a fixture accident: the
 * medical-disclaimer pattern docs/09 §"E-E-A-T" asks for works by NEGATING a claim, and a lexicon built to
 * stop the business asserting those words will always refuse the sentence that denies them.
 *
 * The exemption is narrow and it is not "trust the CMS". `compliance_notices` is the one compliance-locked
 * global: its write permission is `settings:write_compliance`, which in the F07 matrix is the **owner alone**
 * — the licensee, the person the lint exists to protect, and the person an inspector holds responsible for
 * that wording. Every other CMS field on these routes is editor content and is linted. It is the same shape
 * as W-SITE-03's `legalName` exemption from the bare-brand rule: a value that answers to a registry rather
 * than to a marketing decision. `packages/cms/src/publication.test.ts` asserts the other half — the same
 * words in a journal post's body are still refused by name — so the exemption cannot be read as the lexicon
 * having gone quiet.
 */
export function assertPageCopyCompliant(
  routeId: string,
  strings: readonly string[],
  policy: CompliancePolicy,
): void {
  const copy: readonly CmsCopy[] = strings.map((text) => ({ where: `route/${routeId}`, text }))
  assertCmsCopyCompliant(copy, policy)
}
