import {
  configuredReviewLanguages,
  type DetectableReviewLanguage,
  type ReviewReplyMode,
  reviewAutosendEnabled,
  reviewCoolingOffHours,
  reviewReplyMode,
} from '@berelax/shared'
import type { Instant } from '../time.ts'
import {
  matchedEscalationCategories,
  matchReviewEscalations,
  REVIEW_ESCALATION_LEXICON_VERSION,
  type ReviewEscalationCategory,
  type ReviewEscalationLexicon,
  type ReviewEscalationMatch,
} from './escalation-lexicon.ts'
import { textNamesAnIndividual } from './individuals.ts'
import { detectReviewLanguage, languageIsConfigured } from './language.ts'

/**
 * The docs/07 §4 safety routing table, as the implementation rather than as a document beside one.
 *
 * ## Executable means the table *is* the code
 *
 * {@link REVIEW_ROUTING_RULES} declares every rule id in **evaluation order**, and
 * {@link ROWS} is a `Record` over that union — so a rule added to the list without a row fails to
 * compile, and a row can never be added without a rule id. {@link REVIEW_ROUTING_TABLE} is then
 * *derived* from the list, in list order, which is why there is no second place where precedence is
 * written down and no way for the table to contain a row the union does not know about or to omit one it
 * does. {@link routeReview} is a fold over that array and contains no policy of its own.
 *
 * The four documented rows are {@link DOCUMENTED_ROWS}, and every rule names the row it implements.
 * `packages/fixtures/src/review-routing-table.test.ts` parses the markdown table out of
 * `docs/07-frontend-and-agents-requirements.md` and asserts the counts agree, so a row deleted from the
 * document or from this file fails the build rather than drifting.
 *
 * ## Every route is total, and refusal is the direction of every default
 *
 * There is exactly one permissive outcome in this system — `auto_send`, from
 * `quiet_high_rating_may_auto_send` — and reaching it requires **nine** preceding rows to decline. Every
 * other way out is `escalate`:
 *
 *   - an absent, empty or non-array table → `routing_table_unavailable`;
 *   - an absent or unreadable policy, including a lexicon version this build cannot resolve →
 *     `routing_policy_unavailable`;
 *   - a review that is not a review: `null`, a missing rating, a fractional or out-of-range rating, a
 *     `reviewedAt` that is not a finite instant → `unroutable_review`;
 *   - a rule id read back from a stored row that this build does not declare →
 *     {@link reviewVerdictForRule} answers `escalate`, the same shape as `genderMatchingMode` in
 *     `@berelax/shared`: the permissive answer must be asked for **exactly**.
 *
 * And after the fold, {@link autoSendFloor} applies the whole of docs/07 §4 row 1 a **second time**,
 * independently, over the same inputs. If the fold says `auto_send` and the floor disagrees, the answer
 * is `escalate` with `auto_send_floor_violated`. That is deliberately redundant, for the reason
 * `narrowPoolByGender` re-applies `genderVerdict` after the provider has already applied it: a second
 * application of one predicate narrows an answer that is already narrow and catches one that is not,
 * and here the thing it catches is a mistake in any of the nine rows above it.
 *
 * ## Compliance-locked, not a setting
 *
 * The four settings that bear on an auto-send arrive **raw**, as `unknown`, and are normalised here by
 * `@berelax/shared`'s floors. A caller cannot pass a pre-normalised value and cannot skip the
 * normalisation, which is the difference between a floor and a convention. What that buys, asserted over
 * every combination of the four in `routing.test.ts`:
 *
 *   - `agents.review_autosend_enabled` is `compliance_locked` and defaults to `false`. Only the boolean
 *     `true` enables anything;
 *   - `google.business_profile_access_granted` decides whether API mode exists at all. In draft mode —
 *     the launch mode, for weeks (docs/10 §6) — nothing auto-sends, because there is no API to send
 *     through;
 *   - `agents.review_autosend_cooling_off_hours` can be lengthened and cannot be shortened below
 *     `MINIMUM_REVIEW_COOLING_OFF_HOURS`;
 *   - `agents.review_reply_languages` can only ever name languages this build can identify, so widening
 *     it cannot make an unidentifiable review auto-sendable.
 *
 * A one- or two-star review routes `escalate` under **all** of them, and so does any review whose text
 * matches the escalation lexicon. There is no combination of settings that publishes a reply to either.
 *
 * ## Purity
 *
 * The configured language set, the lexicon and the clock instant are arguments. `now` is an `Instant`
 * supplied by the caller — the cooling-off arithmetic is the only time-dependent thing here and a
 * `Date.now()` in it would make a verdict unreproducible, which is exactly what the "reproduce a
 * historical verdict" requirement forbids.
 */

