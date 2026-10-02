import type { SeoSuggestionRow, SuggestionRegion } from '@berelax/db'

/**
 * The suggestions screen's vocabulary: the path, the field names, the actions and the view (G-SEO-05).
 *
 * Separated from the render and the handler because all three need the same strings, and a literal in
 * three files is three chances for one of them to be the typo that makes a field arrive empty.
 * `REVIEWS_PASTE_FIELDS` next door takes the same shape for the same reason.
 */

/** The route. One constant, so the form's `action` and the registry entry cannot disagree. */
export const SEO_SUGGESTIONS_PATH = '/agents/seo/suggestions'

/** The form fields. Two, and neither of them can choose a principal — see the handler. */
export const SEO_SUGGESTIONS_FIELDS = {
  /** Which suggestion. A uuid, read back from the row rather than trusted. */
  suggestion: 'suggestion',
  /** What to do with it: one of {@link SEO_SUGGESTION_ACTIONS}. */
  action: 'action',
} as const

/**
 * What a human may do to a suggestion from this screen.
 *
 * Three, and they are the three state moves 0133 permits from a state a human can see. There is
 * deliberately no `refuse`: a suggestion the LINT refused is already `refused` when it is written, and a
 * human who disagrees with a proposal leaves it alone — a manual refusal would put a human's judgement
 * into a column whose rule names say the lint decided, which is the one thing `refused_rules` must not
 * come to mean.
 */
export const SEO_SUGGESTION_ACTIONS = ['approve', 'apply', 'rollback'] as const
export type SeoSuggestionAction = (typeof SEO_SUGGESTION_ACTIONS)[number]

/** Why a submission was refused, by name. A closed set, so a refusal with no wording is a type error. */
export const SEO_SUGGESTIONS_REFUSALS = [
  'unreadable_request',
  'forbidden',
  'unknown_action',
  'unknown_suggestion',
  'transition_not_permitted',
  'before_state_is_not_live',
  'fails_the_lint',
  'no_restorable_record',
  'no_measurement_to_carry_forward',
  'write_refused',
] as const
export type SeoSuggestionsRefusal = (typeof SEO_SUGGESTIONS_REFUSALS)[number]

/** One suggestion as the screen shows it: the diff, the stamp, and what may be done to it. */
export interface SuggestionCardView {
  readonly id: string
  readonly surface: string
  readonly state: string
  readonly proposedAtIso: string
  readonly lintVersion: string
  readonly llmProvider: string
  readonly costFils: number
  readonly inputTokens: number
  readonly outputTokens: number
  /** The rule names that refused it. Empty unless the state is `refused`. */
  readonly refusedRules: readonly string[]
  /** Region by region, the copy now and the copy proposed. The diff a human judges. */
  readonly regions: readonly {
    readonly region: string
    readonly before: string
    readonly after: string
  }[]
  /** Which of {@link SEO_SUGGESTION_ACTIONS} this row's state and this role permit. */
  readonly actions: readonly SeoSuggestionAction[]
}

export interface SeoSuggestionsView {
  /** The instant the page was read at, printed, so two repeat runs produce identical screenshots. */
  readonly readAtIso: string
  /** The audit label this screen acts under: the employment record's handle, never a name (ADR 0020). */
  readonly actorLabel: string
  readonly cards: readonly SuggestionCardView[]
  /** The most recently refused suggestions, newest first. The security-relevant half of the queue. */
  readonly refusals: readonly SuggestionCardView[]
  /** The refusal of the submission just made, by name, or null. */
  readonly refusal: SeoSuggestionsRefusal | null
  /** A one-line detail for {@link refusal}, already safe to print. */
  readonly refusalDetail: string | null
  /** What the last successful submission did, for the line after a 303. */
  readonly done: SeoSuggestionAction | null
}

/** Pairs the before and after regions by name, in the order the before-state declares them. */
export function regionDiff(
  before: readonly SuggestionRegion[],
  after: readonly SuggestionRegion[],
): SuggestionCardView['regions'] {
  const afterByRegion = new Map(after.map((region) => [region.region, region.text]))
  const seen = new Set<string>()
  const rows: { region: string; before: string; after: string }[] = []
  for (const region of before) {
    seen.add(region.region)
    rows.push({
      region: region.region,
      before: region.text,
      after: afterByRegion.get(region.region) ?? '',
    })
  }
  // A region the draft ADDED has no before-state, and it has to be visible: a new meta description on a
  // page that had none is the commonest real suggestion, and a diff that only walked the before-state
  // would show it as nothing at all.
  for (const region of after) {
    if (seen.has(region.region)) continue
    rows.push({ region: region.region, before: '', after: region.text })
  }
  return rows
}

/** Which actions a row's state permits. The role check is the handler's; this is the state half. */
export function actionsFor(row: SeoSuggestionRow): readonly SeoSuggestionAction[] {
  switch (row.state) {
    case 'proposed':
      return ['approve']
    case 'approved':
      return ['apply']
    case 'applied':
      return ['rollback']
    default:
      return []
  }
}
