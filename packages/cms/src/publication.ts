import {
  type CompliancePolicy,
  lintPublicDisplayName,
  matchedEscalationCategories,
  matchReviewEscalations,
  type PublicNameFinding,
  type ReviewEscalationCategory,
} from '@berelax/core'
import { AppError } from '@berelax/shared'

/**
 * The publication lint: what a journal post must carry before it may be published, and what published CMS
 * copy may not say.
 *
 * docs/09 §"E-E-A-T" is the specification and it is one sentence: *"named therapists with verifiable
 * credentials, author and reviewer bylines with dates, a medical-disclaimer pattern, and the hard rule that
 * no copy makes a medical claim the licence does not support — enforced by the publication lint, not by
 * good intentions."* Everything in this module is one of those four clauses, and the fourth is the reason
 * the other three are refusals rather than warnings: this is a licensed massage and spa business in Abu
 * Dhabi, ADDED licences the activity and the Department of Health licences health services, so a health
 * claim in a journal post is a regulatory matter and not a style one.
 *
 * ## Why the guard is here and not in the page
 *
 * A page can only refuse to render. The moment a post becomes *published* is the moment it becomes
 * publishable copy, and that moment is a CMS mutation — so the rule belongs where the CMS's other
 * lifecycle rule already is (`lifecycle.ts`, which refuses unpublishing a narrative with future bookings).
 * The rendered route re-applies it on the way out, for the same reason `publishLlmsTxt` lints a file it
 * built from rows it trusts: a row can arrive through a path that bypassed the hook — a `psql` session, a
 * restored dump, a migration — and the page is where such a row becomes public.
 *
 * ## Why a byline is a refusal and not a default
 *
 * Because the only value that would satisfy a default is the name of a person. `JOURNAL_POSTS.byline`
 * starts empty on purpose and its help text says so: "leave empty until there is a real one to put here".
 * An unattributed post is a visibly incomplete post; an attributed one naming somebody who does not exist
 * is a false credential on health-adjacent copy, which is worse in exactly the way this whole build treats
 * a plausible TRN as worse than a blank one (migration 0026's `is_placeholder_text`). So the rule refuses
 * publication, the admin sees which field is missing, and nothing here invents a name.
 *
 * ## Health adjacency is detected, not declared
 *
 * A checkbox alone would make the disclaimer optional in practice: the post that most needs it is the one
 * whose author did not think of it as health copy. So the editor's declaration is one input and the text is
 * the other, through `matchReviewEscalations` — G-REV-03's lexicon, whose `injury`, `illness` and `pain`
 * categories are the same vocabulary docs/07 §4 lists as never-auto-answerable. One list, two readings: a
 * review alleging pain may not be answered by a machine, and a post discussing pain may not be published
 * without the disclaimer. Over-detection costs a disclaimer on a post that did not need one, which is the
 * direction to err in.
 */

/** The rules, by name. A refusal names one of these, so a reworded message is not a reworded rule. */
export const PUBLICATION_RULES = [
  'journal_post_without_author_byline',
  'journal_post_without_reviewer_byline',
  'journal_post_without_date',
  'journal_post_health_adjacent_without_disclaimer',
] as const
export type PublicationRule = (typeof PUBLICATION_RULES)[number]

/** The escalation categories that make copy health-adjacent. docs/07 §4's first three. */
export const HEALTH_ADJACENT_CATEGORIES: readonly ReviewEscalationCategory[] = Object.freeze([
  'injury',
  'illness',
  'pain',
])

/**
 * A journal post as the publication lint sees it. Not the Payload document.
 *
 * `bodyText` is the rich text already flattened to plain text, because the Lexical renderer lives in
 * `apps/web` and this package may not import Payload (see `fields.ts` on why the model is framework-free).
 * A flattener that returned an empty string would make every claim in every post invisible to the lint, so
 * `apps/web/src/cms/content.ts` asserts its own output against a fixture with nested nodes.
 */
export interface JournalPostForPublication {
  readonly slug: string
  readonly title: string
  readonly standfirst: string | null
  readonly bodyText: string
  /** The author. `null` or blank is the honest state of an unattributed post. */
  readonly byline: string | null
  /** Who checked it. Separate from the author, because a reviewer who is the author reviews nothing. */
  readonly reviewedBy: string | null
  /** `YYYY-MM-DD` or an ISO instant, as Payload stores a date field. */
  readonly publishedOn: string | null
  /** The editor's own declaration that this is health copy. One of the two inputs; see the header. */
  readonly healthTopicDeclared: boolean
}

