/**
 * The paste form's vocabulary: the path, the field names, the refusals and the view (G-REV-02).
 *
 * Separated from the render and the handler because all three need the same strings and a literal in three
 * files is three chances for one of them to be the typo that makes a field arrive empty. `QUICK_BOOK_FIELDS`
 * next door takes the same shape for the same reason.
 */

/** The route. One constant, so the form's `action` and the registry entry cannot disagree. */
export const REVIEWS_PASTE_PATH = '/reviews/paste'

/**
 * The form fields.
 *
 * Every one of them is something a person reads off the Google listing and types. There is deliberately no
 * field for the reply, the routing verdict or the delivery mode: the reply is drafted afterwards (G-REV-04),
 * the verdict is the routing table's (G-REV-03), and `delivery_mode` is `manual` by construction on this path
 * — a form field for it would be a way to file a pasted review as an API delivery.
 */
export const REVIEWS_PASTE_FIELDS = {
  /** Which listing. A select when there is more than one connection, a hidden input when there is one. */
  connection: 'connection',
  placeId: 'placeId',
  rating: 'rating',
  reviewer: 'reviewer',
  /** `YYYY-MM-DD`, the date Google shows against the review. See the handler on why it is required. */
  reviewedOn: 'reviewedOn',
  comment: 'comment',
  /** The `needs_paste` intake item this paste closes, when the form was opened from one. */
  intake: 'intake',
} as const

/** Why a submission was refused, by name. A closed set, so a refusal with no wording is a type error. */
export const REVIEWS_PASTE_REFUSALS = [
  'unreadable_request',
  'unauthenticated',
  'forbidden',
  'unknown_listing',
  'rating_not_offered',
  'reviewer_missing',
  'reviewed_on_missing',
  'reviewed_on_not_a_date',
  'reviewed_on_in_the_future',
  'intake_already_resolved',
  'write_refused',
] as const
export type ReviewsPasteRefusal = (typeof REVIEWS_PASTE_REFUSALS)[number]

/** One listing the form can file a review against. */
export interface PasteListingOption {
  readonly connectionId: string
  readonly placeId: string
  readonly googleEmail: string
}

/** One forwarded email waiting for somebody, as the queue shows it. */
export interface PasteQueueItem {
  readonly id: string
  readonly refusal: string
  /** The reason in words, from `packages/core`'s table. A bare code is not a thing to act on. */
  readonly refusalSentence: string
  readonly receivedAtIso: string
  readonly rawBodyBytes: number
  /** The forwarded body, shown verbatim so somebody can read what no machine could. */
  readonly rawBody: string
}

/** What the form echoes back, so a refusal never throws away what somebody typed. */
export interface PasteForm {
  readonly connection: string
  readonly placeId: string
  readonly rating: string
  readonly reviewer: string
  readonly reviewedOn: string
  readonly comment: string
  readonly intake: string
}

export interface ReviewsPasteView {
  readonly chrome: unknown
  readonly readAtIso: string
  readonly listings: readonly PasteListingOption[]
  readonly queue: readonly PasteQueueItem[]
  readonly form: PasteForm
  /** The refusal to show, or `null`. */
  readonly refusal: { readonly name: ReviewsPasteRefusal; readonly sentence: string } | null
  /** The review just created, so the page after the redirect says what happened. */
  readonly created: {
    readonly reviewId: string
    readonly rating: number
    readonly starOnly: boolean
    readonly intakeResolved: boolean
  } | null
  /** The signed-in operator, as the audit row records them. `null` on the unauthenticated page. */
  readonly actorLabel: string | null
}

/** The ratings the form offers. 1-5, and the database CHECK is the same set. */
export const PASTE_RATINGS: readonly number[] = Object.freeze([1, 2, 3, 4, 5])