/** The two outcomes. There is no third, and `escalate` is what everything that is not proved becomes. */
export const REVIEW_ROUTING_VERDICTS = ['auto_send', 'escalate'] as const
export type ReviewRoutingVerdict = (typeof REVIEW_ROUTING_VERDICTS)[number]

/**
 * The rows of the docs/07 §4 table, by the order they appear in it.
 *
 * Numbered rather than named because the document numbers nothing: the id has to be stable against a
 * reworded cell, and the cell text is asserted separately against the file by the fixtures test.
 */
export const DOCUMENTED_ROWS = [1, 2, 3, 4] as const
export type DocumentedRow = (typeof DOCUMENTED_ROWS)[number]

/** What each documented row says, for the test that compares it to the file and for a reader here. */
export const DOCUMENTED_ROW_SUBJECT: Readonly<Record<DocumentedRow, string>> = Object.freeze({
  1: '4–5 star, no free text, no named individual',
  2: '1–2 star',
  3: 'Any mention of injury, illness, pain, staff conduct, refunds, hygiene, or legal threat',
  4: 'Language outside the configured set',
})

/**
 * Every rule id, in evaluation order. The order **is** the table's precedence.
 *
 * The three structural ids come first because they are about whether a decision can be taken at all.
 * Then the documented rows **in the order docs/07 §4 lists them**: rating, escalation terms, language,
 * and then row 1's own conditions. Following the document rather than a judgement about which reason is
 * most interesting is what makes the precedence reviewable against the table it implements — and it is
 * why a three-star review mentioning an injury carries `rating_below_auto_send_band` rather than
 * `escalation_term_present`.
 *
 * That loses nothing an operator needs, because the **reason set does not ride on the rule id**: every
 * decision carries `matches` and `categories`, computed before the fold, so the queue shows "injury"
 * beside the verdict whichever row happened to decide it. The rule id answers "which row of the table
 * decided this", which is the question an audit asks; the categories answer "what is in this review",
 * which is the question the person reading it asks. Collapsing the two into one field is what would lose
 * something.
 *
 * Within row 1, `language_outside_configured_set` sits **above** `free_text_present` deliberately. Both
 * escalate, so the outcome is identical either way, and the acceptance criterion names the rule a
 * five-star Tagalog review must carry — which it can only carry if the language row is reached before the
 * row that escalates anything with text in it.
 */
export const REVIEW_ROUTING_RULES = [
  'routing_table_unavailable',
  'routing_policy_unavailable',
  'unroutable_review',
  'rating_escalates',
  'rating_below_auto_send_band',
  'escalation_term_present',
  'language_outside_configured_set',
  'names_an_individual',
  'free_text_present',
  'autosend_not_enabled',
  'autosend_outside_api_mode',
  'cooling_off_not_elapsed',
  'auto_send_floor_violated',
  'quiet_high_rating_may_auto_send',
] as const
export type ReviewRoutingRule = (typeof REVIEW_ROUTING_RULES)[number]

/** A review, reduced to what a routing decision is allowed to see. */
export interface RoutableReview {
  /** 1..5. Anything else makes the review unroutable rather than lenient. */
  readonly rating: number
  /** `NULL` for a star-only review and never `''` — one fact, one representation (migration 0020). */
  readonly commentText: string | null
  /** When the reviewer left it, as an instant. The cooling-off delay is measured from here. */
  readonly reviewedAt: Instant
}

