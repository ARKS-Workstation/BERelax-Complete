import { AppError } from '@berelax/shared'

/**
 * What the SEO agent is allowed to have an opinion about: the suggestion-target allowlist.
 *
 * ## Why an allowlist and not a denylist
 *
 * A denylist of forbidden targets answers the question "is this one of the things we thought of?", and the
 * target that matters is the one nobody thought of. An allowlist answers "is this one of the things we
 * decided the agent may propose?", so a surface added to the site next month is outside the cage until
 * somebody puts it inside deliberately. That is the same argument F07 makes for deny-by-default and it is
 * the reason {@link SUGGESTION_TARGET_KINDS} is short.
 *
 * Everything on the list has one property in common: applying the suggestion changes **copy a human reads**,
 * and a human can read the before and after and judge it. Everything left off changes an **instruction to a
 * machine** — a crawler directive, a canonical, a redirect, a sitemap entry — where the damage is invisible
 * in the diff and shows up weeks later as lost traffic.
 *
 * ## The four the criterion names, and the fifth
 *
 * G-SEO-02's acceptance names robots.txt, a canonical tag, a redirect rule and a noindex directive. The
 * sitemap is here too, in {@link DENIED_TARGET_REF_MARKERS}, because `sitemap:write` is one of the
 * capabilities the principal is denied: a suggestion targeting a surface nobody could ever be authorised to
 * apply is not a safe suggestion, it is a queue entry that will eventually be applied by somebody with the
 * owner's credentials and no idea why the agent was not allowed to ask.
 *
 * ## Two enforcement points, deliberately
 *
 * This module is the code half. The database half is `seo_suggestion_candidate`'s two CHECK constraints in
 * migration 0057 — `target_kind in (…)` and `not seo_target_ref_is_denied(target_ref)`. Neither is redundant:
 * code refuses with a reason an operator can read and cannot be reached by `psql`, a restored dump or a
 * migration; the constraint can, and refuses with a constraint name and no explanation. The two are held to
 * each other by `packages/google/src/seo/seo-agent-cage.itest.ts`, which drives {@link TARGET_REF_SPECIMENS}
 * through both implementations and asserts they agree case by case — because two spellings of one rule is
 * exactly the arrangement that drifts.
 */

/**
 * Every target the agent may propose a change to.
 *
 * `json_ld_field` is deliberately absent, and it is the one a reader will look for: the structured-data graph
 * is the SEO agent's natural territory. It is absent because the graph's `@id` and `url` fields ARE canonical
 * identity — a suggestion that rewrote one would be a canonical change under another name, which is the
 * third denied target on the list. W-SITE-03 builds the graph from the catalogue and the premises row, so
 * there is nothing there for a suggestion to edit that is not already an edit to its source.
 */
export const SUGGESTION_TARGET_KINDS = [
  'page_title',
  'meta_description',
  /** An `<h2>` a reader sees. docs/09 §"LLM SEO" wants question-shaped ones with stable anchors. */
  'heading',
  'body_copy',
  /** The anchor TEXT of an internal link, never its destination — a destination change is a redirect. */
  'internal_link_anchor',
  'faq_answer',
  'image_alt',
] as const
export type SuggestionTargetKind = (typeof SUGGESTION_TARGET_KINDS)[number]

/**
 * The four the acceptance criterion names, spelled as a target kind would be.
 *
 * Deny-by-default already refuses these — they are not in the allowlist — so this list grants and forbids
 * nothing. It exists so that "proven for all four" is a list a test iterates rather than four cases somebody
 * remembered to write, and so that the four are refused BY NAME rather than as four arbitrary strings.
 */
export const DENIED_SUGGESTION_TARGET_KINDS = [
  'robots_txt',
  'canonical',
  'redirect',
  'noindex',
] as const
export type DeniedSuggestionTargetKind = (typeof DENIED_SUGGESTION_TARGET_KINDS)[number]

/** True for a target kind on the allowlist. Deny by default: any other string is refused. */
export function isAllowedSuggestionTargetKind(value: string): value is SuggestionTargetKind {
  return (SUGGESTION_TARGET_KINDS as readonly string[]).includes(value)
}

/**
 * Substrings that make a target reference a machine directive rather than a piece of copy.
 *
 * ## Why substring matching is right here and wrong for copy
 *
 * A `target_ref` is a **locator** — `/treatments/hot-oil-massage#title`, `faq:parking`,
 * `journal:after-care#h2-3` — and never the copy itself. The copy is G-SEO-05's `before` and `after`. So the
 * false-positive risk that makes substring matching wrong for prose (`lintCmsCopy` has to strip URLs before
 * linting, because a link to `/treatments` contributes the banned token `treatment`) does not exist: no
 * legitimate locator in this site contains the word `canonical`.
 *
 * This is the second line of defence and not the first. The first is {@link SUGGESTION_TARGET_KINDS}, which
 * refuses `target_kind = 'robots_txt'` outright. This one refuses `target_kind = 'body_copy'` with
 * `target_ref = '/robots.txt'` — the same edit with an honest-looking label on it, which is what an allowlist
 * on the kind alone cannot see.
 *
 * Case-folded and nothing else: a locator is ASCII by construction here, and a normalising comparison
 * (accent stripping, homoglyph folding) would be a second, subtly different spelling of
 * `lexiconTokens`. Mirrored exactly by `seo_target_ref_is_denied()` in migration 0057.
 */