/** Whether a piece of copy is health-adjacent, and what made it so. */
export interface HealthAdjacency {
  readonly adjacent: boolean
  readonly declared: boolean
  /** The escalation categories the text matched, in the lexicon's declared order. */
  readonly detected: readonly ReviewEscalationCategory[]
}

/**
 * Is this copy health-adjacent?
 *
 * The declaration and the detection are both reported rather than collapsed into a boolean, because the
 * admin has to be able to say *why* a disclaimer is required on a post whose author did not tick the box.
 */
export function healthAdjacencyOf(text: string, declared: boolean): HealthAdjacency {
  const categories = matchedEscalationCategories(matchReviewEscalations(text)).filter((category) =>
    HEALTH_ADJACENT_CATEGORIES.includes(category),
  )
  return {
    adjacent: declared || categories.length > 0,
    declared,
    detected: Object.freeze(categories),
  }
}

/** Every text of a post that a reader sees, as one string, for the lints that judge copy. */
export function journalPostProse(post: JournalPostForPublication): string {
  return [post.title, post.standfirst ?? '', post.bodyText].join('\n')
}

const blank = (value: string | null): boolean => value === null || value.trim() === ''

export interface PublicationFinding {
  readonly rule: PublicationRule
  readonly why: string
}

/**
 * What a post is carrying the medical-disclaimer pattern with, or the reason it cannot.
 *
 * `disclaimer` is `compliance_notices.medical_disclaimer` — the owner-only global whose whole purpose is
 * that its wording "keeps a description of a massage from reading as a therapeutic claim" (ADR 0020). It
 * is passed in rather than read here, because a package that may not do I/O cannot fetch a global, and
 * because the page has already read it for rendering.
 */
export interface PublicationContext {
  /** The disclaimer wording in force, already flattened to text, or null when the global is unwritten. */
  readonly disclaimer: string | null
}

/**
 * Every reason this post may not be published, in rule order.
 *
 * All of them rather than the first, for the reason `lintPublicDisplayName` gives: an editor told about one
 * missing field fixes that field and submits again.
 */
export function journalPostFindings(
  post: JournalPostForPublication,
  context: PublicationContext,
): readonly PublicationFinding[] {
  const findings: PublicationFinding[] = []
  if (blank(post.byline)) {
    findings.push({
      rule: 'journal_post_without_author_byline',
      why:
        'no author byline. docs/09 §"E-E-A-T" requires an author byline with a date on editorial copy in ' +
        'a health-adjacent category. Put the name of the person who wrote it in the Byline field — and ' +
        'nothing else: a byline naming somebody who does not exist is a false credential.',
    })
  }
  if (blank(post.reviewedBy)) {
    findings.push({
      rule: 'journal_post_without_reviewer_byline',
      why:
        'no reviewer byline. The reviewer is the second name docs/09 §"E-E-A-T" asks for and is what makes ' +
        'the claim that somebody checked this copy against the licence checkable.',
    })
  }
  if (blank(post.publishedOn)) {
    findings.push({
      rule: 'journal_post_without_date',
      why:
        'no publication date. An undated post cannot be assessed for freshness by a reader, a crawler or ' +
        'an assistant, and a date added later by a template would be the date of the deploy.',
    })
  }
  const health = healthAdjacencyOf(journalPostProse(post), post.healthTopicDeclared)
  if (health.adjacent && blank(context.disclaimer)) {
    findings.push({
      rule: 'journal_post_health_adjacent_without_disclaimer',
      why:
        'is health-adjacent ' +
        (health.declared
          ? 'because it is declared as health copy'
          : `because its copy matches ${health.detected.join(', ')}`) +
        ', and compliance_notices.medical_disclaimer is empty. The disclaimer is the wording that keeps a ' +
        'description of a massage from reading as a therapeutic claim (ADR 0020); publishing health copy ' +
        'without it is the regulatory exposure, and inventing the wording here would be a licensing act ' +
        'taken by a template. The owner writes it once in the admin.',
    })
  }
  return Object.freeze(findings)
}