/**
 * Everything outside the review that the decision depends on, raw.
 *
 * Every setting is `unknown` on purpose. A caller that had to normalise first would be a caller that
 * could normalise wrongly, and "the floor is applied by whoever remembers to apply it" is not a floor.
 */
export interface ReviewRoutingPolicy {
  /** The instant the decision is taken. Always an argument; `packages/core` may not read a clock. */
  readonly now: Instant
  /** `agents.review_autosend_enabled`, exactly as stored. */
  readonly autosendEnabledSetting: unknown
  /** `google.business_profile_access_granted`, exactly as stored. */
  readonly businessProfileAccessSetting: unknown
  /** `agents.review_autosend_cooling_off_hours`, exactly as stored. */
  readonly coolingOffHoursSetting: unknown
  /** `agents.review_reply_languages`, exactly as stored. */
  readonly replyLanguagesSetting: unknown
  /** The lexicon to judge the text against. Versioned, so a stored verdict can be reproduced. */
  readonly lexicon: ReviewEscalationLexicon
}

/** The policy with every floor applied. What a row actually sees. */
export interface NormalisedReviewPolicy {
  readonly now: Instant
  readonly autosendEnabled: boolean
  readonly replyMode: ReviewReplyMode
  readonly coolingOffHours: number
  readonly configuredLanguages: readonly DetectableReviewLanguage[]
  readonly lexicon: ReviewEscalationLexicon
}

/** The context a row is evaluated against: the review, the normalised policy, and the text's matches. */
export interface ReviewRoutingContext {
  readonly review: RoutableReview
  readonly policy: NormalisedReviewPolicy
  readonly matches: readonly ReviewEscalationMatch[]
}

/** One row of the table. */
export interface ReviewRoutingRow {
  readonly rule: ReviewRoutingRule
  readonly verdict: ReviewRoutingVerdict
  /** The docs/07 §4 row this implements, or `null` for the three structural rules. */
  readonly documentedRow: DocumentedRow | null
  /** Why, in a sentence, for the operator's queue and the audit row. */
  readonly why: string
  /**
   * Whether this row applies. `null` marks a **structural** rule — one about the table, the policy or
   * the review being unusable — which cannot be expressed as a predicate over a context that could not
   * be built. Those are emitted by {@link routeReview} directly and are excluded from
   * {@link REVIEW_ROUTING_TABLE}.
   */
  readonly matches: ((context: ReviewRoutingContext) => boolean) | null
}

/**
 * Milliseconds in an hour, and why the cooling-off arithmetic is done in them.
 *
 * `differenceInMinutes` from `../time.ts` rounds, and rounding here rounds in the permissive direction: a
 * review 23 hours 59 minutes 40 seconds old rounds to 1,440 minutes and would satisfy a 24-hour delay by
 * twenty seconds. An `Instant` is milliseconds since the epoch, so the exact comparison is also the
 * simplest one. A review dated in the future gives a negative elapsed time and therefore escalates, which
 * is the right answer for a clock nobody can vouch for.
 */
const MILLISECONDS_PER_HOUR = 3_600_000

/** How long ago the review was left, in hours, unrounded. */
function elapsedHours(now: Instant, reviewedAt: Instant): number {
  return (now - reviewedAt) / MILLISECONDS_PER_HOUR
}

/** The lowest rating docs/07 §4 row 1 will consider at all: its cell reads "4-5 star". */
const LOWEST_AUTO_SENDABLE_RATING = 4

/**
 * The highest rating docs/07 §4 row 2 speaks about: its cell reads "1-2 star".
 *
 * Deliberately not `LOWEST_AUTO_SENDABLE_RATING - 1`. The table has a **gap** — a three-star review is in
 * neither row — and expressing one bound in terms of the other would hide it behind arithmetic. The gap is
 * filled by `rating_below_auto_send_band`, which is row 1's first condition failing rather than row 2
 * applying, because a three-star review is not what "always escalated, never auto-sent" was written about
 * and an operator told otherwise would be reading a rule that does not exist.
 */