export const DENIED_TARGET_REF_MARKERS = [
  'robots.txt',
  'x-robots-tag',
  'canonical',
  'noindex',
  'redirect',
  'sitemap.xml',
] as const

/** The marker that makes a reference a denied surface, or null. Null means allowed by this rule. */
export function deniedTargetRefMarker(ref: string): string | null {
  const folded = ref.toLowerCase()
  for (const marker of DENIED_TARGET_REF_MARKERS) {
    if (folded.includes(marker)) return marker
  }
  return null
}

/** Why a target was refused. Named, so a caller branches on the rule rather than on a sentence. */
export const SUGGESTION_TARGET_RULES = [
  'target_kind_not_allowlisted',
  'target_ref_is_a_machine_directive',
] as const
export type SuggestionTargetRule = (typeof SUGGESTION_TARGET_RULES)[number]

/** A target, as the allowlist sees it. */
export interface SuggestionTarget {
  readonly kind: string
  readonly ref: string
}

/** The rule a target breaks, or null when it is allowed. Both checks, in declared order. */
export function suggestionTargetRefusal(target: SuggestionTarget): {
  readonly rule: SuggestionTargetRule
  readonly detail: string
} | null {
  if (!isAllowedSuggestionTargetKind(target.kind)) {
    return { rule: 'target_kind_not_allowlisted', detail: target.kind }
  }
  const marker = deniedTargetRefMarker(target.ref)
  if (marker !== null) return { rule: 'target_ref_is_a_machine_directive', detail: marker }
  return null
}

/** True when both checks pass. */
export function isAllowedSuggestionTarget(target: SuggestionTarget): boolean {
  return suggestionTargetRefusal(target) === null
}

/** Raised rather than proposed. `details.rule` is what a test asserts, never the sentence. */
export class SuggestionTargetRefused extends AppError {
  readonly rule: SuggestionTargetRule
  constructor(target: SuggestionTarget, rule: SuggestionTargetRule, detail: string) {
    super(
      'validation',
      `a suggestion may not target ${target.kind} ${target.ref}: ${rule} (${detail}). ` +
        'The SEO agent proposes changes to copy a human reads; a crawler directive, a canonical, a ' +
        'redirect or a sitemap entry is an instruction to a machine and is denied at the permission layer.',
      { details: { code: 'suggestion_target_refused', rule, detail, kind: target.kind } },
    )
    this.name = 'SuggestionTargetRefused'
    this.rule = rule
  }
}

/** Throws unless the target is on the allowlist. */
export function assertAllowedSuggestionTarget(target: SuggestionTarget): void {
  const refusal = suggestionTargetRefusal(target)
  if (refusal === null) return
  throw new SuggestionTargetRefused(target, refusal.rule, refusal.detail)
}

/**
 * The reviewed corpus that holds the code and the SQL to each other.
 *
 * Every entry is a locator with the marker it must be refused by, or `null` for one that must be accepted.
 * The accepted half is the load-bearing half: two implementations that refuse EVERYTHING agree perfectly,
 * and a corpus with no accepted entries could not tell that apart from two that agree correctly.
 *
 * The values are locators from this site's own route set (docs/09 §1) rather than invented paths, so an entry
 * that stops being a real locator is a signal rather than a detail.
 */
export const TARGET_REF_SPECIMENS: readonly {
  readonly ref: string
  readonly marker: string | null
}[] = Object.freeze([
  { ref: '/treatments/hot-oil-massage#title', marker: null },
  { ref: '/treatments/four-hands-massage#meta', marker: null },
  { ref: 'faq:parking', marker: null },
  { ref: 'journal:after-care#h2-3', marker: null },
  { ref: '/spa', marker: null },
  { ref: '/ar/pricing', marker: null },
  { ref: 'image:hero-4x5', marker: null },
  { ref: '/robots.txt', marker: 'robots.txt' },
  { ref: '/ROBOTS.TXT', marker: 'robots.txt' },
  { ref: 'header:X-Robots-Tag', marker: 'x-robots-tag' },
  { ref: '/treatments/hot-oil-massage canonical', marker: 'canonical' },
  { ref: 'link[rel=canonical]', marker: 'canonical' },
  { ref: 'meta[name=robots][content=noindex]', marker: 'noindex' },
  { ref: 'redirect_map:/old-price-list', marker: 'redirect' },
  { ref: '/sitemap.xml', marker: 'sitemap.xml' },
])