/** Raised rather than published. `details.rules` is what a test asserts, never the sentence. */
export class JournalPostRefused extends AppError {
  readonly findings: readonly PublicationFinding[]
  constructor(slug: string, findings: readonly PublicationFinding[]) {
    super(
      'validation',
      `journal post '${slug}' cannot be published: ` +
        findings.map((finding) => `${finding.rule} — ${finding.why}`).join('; '),
      {
        userFacing: true,
        details: {
          code: 'journal_post_refused',
          slug,
          rules: findings.map((finding) => finding.rule),
        },
      },
    )
    this.name = 'JournalPostRefused'
    this.findings = Object.freeze([...findings])
  }
}

/** Throws unless the post may be published. */
export function assertJournalPostPublishable(
  post: JournalPostForPublication,
  context: PublicationContext,
): void {
  const findings = journalPostFindings(post, context)
  if (findings.length > 0) throw new JournalPostRefused(post.slug, findings)
}

/** The rules a refusal carries, or null — so a caller branches without matching on a message. */
export function journalRefusalRulesOf(error: unknown): readonly PublicationRule[] | null {
  return error instanceof JournalPostRefused ? error.findings.map((finding) => finding.rule) : null
}

// ------------------------------------------------------------------------------------------------
// The banned-claims lint over published CMS copy
// ------------------------------------------------------------------------------------------------

/**
 * One piece of CMS copy, named so a refusal says which document it came from.
 *
 * `where` is a locator — a collection and a slug — and never the copy itself, because the message is shown
 * in an admin screen and the offending phrase is already carried by the finding.
 */
export interface CmsCopy {
  readonly where: string
  readonly text: string
}

/**
 * Published CMS copy, linted against the profile in force.
 *
 * The same lint the catalogue's public display names go through (B-CAT-05), applied to the prose a CMS
 * route renders. The lexicon's claim half comes from `regulatory_profile` — which is why the policy is an
 * argument — so the day Y1-licence is answered this becomes stricter or looser without a deploy.
 *
 * **URLs are removed before the lint sees the text, and that exclusion is load-bearing.** `lexiconTokens`
 * splits on every non-alphanumeric character, so a link to `/treatments` contributes the token
 * `treatments`, and `treatment` is on `banned_claim_terms` under the stricter default licence (0004). This
 * is the same decision, for the same reason, that `apps/web/src/facts/llms.ts` records for `/llms.txt`: a
 * path is a locator, not a claim, and a lint that refused a page for linking to the most valuable pages on
 * the site is a lint somebody switches off. It is re-implemented here rather than imported because that
 * function lives in `apps/web` and this package may not depend on the application.
 */
export function lintCmsCopy(
  copy: readonly CmsCopy[],
  policy: CompliancePolicy,
): readonly CmsCopyFinding[] {
  const findings: CmsCopyFinding[] = []
  for (const entry of copy) {
    for (const finding of lintPublicDisplayName(withoutLocators(entry.text), policy)) {
      findings.push({ where: entry.where, ...finding })
    }
  }
  return Object.freeze(findings)
}

/** A finding, with the document it came from. */
export interface CmsCopyFinding extends PublicNameFinding {
  readonly where: string
}

/** A URL and a markdown link target removed, so a locator is not read as a claim. See {@link lintCmsCopy}. */
export function withoutLocators(text: string): string {
  return text.replace(/https?:\/\/\S+/g, ' ').replace(/\]\([^)]*\)/g, '] ')
}

/** Raised rather than rendered. The same fail-closed shape `publishLlmsTxt` uses. */
export class CmsCopyRefused extends AppError {
  readonly findings: readonly CmsCopyFinding[]
  constructor(findings: readonly CmsCopyFinding[]) {
    super(
      'invariant_violated',
      `CMS copy cannot be published: ${findings
        .map((finding) => `${finding.where}: ${finding.rule} — ${finding.term}`)
        .join('; ')}`,
      {
        details: {
          code: 'cms_copy_refused',
          rules: findings.map((finding) => finding.rule),
          terms: findings.map((finding) => finding.term),
          where: findings.map((finding) => finding.where),
        },
      },
    )
    this.name = 'CmsCopyRefused'
    this.findings = Object.freeze([...findings])
  }
}

/** Throws unless every piece of copy may be published. */
export function assertCmsCopyCompliant(copy: readonly CmsCopy[], policy: CompliancePolicy): void {
  const findings = lintCmsCopy(copy, policy)
  if (findings.length > 0) throw new CmsCopyRefused(findings)
}