const HIGHEST_ALWAYS_ESCALATED_RATING = 2

/** True when the text is more than whitespace. A star-only review stores NULL, so this is belt and braces. */
function hasFreeText(review: RoutableReview): boolean {
  return review.commentText !== null && review.commentText.trim().length > 0
}

/**
 * Whether the text identifies an individual.
 *
 * Delegates to {@link textNamesAnIndividual} in `individuals.ts`, which is where the heuristic lives so
 * that this row and the reply generator's response screen (G-REV-04) cannot disagree about what a name
 * is. The two ask the same question of different text and a second copy would drift.
 *
 * Generous is safe **here and only here**: this row can fire only on a review that carries free text,
 * and the row immediately below it escalates any review that carries free text. So a false positive
 * changes the sentence an operator reads and never the outcome, while a false negative changes nothing
 * at all. That asymmetry is why a heuristic is acceptable in this row and would not be in row 2.
 */
function namesAnIndividual(review: RoutableReview): boolean {
  return textNamesAnIndividual(review.commentText)
}

/**
 * Every row, keyed by rule id.
 *
 * `Record<ReviewRoutingRule, ReviewRoutingRow>`, so the compiler is what proves the table complete: add
 * an id to {@link REVIEW_ROUTING_RULES} and this object stops type-checking until the row exists. That
 * is the assertion the acceptance criterion asks for in the form that cannot be forgotten — a test can
 * be skipped, a `tsc` failure cannot.
 */
