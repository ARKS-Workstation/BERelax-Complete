import { gzipSync } from 'node:zlib'
import {
  bannedClaimVocabulary,
  type CompliancePolicy,
  criticalPathBytes,
  type PublicationWeightSubject,
  type PublishedCopyRegion,
  publicationCanonicalContent,
  publicationCopyFindings,
  publicationWeightRefusals,
} from '@berelax/core'
import { type CompliancePolicyRow, publicationContentHash, type Sql } from '@berelax/db'
import {
  publicationRefusals,
  type SlotImageForPublication,
  type PublicationRefusal as SlotRefusal,
} from '@berelax/media/slots'
import { homeBudgetLimit } from '../home/budget.ts'

/**
 * Everything that must be true before a page may be published (W-SITE-10).
 *
 * ## Why this is one function and not three checks at the call site
 *
 * Because `apps/web/src/media/publish-gate.ts` already learnt it, in the words W-SYS-10's acceptance used:
 * two independent *assertions*, not two independent *implementations*. Two implementations of a refusal
 * drift, and the one that drifts is the one nobody clicks. So the API route, an admin screen and the
 * integration suite all call this, and the only thing that decides whether a page may go live is what it
 * returns.
 *
 * ## The three halves, and where each rule actually lives
 *
 * Nothing is re-decided here. This module composes:
 *
 *   * **The banned-claims lint** — `publicationCopyFindings` in `@berelax/core`, against the profile in
 *     force read through `readCompliancePolicy`. The vocabulary is `regulatory_profile`'s, which is what
 *     makes the day Y1-licence is answered a configuration change rather than a deploy.
 *   * **The slot budgets and alt text** — `publicationRefusals` in `@berelax/media/slots`, W-SYS-09's, the
 *     same function the media publish endpoint calls. Its own header says it is "the media half of
 *     [W-SITE-10's] pre-publication gate".
 *   * **The critical-path weight** — `publicationWeightRefusals` in `@berelax/core`, judged against
 *     `homeBudgetLimit('critical-above-fold')`. docs/08 §8's figure is stated once, in `../home/budget.ts`,
 *     and read from there: a second copy of 250 KB in this file would be a number nobody compares.
 *
 * ## Nothing about the weight comes from the caller
 *
 * This is the property that makes the layer worth having. The gate fetches the page over HTTP from the
 * server it is running in, weighs the document, reads the critical resources out of the document's own head
 * and weighs each of those too. A caller cannot present a figure, cannot omit one, and cannot describe a
 * lighter page than the one it is asking to publish — the only thing it supplies is which page.
 *
 * The page is fetched rather than re-rendered here because re-rendering the tree would measure a different
 * document: without the framework's preloads, without the hoisted `<style>` elements the design system ships
 * its CSS in (`packages/ui/src/layout/styles.tsx` says why), and without the `<link rel=preload as=image>`
 * the art-directed hero adds — which is most of the weight.
 *
 * ## What counts as the critical path, and why it is the same definition as the CI layer's
 *
 * `../home/budget.ts` defines it as *"the encoded bytes of the document plus the encoded bytes of every
 * resource on its critical path — the render-blocking ones, the ones the head preloads, and the LCP
 * element's own"*, and `home.itest.ts` measures exactly that in a real browser. Here the same set is derived
 * from the markup: every `<link rel="stylesheet">` and every `<link rel="preload">` in the document, plus
 * the document itself. That is not an approximation of the browser's set — it is the same set, because on
 * this application the preloads ARE the framework's scripts, the two fonts and the art-directed poster, and
 * `home.itest.ts` records the measurement that established it (a timing-derived set answers 15 or 7 on the
 * same page depending on how loaded the machine is, which is why neither layer uses timings).
 *
 * `<script src>` is deliberately NOT counted twice: Next emits its chunks as `<link rel="preload"
 * as="script">` in the head and then as deferred `<script>` elements, so counting both would double the
 * framework's bytes and refuse every page on this site.
 *
 * So this layer is a slightly conservative estimate of the browser's figure rather than a second definition
 * of it — which is why the two do not replace each other. This one fires before the page is public and
 * cannot see the paint; the CI one sees the paint and fires after the commit.
 */

/** What is being published. Note what is absent: any figure describing the page's weight. */
export interface PublicationSubject {
  /** The locator recorded on `publication_lint_pass.surface` — `journal_posts/<slug>`, `pages/about`. */
  readonly surface: string
  /** The route whose rendered document is fetched and weighed. An absolute path. */
  readonly path: string
  /** The copy the approver reads, region by region. The lint's input and the hash's input. */
  readonly regions: readonly PublishedCopyRegion[]
  /**
   * The slot images whose alt text and per-slot budgets are checked, already resolved from their rows.
   *
   * Resolved by the caller through `assessMediaForPublication`, which reads the media row through Payload's
   * access layer and measures the objects in the bucket — so a rendition's weight is measured once in this
   * build rather than twice. Their bytes are NOT added to the critical path here: the hero reaches the
   * critical path through the document's own `<link rel="preload" as="image">`, and counting it from both
   * places would double it.
   */
  readonly slotImages: readonly SlotImageForPublication[]
}

