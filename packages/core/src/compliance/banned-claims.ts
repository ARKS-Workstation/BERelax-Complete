import { AppError } from '@berelax/shared'
import {
  COMPLIANCE_LEXICON,
  type CompliancePolicy,
  lintPublicDisplayName,
  PROVIDER_TITLES,
  type PublicNameFinding,
  type PublicNameRule,
} from './lexicon.ts'

/**
 * The banned-claims lint at the moment of publication (W-SITE-10).
 *
 * ## There is no list in this file, and that is the point
 *
 * The vocabulary this lint compares against is `regulatory_profile.banned_claim_terms` (0004, ADR 0020)
 * plus the code half of {@link COMPLIANCE_LEXICON}, and it reaches the comparison through
 * {@link lintPublicDisplayName} — the same function the catalogue's public display names go through
 * (B-CAT-05) and the same one `packages/cms/src/publication.ts` calls for CMS copy (W-SITE-07). A second
 * list here would be a second statement of a fact the profile already owns, and the way that fails is not
 * that it is wrong when written: it is that the profile is corrected on the Unconfirmed Assumptions panel
 * the day Y1-licence is answered, every consumer becomes stricter or looser without a deploy, and this one
 * does not.
 *
 * So what this module adds is not vocabulary. It is three things the existing lint does not have:
 *
 *   1. **A region.** A page is a title, a meta description, a standfirst, a body and the alt text of its
 *      images, and an editor told that "the page" contains a banned claim has to read all of it. Every
 *      finding names which region it came from.
 *   2. **The count of terms the pass actually compared against**, through {@link bannedClaimVocabulary}.
 *      `publication_lint_pass.terms_checked` is `> 0` in the database, so a lint run against an empty
 *      vocabulary cannot be recorded as a pass — which is ADR 0002 moved into the schema: a check that
 *      examined nothing is worse than one that failed.
 *   3. **A refusal that names the rule**, so the publish gate reports `banned_claim_term` and the offending
 *      phrase rather than "this page cannot be published" (ADR 0003 is about a gate's fixture; this is the
 *      same argument from the editor's side).
 *
 * ## What is linted, and what deliberately is not
 *
 * The regions the publication is ABOUT — the document's own copy — and never the chrome around it. That is
 * not a convenience: `/treatments` is a route on this site and `treatment` is on the profile's term list,
 * so a lint over a whole rendered page would refuse every page in the site for its own navigation, and the
 * first thing anybody would do is switch it off. The chrome's copy is the catalogue's and the CMS globals',
 * each linted where it is written.
 *
 * Within those regions the text is rendered PROSE and not markup, which is why nothing here strips a URL.
 * `packages/cms/src/publication.ts` has to strip one because it reads rich-text source, where
 * `](/treatments)` is a link target that happens to tokenise into a claim; a rendered text node has no
 * such construct — a link contributes its label, which is copy a reader reads and copy this lint should
 * see. Re-implementing the stripper here would be a third copy of it (`apps/web/src/facts/llms.ts` holds
 * the second), and a third copy of a rule is how two of them come to disagree.
 *
 * ## Purity
 *
 * `packages/core` may not read a database, so the profile arrives as {@link CompliancePolicy} from the
 * caller — the same argument `lexicon.ts` makes, and the thing that makes the licence flip testable: the
 * identical string is refused under the seeded profile and accepted under a healthcare one.
 */

/** One region of a page, named so a refusal says where to look. */
export interface PublishedCopyRegion {
  /** `title`, `meta_description`, `standfirst`, `body`, `image_alt[hero]` — a locator inside the document. */
  readonly region: string
  /** The rendered prose of that region. See the header on why nothing is stripped from it. */
  readonly text: string
}

/** A finding, with the region of the page it came from. */
export interface PublishedCopyFinding extends PublicNameFinding {
  readonly region: string
}

/**
 * Every banned term this pass will compare a page against, given the profile in force.
 *
 * Derived, never declared: the profile's claim list (empty under a healthcare licence, because
 * `lintPublicDisplayName` skips it wholesale there and a count that included it would overstate what was
 * examined), the code half's phrases, and the provider titles the profile does not permit.
 *
 * Its only consumer is `publication_lint_pass.terms_checked`, and its only job is to make the recorded
 * number the real one. A constant there would say a pass examined fifteen terms whatever the profile held.
 */
export function bannedClaimVocabulary(policy: CompliancePolicy): readonly string[] {
  const permitted = new Set(
    policy.permittedPublicTitles.flatMap((title) => title.toLowerCase().split(/[^a-z]+/)),
  )
  return Object.freeze([
    ...(policy.medicalClaimsPermitted ? [] : policy.bannedClaimTerms),
    ...COMPLIANCE_LEXICON.map((entry) => entry.term),
    ...PROVIDER_TITLES.filter((title) => !permitted.has(title)),
  ])
}

/**
 * Every reason this page's copy may not be published, region by region.
 *
 * All of them rather than the first, for the reason `lintPublicDisplayName` gives about an editor told
 * about one word: the four findings in one paragraph are four edits and they are worth making in one pass.
 * Regions are walked in the order given, so the order of a refusal is the order of the document.
 */
export function publicationCopyFindings(
  regions: readonly PublishedCopyRegion[],
  policy: CompliancePolicy,
): readonly PublishedCopyFinding[] {
  const findings: PublishedCopyFinding[] = []
  for (const region of regions) {
    for (const finding of lintPublicDisplayName(region.text, policy)) {
      findings.push({ region: region.region, ...finding })
    }
  }
  return Object.freeze(findings)
}

/** The rule names a set of findings carries, deduplicated, in the order they were found. */
export function publicationCopyRulesOf(
  findings: readonly PublishedCopyFinding[],
): readonly PublicNameRule[] {
  return Object.freeze([...new Set(findings.map((finding) => finding.rule))])
}

/**
 * Raised rather than published.
 *
 * `userFacing`, because the person who wrote the copy is the person who has to change it, and
 * `details.rules` rather than the sentence is what a test and the API's JSON body both read — a reworded
 * message must not be a reworded rule.
 */
export class PublicationCopyRefused extends AppError {
  readonly code = 'publication_copy_refused' as const
  readonly findings: readonly PublishedCopyFinding[]
  constructor(surface: string, findings: readonly PublishedCopyFinding[]) {
    super(
      'validation',
      `'${surface}' cannot be published: ` +
        findings
          .map(
            (finding) => `${finding.region}: ${finding.rule} — "${finding.term}": ${finding.why}`,
          )
          .join('; '),
      {
        userFacing: true,
        details: {
          code: 'publication_copy_refused',
          surface,
          rules: publicationCopyRulesOf(findings),
          terms: findings.map((finding) => finding.term),
          regions: findings.map((finding) => finding.region),
        },
      },
    )
    this.name = 'PublicationCopyRefused'
    this.findings = Object.freeze([...findings])
  }
}

/** Throws unless every region may be published. */
export function assertPublicationCopyCompliant(
  surface: string,
  regions: readonly PublishedCopyRegion[],
  policy: CompliancePolicy,
): void {
  const findings = publicationCopyFindings(regions, policy)
  if (findings.length > 0) throw new PublicationCopyRefused(surface, findings)
}

/** The rules a refusal carries, or null — so a caller branches without matching on a message. */
export function publicationCopyRefusalRulesOf(error: unknown): readonly PublicNameRule[] | null {
  return error instanceof PublicationCopyRefused ? publicationCopyRulesOf(error.findings) : null
}