const ROWS: Readonly<Record<ReviewRoutingRule, ReviewRoutingRow>> = Object.freeze({
  routing_table_unavailable: {
    rule: 'routing_table_unavailable',
    verdict: 'escalate',
    documentedRow: null,
    why:
      'the routing table was absent or empty, so no rule was applied. A table that cannot be read ' +
      'decides nothing, and deciding nothing means a human reads the review',
    matches: null,
  },
  routing_policy_unavailable: {
    rule: 'routing_policy_unavailable',
    verdict: 'escalate',
    documentedRow: null,
    why:
      'the routing policy or its lexicon could not be read, so the review was never compared to the ' +
      'escalation terms',
    matches: null,
  },
  unroutable_review: {
    rule: 'unroutable_review',
    verdict: 'escalate',
    documentedRow: null,
    why:
      'the review is missing a rating, a rating in 1..5, or a usable review date, so none of the rows ' +
      'below can be evaluated against it',
    matches: null,
  },
  rating_escalates: {
    rule: 'rating_escalates',
    verdict: 'escalate',
    documentedRow: 2,
    why: 'a one- or two-star review is always escalated to a human and never auto-sent (docs/07 §4)',
    matches: (context) => context.review.rating <= HIGHEST_ALWAYS_ESCALATED_RATING,
  },
  rating_below_auto_send_band: {
    rule: 'rating_below_auto_send_band',
    verdict: 'escalate',
    documentedRow: 1,
    why:
      'docs/07 §4 permits an auto-sent reply only for a 4-5 star review, and this one is below that band. ' +
      'It is not the "always escalated" row either — a three-star review is in neither, so it is named as ' +
      'what it is rather than filed under a rule written about one- and two-star reviews',
    matches: (context) => context.review.rating < LOWEST_AUTO_SENDABLE_RATING,
  },
  escalation_term_present: {
    rule: 'escalation_term_present',
    verdict: 'escalate',
    documentedRow: 3,
    why:
      'the review mentions injury, illness, pain, staff conduct, refunds, hygiene or a legal threat. ' +
      'Any of those is a statement only the owner may answer',
    matches: (context) => context.matches.length > 0,
  },
  language_outside_configured_set: {
    rule: 'language_outside_configured_set',
    verdict: 'escalate',
    documentedRow: 4,
    why:
      'the review is not in a language the business is configured to reply in, or is in no language ' +
      'this build can identify. A reply in the wrong language is worse than no reply',
    matches: (context) =>
      hasFreeText(context.review) &&
      !languageIsConfigured(
        detectReviewLanguage(context.review.commentText),
        context.policy.configuredLanguages,
      ),
  },
  names_an_individual: {
    rule: 'names_an_individual',
    verdict: 'escalate',
    documentedRow: 1,
    why:
      'the review names, or lets a reader identify, an individual. Confirming publicly who was on ' +
      'shift — or that a named reviewer was a client — is a confidentiality breach in this industry',
    matches: (context) => namesAnIndividual(context.review),
  },
  free_text_present: {
    rule: 'free_text_present',
    verdict: 'escalate',
    documentedRow: 1,
    why:
      'docs/07 §4 permits an auto-sent reply only for a review with NO free text. Anything a reviewer ' +
      'wrote is read by a human before it is answered',
    matches: (context) => hasFreeText(context.review),
  },
  autosend_not_enabled: {
    rule: 'autosend_not_enabled',
    verdict: 'escalate',
    documentedRow: 1,
    why:
      'agents.review_autosend_enabled is not enabled. It is compliance-locked, owner-only, and ' +
      'defaults to off, so this is the answer until an owner deliberately changes it with a written reason',
    matches: (context) => !context.policy.autosendEnabled,
  },
  autosend_outside_api_mode: {
    rule: 'autosend_outside_api_mode',
    verdict: 'escalate',
    documentedRow: 1,
    why:
      'there is no Business Profile API access, so nothing can be auto-sent: a reply is drafted for a ' +
      'human to post. This is the launch mode, not a fault (docs/10 §6)',
    matches: (context) => context.policy.replyMode !== 'api',
  },
  cooling_off_not_elapsed: {
    rule: 'cooling_off_not_elapsed',
    verdict: 'escalate',
    documentedRow: 1,
    why:
      'the cooling-off delay has not elapsed. A reviewer edits or deletes a review far more often in ' +
      'the first day than after it, and a published reply to a review that has changed is not retractable',
    matches: (context) =>
      elapsedHours(context.policy.now, context.review.reviewedAt) < context.policy.coolingOffHours,
  },
  auto_send_floor_violated: {
    rule: 'auto_send_floor_violated',
    verdict: 'escalate',
    documentedRow: 1,
    why:
      'the rows above reached auto_send but the independent re-check of docs/07 §4 row 1 did not agree. ' +
      'Two applications of one rule disagreeing means the rule is not being applied, so nothing is sent',
    matches: null,
  },
  quiet_high_rating_may_auto_send: {
    rule: 'quiet_high_rating_may_auto_send',
    verdict: 'auto_send',
    documentedRow: 1,
    why:
      'a 4-5 star review with no free text and no named individual, in API mode, after the cooling-off ' +
      'delay, with auto-send deliberately enabled by the owner. The only case docs/07 §4 permits',
    matches: () => true,
  },
})

/**
 * The table: every non-structural row, in declared order.
 *
 * Derived from {@link REVIEW_ROUTING_RULES} rather than written out, so precedence lives in exactly one
 * place and the table cannot contain a row the union does not declare or omit one it does.
 */
export const REVIEW_ROUTING_TABLE: readonly ReviewRoutingRow[] = Object.freeze(
  REVIEW_ROUTING_RULES.map((rule) => ROWS[rule]).filter((row) => row.matches !== null),
)

/** Every row including the structural ones, for a test and for an operator-facing explanation. */
export const REVIEW_ROUTING_ROWS: Readonly<Record<ReviewRoutingRule, ReviewRoutingRow>> = ROWS

/**
 * The verdict a rule id means. Total over `unknown`, and biased to `escalate` by construction.
 *
 * The same shape as `genderMatchingMode`: the permissive answer is returned only for a rule this build
 * declares **and** whose row says `auto_send`. A rule id read back from a row written by a later build,
 * a misspelling, `null`, a number, an object left behind by a half-finished migration — every one of
 * them is `escalate`. The alternative shape, `verdict ?? 'auto_send'` or a membership test that admits
 * anything in a list, is how an unrecognised category becomes permission to publish.
 */