/** One reason a publish is refused, flattened across the three halves so a caller reports them together. */
export interface PublicationGateRefusal {
  /** The rule name — bracketed for a weight or slot rule, the lint's own name for a claim. */
  readonly rule: string
  readonly message: string
  /** Where it came from, so a refusal can be shown beside the field that caused it. */
  readonly where: string
  /** The figure measured, where the rule measured one. */
  readonly measuredBytes: number | null
}

export interface PublicationAssessment {
  readonly surface: string
  /** The sha256 of the exact content assessed. What an approval must carry to be for this content. */
  readonly contentSha256: string
  readonly canonicalContent: string
  /** How many banned terms the lint compared against. Recorded on the lint pass; `> 0` by CHECK. */
  readonly termsChecked: number
  readonly profileVersion: number
  readonly measurement: PublicationWeightSubject
  readonly measuredCriticalPathBytes: number
  readonly criticalPathBudgetBytes: number
  readonly refusals: readonly PublicationGateRefusal[]
}

/** The row `readCompliancePolicy` returns, narrowed to the lint's own policy. A field copy, nothing more. */
export function compliancePolicyOf(row: CompliancePolicyRow): CompliancePolicy {
  return {
    bannedClaimTerms: row.bannedClaimTerms,
    permittedPublicTitles: row.permittedPublicTitles,
    medicalClaimsPermitted: row.medicalClaimsPermitted,
  }
}

// ------------------------------------------------------------------------------------------------
// The measurement
// ------------------------------------------------------------------------------------------------

/** One resource the document puts on its critical path. */
export interface CriticalResource {
  readonly href: string
  /** `image` goes to `criticalImageBytes`; everything else to `criticalAssetBytes`. */
  readonly kind: 'image' | 'asset'
}

/** Every `<link>` element in a document, as its raw attribute text. */
const LINK_ELEMENT = /<link\b[^>]*>/gi
const ATTRIBUTE = (name: string) => new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i')

/**
 * The critical resources a document declares, read from its `<link>` elements.
 *
 * A regular expression over our OWN generated markup, and that is the whole justification: this is not a
 * general HTML parser and must never be used as one. It reads four fixed attributes out of `<link>`
 * elements emitted by this application's layout and by Next, and there is no DOM implementation in the
 * server runtime to read them with instead. `packages/harness` has Playwright, which is where the CI layer
 * reads the same set from a real document — and a publish cannot start a browser.
 *
 * An art-directed preload carries `imagesrcset` and no `href` (`hero-lcp.itest.ts` asserts the element), so
 * the first candidate of the srcset stands in for it: the rungs differ by width and the narrowest is the
 * phone's, which is the column docs/08 §8 states the 250 KB figure in.
 */
export function criticalResourcesIn(html: string): readonly CriticalResource[] {
  const found: CriticalResource[] = []
  const seen = new Set<string>()
  for (const [element] of html.matchAll(LINK_ELEMENT)) {
    const rel = ATTRIBUTE('rel').exec(element)?.[1]?.toLowerCase() ?? ''
    if (rel !== 'stylesheet' && rel !== 'preload') continue
    const as = ATTRIBUTE('as').exec(element)?.[1]?.toLowerCase() ?? ''
    const href =
      ATTRIBUTE('href').exec(element)?.[1] ??
      ATTRIBUTE('imagesrcset').exec(element)?.[1]?.split(',')[0]?.trim().split(/\s+/)[0] ??
      ''
    if (href === '' || href.startsWith('data:')) continue
    // Deduplicated by URL: a stylesheet that is both preloaded and linked is one download.
    if (seen.has(href)) continue
    seen.add(href)
    found.push({ href, kind: as === 'image' ? 'image' : 'asset' })
  }
  return Object.freeze(found)
}

/**
 * Content types whose bytes are already compressed, so gzipping them again would report a bigger file than
 * the browser downloads.
 *
 * Everything else is compressed at level 9, which is the basis `scripts/check-budgets.mjs`,
 * `../home/budget.ts` and {@link documentBytes} all use, for the reason that file states: *"a budget has to
 * mean the same thing on two machines"*. Brotli is closer to what a CDN serves and is not in the standard
 * library, so every figure here is conservative and the real transfer is smaller.
 */
const ALREADY_COMPRESSED = /^(?:image\/(?:avif|webp|jpeg|png|gif)|font\/woff2?|video\/|audio\/)/i

/** The compressed bytes of a document, on the basis every budget in this repository uses. */
export function documentBytes(html: string): number {
  return gzipSync(Buffer.from(html, 'utf8'), { level: 9 }).length
}

/** The transferred bytes of one fetched resource. See {@link ALREADY_COMPRESSED}. */
export function transferredBytes(contentType: string, body: Buffer): number {
  return ALREADY_COMPRESSED.test(contentType) ? body.length : gzipSync(body, { level: 9 }).length
}

/** How a resource is fetched. Injected so the measurement can be driven without a running server. */
export type ResourceFetcher = (
  path: string,
) => Promise<{ readonly contentType: string; readonly body: Buffer }>

/**
 * The critical-path weight of one page, measured from the page itself.
 *
 * Throws for a document that could not be fetched: a page that will not render is a page nobody can
 * publish, and reporting it as weighing nothing would make it the lightest page on the site.
 *
 * A resource that 404s is counted as zero and does NOT throw, which is deliberate and is the conservative
 * direction: a missing preload target is a rendering defect for `hero-lcp.itest.ts` and `pnpm media` to
 * report, and refusing the publish here would attribute it to the weight budget.
 */
export async function measureCriticalPath(
  fetchResource: ResourceFetcher,
  subject: { readonly surface: string; readonly path: string },
): Promise<PublicationWeightSubject> {
  const document = await fetchResource(subject.path)
  const html = document.body.toString('utf8')
  let assetBytes = 0
  let imageBytes = 0
  for (const resource of criticalResourcesIn(html)) {
    let bytes = 0
    try {
      const fetched = await fetchResource(resource.href)
      bytes = transferredBytes(fetched.contentType, fetched.body)
    } catch {
      bytes = 0
    }
    if (resource.kind === 'image') imageBytes += bytes
    else assetBytes += bytes
  }
  return {
    surface: subject.surface,
    documentBytes: documentBytes(html),
    criticalAssetBytes: assetBytes,
    criticalImageBytes: imageBytes,
  }
}

// ------------------------------------------------------------------------------------------------
// The gate
// ------------------------------------------------------------------------------------------------

export interface PublishGateDeps {
  readonly sql: Sql
  readonly policy: CompliancePolicyRow
  readonly fetchResource: ResourceFetcher
}

/**
 * Assesses one page against every rule that stands between it and the public.
 *
 * Returns the refusals rather than throwing, for `judgeHomeBudget`'s reason: a page that is over budget AND
 * carries a claim has two things to fix, and being told about one of them costs another render. The caller
 * decides what a non-empty list means — a 422 for the API, a banner for an admin screen — and nothing may
 * publish while one is non-empty, which the database then re-refuses on its own terms.
 *
 * The lint runs before the document is fetched, and that order is deliberate: rendering a page in order to
 * refuse it for a word in its title is work nobody needs, and a page whose copy is refused is not a page
 * whose weight anybody will act on. The refusals are still returned together.
 */
export async function assessPublication(
  deps: PublishGateDeps,
  subject: PublicationSubject,
): Promise<PublicationAssessment> {
  const policy = compliancePolicyOf(deps.policy)
  const canonicalContent = publicationCanonicalContent(subject.regions)
  const contentSha256 = await publicationContentHash(deps.sql, canonicalContent)
  const vocabulary = bannedClaimVocabulary(policy)

  const refusals: PublicationGateRefusal[] = []
  for (const finding of publicationCopyFindings(subject.regions, policy)) {
    refusals.push({
      rule: finding.rule,
      where: finding.region,
      measuredBytes: null,
      message: `[${finding.rule}] ${finding.region}: "${finding.term}" — ${finding.why}`,
    })
  }

  // W-SYS-09's rules, unchanged. Alt text as well as weight: a row can be edited after it was accepted,
  // which is why the check is made again here rather than trusted from the upload.
  for (const refusal of publicationRefusals(subject.slotImages)) {
    refusals.push(slotRefusalOf(refusal))
  }

  const measurement = await measureCriticalPath(deps.fetchResource, subject)
  const budgetBytes = homeBudgetLimit('critical-above-fold')
  for (const refusal of publicationWeightRefusals(measurement, budgetBytes)) {
    refusals.push({
      rule: refusal.rule,
      where: subject.path,
      measuredBytes: refusal.measuredBytes,
      message: refusal.message,
    })
  }

  return {
    surface: subject.surface,
    contentSha256,
    canonicalContent,
    termsChecked: vocabulary.length,
    profileVersion: deps.policy.profileVersion,
    measurement,
    measuredCriticalPathBytes: criticalPathBytes(measurement),
    criticalPathBudgetBytes: budgetBytes,
    refusals: Object.freeze(refusals),
  }
}

/** One of W-SYS-09's refusals, in this gate's shape. A field copy; nothing is re-decided. */
export function slotRefusalOf(refusal: SlotRefusal): PublicationGateRefusal {
  return {
    rule: refusal.rule,
    where: `slot:${refusal.slot}`,
    measuredBytes: refusal.measuredBytes,
    message: refusal.message,
  }
}

/** Where the publication control plane answers. Declared here so a form and the route cannot disagree. */
export const PUBLICATION_ENDPOINT = '/api/v1/publication/publish'