export function reviewVerdictForRule(rule: unknown): ReviewRoutingVerdict {
  if (typeof rule !== 'string') return 'escalate'
  const row = Object.hasOwn(ROWS, rule) ? ROWS[rule as ReviewRoutingRule] : undefined
  return row?.verdict === 'auto_send' ? 'auto_send' : 'escalate'
}

/** A rule id if this build declares it, else `null`. The set of rules is closed and this is the door. */
export function reviewRoutingRule(value: unknown): ReviewRoutingRule | null {
  return typeof value === 'string' && (REVIEW_ROUTING_RULES as readonly string[]).includes(value)
    ? (value as ReviewRoutingRule)
    : null
}

/** The decision, and everything an audit needs to explain it without re-deriving anything. */
export interface ReviewRoutingDecision {
  readonly verdict: ReviewRoutingVerdict
  readonly rule: ReviewRoutingRule
  readonly documentedRow: DocumentedRow | null
  /** The lexicon the decision was taken against. Persisted, so the verdict can be reproduced. */
  readonly lexiconVersion: string
  /** Every escalation term found, in category order. Empty for a star-only review. */
  readonly matches: readonly ReviewEscalationMatch[]
  /** The categories those matches fall in, deduplicated. */
  readonly categories: readonly ReviewEscalationCategory[]
  readonly why: string
}

/**
 * A finite instant. `NaN` and the infinities are the two a JSON round-trip or a bad parse produces,
 * and both would make the cooling-off comparison answer without arithmetic ever happening.
 */
function isUsableInstant(value: unknown): value is Instant {
  return typeof value === 'number' && Number.isFinite(value)
}

/** A rating docs/07 §4 can speak about at all. Anything else is `unroutable_review`. */
function isUsableRating(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 5
}

/** A review shaped well enough for the rows to be evaluated against it. */
function isRoutableReview(value: unknown): value is RoutableReview {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Partial<RoutableReview>
  if (!isUsableRating(candidate.rating)) return false
  if (!isUsableInstant(candidate.reviewedAt)) return false
  return candidate.commentText === null || typeof candidate.commentText === 'string'
}

/** A policy shaped well enough to normalise. The settings themselves are `unknown` by design. */
function isUsablePolicy(value: unknown): value is ReviewRoutingPolicy {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Partial<ReviewRoutingPolicy>
  if (!isUsableInstant(candidate.now)) return false
  const lexicon = candidate.lexicon
  if (lexicon === null || typeof lexicon !== 'object') return false
  return typeof (lexicon as ReviewEscalationLexicon).version === 'string'
}

/** Every floor applied, in one place, so no row and no caller can skip one. */
export function normaliseReviewPolicy(policy: ReviewRoutingPolicy): NormalisedReviewPolicy {
  return {
    now: policy.now,
    autosendEnabled: reviewAutosendEnabled(policy.autosendEnabledSetting),
    replyMode: reviewReplyMode(policy.businessProfileAccessSetting),
    coolingOffHours: reviewCoolingOffHours(policy.coolingOffHoursSetting),
    configuredLanguages: configuredReviewLanguages(policy.replyLanguagesSetting),
    lexicon: policy.lexicon,
  }
}

/**
 * docs/07 §4 row 1, applied a second time and independently.
 *
 * Written as one conjunction rather than as a sequence of rows, so it is a different expression of the
 * same rule and not a copy of the loop above. If this and the table disagree, the table is wrong, and
 * the answer is `escalate` — never the permissive one that happened to be reached first.
 */
export function autoSendFloor(context: ReviewRoutingContext): boolean {
  const { review, policy, matches } = context
  return (
    review.rating >= LOWEST_AUTO_SENDABLE_RATING &&
    !hasFreeText(review) &&
    !namesAnIndividual(review) &&
    matches.length === 0 &&
    policy.autosendEnabled &&
    policy.replyMode === 'api' &&
    elapsedHours(policy.now, review.reviewedAt) >= policy.coolingOffHours
  )
}

/** The decision a row produces, with the lexicon version and matches attached. */
function decide(
  row: ReviewRoutingRow,
  lexiconVersion: string,
  matches: readonly ReviewEscalationMatch[],
): ReviewRoutingDecision {
  return {
    verdict: row.verdict,
    rule: row.rule,
    documentedRow: row.documentedRow,
    lexiconVersion,
    matches,
    categories: matchedEscalationCategories(matches),
    why: row.why,
  }
}

/**
 * Route one review.
 *
 * `review`, `policy` and `table` are all accepted as possibly-absent, and each absence has its own named
 * escalation rather than a thrown error. A throw here would be caught by whichever caller is least able
 * to decide what to do about it — and inside `withGoogle` it would be classified through the Google
 * error taxonomy and could write a `health_check_failed` row for something Google never did (G-CONN-05).
 * Routing is a judgement, so it returns a judgement; the I/O stays outside.
 */
export function routeReview(args: {
  readonly review: RoutableReview | null | undefined
  readonly policy: ReviewRoutingPolicy | null | undefined
  /** Defaults to {@link REVIEW_ROUTING_TABLE}. An empty or absent table escalates. */
  readonly table?: readonly ReviewRoutingRow[] | null | undefined
}): ReviewRoutingDecision {
  const table = args.table === undefined ? REVIEW_ROUTING_TABLE : args.table
  // The version stamped on a refusal is this build's, because this build is what refused. It is never
  // the unreadable policy's: a version copied out of something that could not be read is a claim about
  // a lexicon nobody consulted.
  const fallbackVersion = REVIEW_ESCALATION_LEXICON_VERSION

  if (!Array.isArray(table) || table.length === 0) {
    return decide(ROWS.routing_table_unavailable, fallbackVersion, [])
  }
  if (!isUsablePolicy(args.policy)) {
    return decide(ROWS.routing_policy_unavailable, fallbackVersion, [])
  }
  if (!isRoutableReview(args.review)) {
    return decide(ROWS.unroutable_review, args.policy.lexicon.version, [])
  }

  const policy = normaliseReviewPolicy(args.policy)
  const matches = matchReviewEscalations(args.review.commentText, policy.lexicon)
  const context: ReviewRoutingContext = { review: args.review, policy, matches }
  const version = policy.lexicon.version

  for (const row of table) {
    // A row whose predicate is missing — a hand-built table, a row deserialised from somewhere — is
    // treated as matching, not as skipped. A row that cannot say whether it applies has not said it
    // does not, and its verdict is `escalate` in every row this build ships.
    const applies = row.matches === null ? true : row.matches(context)
    if (!applies) continue
    if (row.verdict !== 'auto_send') return decide(row, version, matches)
    // The only permissive row in the table, and it does not get the last word.
    return autoSendFloor(context)
      ? decide(row, version, matches)
      : decide(ROWS.auto_send_floor_violated, version, matches)
  }

  // No row matched. Unreachable with the shipped table, whose last row matches everything — and
  // therefore exactly the case a hand-built or truncated table produces. `escalate`.
  return decide(ROWS.routing_table_unavailable, version, matches)
}

/**
 * Re-take a decision from what was persisted with it.
 *
 * The lexicon is resolved from the **stored** version rather than from today's, which is the whole point:
 * a verdict taken before a term was added has to be explainable with the terms that were in force, and a
 * version this build cannot resolve produces `routing_policy_unavailable` instead of a confident sentence
 * about the wrong list.
 */
export function replayReviewRouting(args: {
  readonly review: RoutableReview | null | undefined
  readonly policy: Omit<ReviewRoutingPolicy, 'lexicon'> | null | undefined
  readonly storedLexiconVersion: unknown
  readonly lexiconFor: (version: unknown) => ReviewEscalationLexicon | null
}): ReviewRoutingDecision {
  const lexicon = args.lexiconFor(args.storedLexiconVersion)
  if (lexicon === null || args.policy === null || args.policy === undefined) {
    return decide(ROWS.routing_policy_unavailable, REVIEW_ESCALATION_LEXICON_VERSION, [])
  }
  return routeReview({ review: args.review, policy: { ...args.policy, lexicon } })
}
